import { runPhp, listShortcodes } from './playground.mjs'
import { blockExternal, WIDTHS } from './capture.mjs'
import { atStage, VrtError } from './errors.mjs'

// ブロックの境目に置く印。表側で、印から次の印までに何か表示されたかを数える
const PROBE_MARK = 'vrt-block-probe'

// 編集画面の中で動かす（page.evaluate に文字列で渡すので、外の変数を参照しない）。
// example（編集画面のプレビュー用の見本）があればそれで作る。表のブロックのように、
// 既定の attributes だと何も出力しないブロックが多いため。example は block.json ではなく
// JS の registerBlockType() に書かれていることもあるが、getBlockTypes() ならどちらも読める。
// ここでは中身を作るだけで、保存は PHP で行う（savePage）
function buildBlocksPage(mark) {
  const api = window.wp.blocks
  // 作る・serialize するのを1つずつ試す（1つの失敗でページ全体を落とさない）。
  // いまの WordPress は save() の例外を serialize の中で握るが、それに頼らない
  const tryHtml = (make) => {
    try {
      return api.serialize([make()])
    } catch {
      return null
    }
  }
  const parts = []
  let fromExample = 0
  for (const type of api.getBlockTypes()) {
    if (type.name.startsWith('core/')) continue
    let html = null
    if (type.example) {
      html = tryHtml(() => (api.getBlockFromExample
        ? api.getBlockFromExample(type.name, type.example)
        : api.createBlock(type.name, type.example.attributes ?? {},
          api.createBlocksFromInnerBlocksTemplate(type.example.innerBlocks ?? []))))
      if (html !== null) fromExample++
    }
    // 既定の attributes でも作れないブロックは飛ばす
    html ??= tryHtml(() => api.createBlock(type.name))
    if (html !== null) parts.push(html)
  }
  if (parts.length === 0) return { made: 0, fromExample: 0, content: null }
  // 印は HTML のコメントとしてブロックの外に置く（ブロックが1つでもあれば wpautop は効かないので残る）
  const content = parts.map((html) => `<!--${mark}-->\n${html}`).join('\n')
  return { made: parts.length, fromExample, content }
}

// 固定ページとして公開し、ID を返す。REST API ではなく PHP で保存する
// （REST を制限するセキュリティ系のプラグインなどで、保存できない組があったため。2026-10-01）。
// 中身は PHP の文字列に埋め込まず、ファイル経由で渡す（$ などの展開を避ける）。
// 管理者として保存して kses で中身が削られないようにし、wp_insert_post が外すバックスラッシュを
// wp_slash で守る（ブロックの属性の JSON には \u003c のようなエスケープが入る）
// kind（blocks / shortcodes）は、保存できなかったときのエラーコードに使う
async function savePage(site, kind, title, content) {
  await site.cli.playground.writeFile('/tmp/vrt-page.html', content)
  const id = await runPhp(site, `
wp_set_current_user(1);
$id = wp_insert_post(['post_type' => 'page', 'post_status' => 'publish', 'post_title' => ${JSON.stringify(title)},
  'post_content' => wp_slash(file_get_contents('/tmp/vrt-page.html'))], true);
vrt_out(is_wp_error($id) ? 0 : $id);`)
  if (!id) throw new VrtError(`${kind}_save_failed`)
  return id
}

// 表側の blocks ページの中で動かす。印ごとに、次の印までに大きさのある要素か文字があるかを見る。
// 印の順に真偽値の配列を返す（幅ごとに見て、どれかの幅で見えたブロックを数えるため）
function visibleBlocks(mark) {
  const marks = []
  const it = document.createNodeIterator(document.body, NodeFilter.SHOW_COMMENT)
  for (let n = it.nextNode(); n; n = it.nextNode()) if (n.data.trim() === mark) marks.push(n)
  const hasBox = (r) => r.width > 0 && r.height > 0
  const isVisible = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.data.trim()) return false
      const range = document.createRange()
      range.selectNodeContents(node)
      return hasBox(range.getBoundingClientRect())
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return false
    return [node, ...node.querySelectorAll('*')].some((el) => hasBox(el.getBoundingClientRect()))
  }
  const markSet = new Set(marks)
  return marks.map((m) => {
    for (let n = m.nextSibling; n && !markSet.has(n); n = n.nextSibling) {
      if (isVisible(n)) return true
    }
    return false
  })
}

