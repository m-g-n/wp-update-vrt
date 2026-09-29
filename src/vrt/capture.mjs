export const WIDTHS = [1280, 375]
const MAX_HEIGHT = 10_000
const FREEZE_CSS = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'

const MAX_LINE = 300
const MAX_LINES = 50
// debug.log の行頭の `[28-Sep-2026 10:05:12 UTC] `。旧版と新版で時刻だけ違う同じ行を同じものとみなすために外す
const PHP_STAMP_RE = /^\[[^\]]*\]\s*/
// こちらが外部への通信を止めたことで出るコンソールのエラー。プラグインの不具合ではない
const ABORTED_RE = /net::ERR_(FAILED|ABORTED)/

const normalizePhp = (l) => l.replace(PHP_STAMP_RE, '').slice(0, MAX_LINE)
const normalizeJs = (l) => l.slice(0, MAX_LINE)

function added(before, after, normalize, ignore = () => false) {
  const seen = new Set(before.map(normalize))
  const out = new Set()
  for (const l of after.map(normalize)) {
    if (!ignore(l) && !seen.has(l)) out.add(l)
  }
  return [...out].slice(0, MAX_LINES)
}

// 新版で「増えた」エラーだけを返す。旧版のときから出ていたものは更新のせいではない
export function newErrors(before, after) {
  return {
    php: added(before.php, after.php, normalizePhp),
    js: added(before.js, after.js, normalizeJs, (l) => ABORTED_RE.test(l)),
  }
}

const isLocal = (url) => {
  const { hostname } = new URL(url)
  return hostname === '127.0.0.1' || hostname === 'localhost'
}

// ブラウザ側でも外部への通信を止める（CDN のフォントや広告で揺れないように）。
// テストページを作るコンテキスト（src/vrt/pages.mjs）も同じものを使う
export async function blockExternal(context) {
  await context.route('**/*', (route) => (isLocal(route.request().url()) ? route.continue() : route.abort()))
}

export async function openCapturer(browser, serverUrl) {
  const context = await browser.newContext()
  await blockExternal(context)
  const page = await context.newPage()
  const jsErrors = []
  page.on('pageerror', (e) => jsErrors.push(String(e.message).slice(0, MAX_LINE)))
  page.on('console', (m) => {
    if (m.type() === 'error') jsErrors.push(m.text().slice(0, MAX_LINE))
  })
  return {
    jsErrors,
    async shot(path, width) {
      await page.setViewportSize({ width, height: 800 })
      await page.goto(serverUrl + path, { waitUntil: 'networkidle', timeout: 60_000 })
      await page.addStyleTag({ content: FREEZE_CSS })
      await page.evaluate(() => document.fonts.ready)
      const height = await page.evaluate(() => document.documentElement.scrollHeight)
      // 無限スクロールなどで極端に長いページは上から MAX_HEIGHT までにする
      if (height > MAX_HEIGHT) return page.screenshot({ fullPage: true, clip: { x: 0, y: 0, width, height: MAX_HEIGHT } })
      return page.screenshot({ fullPage: true })
    },
    close: () => context.close(),
  }
}
