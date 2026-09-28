import { runPhp, listShortcodes } from './playground.mjs'

// テストページは旧版で作り、新版でもそのまま表示する。
// 実サイトでも既存の記事は古い保存形式のまま残り、新しい CSS とレンダリングだけが効くため（spec §4.6）
export async function createTestPages(site, browser, { coreTags }) {
  const pages = [{ name: 'home', path: '/' }, { name: 'post', path: '/?p=1' }]

  const tags = (await listShortcodes(site)).filter((t) => !coreTags.includes(t))
  if (tags.length > 0) {
    // 中身は PHP の文字列に埋め込まず、ファイル経由で渡す（$ などの展開を避ける）
    await site.cli.playground.writeFile('/tmp/vrt-shortcodes.txt', tags.map((t) => `[${t}]`).join('\n\n'))
    const id = await runPhp(site, `
vrt_out(wp_insert_post(['post_type' => 'page', 'post_status' => 'publish', 'post_title' => 'VRT shortcodes',
  'post_content' => file_get_contents('/tmp/vrt-shortcodes.txt')]));`)
    pages.push({ name: 'shortcodes', path: `/?page_id=${id}` })
  }

  const context = await browser.newContext()
  const page = await context.newPage()
  let made = { count: 0, id: null }
  try {
    await page.goto(`${site.cli.serverUrl}/wp-admin/post-new.php?post_type=page`, { waitUntil: 'load', timeout: 60_000 })
    await page.waitForFunction(() => window.wp?.blocks?.getBlockTypes?.().length > 0, null, { timeout: 60_000 })
    made = await page.evaluate(async () => {
      const blocks = []
      for (const type of window.wp.blocks.getBlockTypes()) {
        if (type.name.startsWith('core/')) continue
        try {
          blocks.push(window.wp.blocks.createBlock(type.name))
        } catch {
          // 既定の attributes で作れないブロックは飛ばす
        }
      }
      if (blocks.length === 0) return { count: 0, id: null }
      const res = await window.wp.apiFetch({
        path: '/wp/v2/pages',
        method: 'POST',
        data: { title: 'VRT blocks', content: window.wp.blocks.serialize(blocks), status: 'publish' },
      })
      return { count: blocks.length, id: res.id }
    })
  } finally {
    await context.close()
  }
  if (made.count > 0) pages.push({ name: 'blocks', path: `/?page_id=${made.id}` })

  return { pages, hasSurface: tags.length > 0 || made.count > 0 }
}