const EDITOR_PATH = '/wp-admin/post-new.php'
// 有効化の直後に管理画面を開くと、初期設定の画面へ転送するプラグインがある（たいてい最初の1回だけ）。
// 編集画面に着かなければ、この回数まで開き直す
const EDITOR_TRIES = 3

// 編集画面を開き、ブロックの一覧が読めるまで待つ
async function openEditor(page, serverUrl) {
  const onEditor = () => new URL(page.url()).pathname === EDITOR_PATH
  for (let i = 0; i < EDITOR_TRIES; i++) {
    await page.goto(`${serverUrl}${EDITOR_PATH}?post_type=page`, { waitUntil: 'load', timeout: 60_000 })
    // サーバー側で転送されたら、待たずに開き直す
    if (!onEditor()) continue
    try {
      await page.waitForFunction(() => window.wp?.blocks?.getBlockTypes?.().length > 0, null, { timeout: 60_000 })
      return
    } catch (err) {
      // 編集画面にいるのに読めないなら、開き直しても同じなので諦める。JS で転送されていたら開き直す
      if (onEditor()) throw err
    }
  }
  throw new VrtError('editor_redirected')
}

// 編集画面を開いてテストページを作る。
// 読み込みのあとで JS が別の画面へ転送するプラグインがあり、作っている途中で画面が替わると
// page.evaluate が「実行中のコンテキストが消えた」で失敗する。そのときは編集画面から開き直す
const NAVIGATED_RE = /Execution context was destroyed|because of a navigation/i

async function buildOnEditor(page, serverUrl) {
  for (let i = 0; i < EDITOR_TRIES; i++) {
    await atStage('editor', () => openEditor(page, serverUrl))
    let made
    try {
      made = await page.evaluate(`(${buildBlocksPage})(${JSON.stringify(PROBE_MARK)})`)
    } catch (err) {
      // 例外のメッセージは種類の判定にだけ使い、ログには出さない
      if (!NAVIGATED_RE.test(String(err?.message))) throw new VrtError(err?.name === 'TimeoutError' ? 'browser_timeout_blocks' : 'unknown_blocks', { cause: err })
      continue
    }
    return made
  }
  throw new VrtError('blocks_navigated')
}

// テストページは旧版で作り、新版でもそのまま表示する。
// 実サイトでも既存の記事は古い保存形式のまま残り、新しい CSS とレンダリングだけが効くため（spec §4.6）
export async function createTestPages(site, browser, { coreTags }) {
  const pages = [{ name: 'home', path: '/' }, { name: 'post', path: '/?p=1' }]

  const tags = await atStage('shortcodes', async () => {
    const found = (await listShortcodes(site)).filter((t) => !coreTags.includes(t))
    if (found.length > 0) {
      const id = await savePage(site, 'shortcodes', 'VRT shortcodes', found.map((t) => `[${t}]`).join('\n\n'))
      pages.push({ name: 'shortcodes', path: `/?page_id=${id}` })
    }
    return found
  })

  const context = await browser.newContext()
  await blockExternal(context)
  const page = await context.newPage()
  let made = { made: 0, fromExample: 0, content: null }
  let blocksId = null
  let visible = 0
  try {
    // 失敗したとき、どの段で止まったかをログに残す（src/vrt/errors.mjs）
    made = await buildOnEditor(page, site.cli.serverUrl)
    if (made.made > 0) blocksId = await atStage('blocks', () => savePage(site, 'blocks', 'VRT blocks', made.content))
    if (made.made > 0) {
      // 撮るのと同じ幅ごとに見る（狭い幅でだけ出るブロックもある）
      const seen = []
      await atStage('probe', async () => {
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 800 })
          await page.goto(`${site.cli.serverUrl}/?page_id=${blocksId}`, { waitUntil: 'load', timeout: 60_000 })
          const flags = await page.evaluate(`(${visibleBlocks})(${JSON.stringify(PROBE_MARK)})`)
          flags.forEach((v, i) => { seen[i] ||= v })
        }
      })
      visible = seen.filter(Boolean).length
    }
  } finally {
    await context.close()
  }
  if (made.made > 0) pages.push({ name: 'blocks', path: `/?page_id=${blocksId}` })

  // 作れても表側に何も出なかったブロックは、表示部分に数えない（何も写っていない画像で「変化なし」と言わないため）
  return {
    pages,
    hasSurface: tags.length > 0 || visible > 0,
    probe: { made: made.made, from_example: made.fromExample, visible },
  }
}
