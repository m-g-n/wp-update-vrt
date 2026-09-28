import { bootSite, installPlugin, listShortcodes, debugLogLength, debugLogLines } from './playground.mjs'
import { createTestPages } from './pages.mjs'
import { openCapturer, newErrors, WIDTHS } from './capture.mjs'
import { comparePngs, judge } from './compare.mjs'

const round6 = (x) => Math.round(x * 1e6) / 1e6

// 1つのインスタンスの中で旧版から新版に上げて比べる（spec §4.6）
// signal が来たら（vrt 段の時間切れ）その場で Playground とブラウザのコンテキストを破棄する。
// 止まっている処理の終わりを待たないので、サーバーが残らない
export async function runVrt({ oldZip, newZip }, { browser, port, signal }) {
  const site = await bootSite({ port })
  let disposed = null
  const dispose = () => (disposed ??= site.cli[Symbol.asyncDispose]())
  let cap = null
  const onAbort = () => {
    cap?.close().catch(() => {})
    dispose().catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    // 起動を待つ間に時間切れになっていたら、ここで止める
    signal?.throwIfAborted()
    const coreTags = await listShortcodes(site)
    await installPlugin(site, oldZip)
    const { pages, hasSurface } = await createTestPages(site, browser, { coreTags })
    cap = await openCapturer(browser, site.cli.serverUrl)
    try {
      signal?.throwIfAborted()
      const before = new Map()
      const noise = []
      for (const p of pages) {
        for (const w of WIDTHS) {
          const first = await cap.shot(p.path, w)
          const second = await cap.shot(p.path, w)
          noise.push(comparePngs(first, second).ratio)
          before.set(`${p.name}-${w}`, first)
        }
      }
      // 旧版の間に出ていたエラー（起動・旧版の導入・撮影）。新版で増えたものだけを出すための基準
      const logOffset = await debugLogLength(site)
      const jsOffset = cap.jsErrors.length
      const beforeErrors = { php: await debugLogLines(site, 0, logOffset), js: cap.jsErrors.slice(0, jsOffset) }

      await installPlugin(site, newZip)

      const results = []
      for (const p of pages) {
        for (const w of WIDTHS) {
          const oldPng = before.get(`${p.name}-${w}`)
          const newPng = await cap.shot(p.path, w)
          const { ratio, diffPng } = comparePngs(oldPng, newPng)
          results.push({ page: p.name, width: w, diff_ratio: round6(ratio), images: { old: oldPng, new: newPng, diff: diffPng } })
        }
      }
      const noiseFloor = round6(Math.max(0, ...noise))
      const verdict = judge({ noiseFloor, pages: results, hasSurface })
      return {
        status: verdict.status,
        reason: null,
        env: site.env,
        noise_floor: noiseFloor,
        pages: results,
        errors_new: newErrors(beforeErrors, { php: await debugLogLines(site, logOffset), js: cap.jsErrors.slice(jsOffset) }),
        vrt_changed: verdict.vrt_changed,
      }
    } finally {
      await cap.close()
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    await dispose()
  }
}
