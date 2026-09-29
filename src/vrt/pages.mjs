import { runPhp, listShortcodes } from './playground.mjs'

// ブロックの境目に置く印。表側で、印から次の印までに何か表示されたかを数える
const PROBE_MARK = 'vrt-block-probe'

// 編集画面の中で動かす（page.evaluate に文字列で渡すので、外の変数を参照しない）。
// example（編集画面のプレビュー用の見本）があればそれで作る。表のブロックのように、
// 既定の attributes だと何も出力しないブロックが多いため。example は block.json ではなく
// JS の registerBlockType() に書かれていることもあるが、getBlockTypes() ならどちらも読める
async function buildBlocksPage(mark) {
  const api = window.wp.blocks
  const blocks = []
  let fromExample = 0
  for (const type of api.getBlockTypes()) {
    if (type.name.startsWith('core/')) continue
    let block = null
    if (type.example) {
      try {
        block = api.getBlockFromExample
          ? api.getBlockFromExample(type.name, type.example)
          : api.createBlock(type.name, type.example.attributes ?? {},
            api.createBlocksFromInnerBlocksTemplate(type.example.innerBlocks ?? []))
        fromExample++
      } catch {
        block = null
      }
    }
    if (!block) {
      try {
        block = api.createBlock(type.name)
      } catch {
        // 既定の attributes でも作れないブロックは飛ばす
        continue
      }
    }
    blocks.push(block)
  }
  if (blocks.length === 0) return { made: 0, fromExample: 0, id: null }
  // 印は HTML のコメントとしてブロックの外に置く（ブロックが1つでもあれば wpautop は効かないので残る）
  const content = blocks.map((b) => `<!--${mark}-->\n${api.serialize([b])}`).join('\n')
  const res = await window.wp.apiFetch({
    path: '/wp/v2/pages',
    method: 'POST',
    data: { title: 'VRT blocks', content, status: 'publish' },
  })
  return { made: blocks.length, fromExample, id: res.id }
}

// 表側の blocks ページの中で動かす。印ごとに、次の印までに大きさのある要素か文字があるかを見る
function countVisibleBlocks(mark) {
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
  let visible = 0
  for (const m of marks) {
    for (let n = m.nextSibling; n && !markSet.has(n); n = n.nextSibling) {
      if (isVisible(n)) {
        visible++
        break
      }
    }
  }
  return visible
}

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

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  let made = { made: 0, fromExample: 0, id: null }
  let visible = 0
  try {
    await page.goto(`${site.cli.serverUrl}/wp-admin/post-new.php?post_type=page`, { waitUntil: 'load', timeout: 60_000 })
    await page.waitForFunction(() => window.wp?.blocks?.getBlockTypes?.().length > 0, null, { timeout: 60_000 })
    made = await page.evaluate(`(${buildBlocksPage})(${JSON.stringify(PROBE_MARK)})`)
    if (made.made > 0) {
      await page.goto(`${site.cli.serverUrl}/?page_id=${made.id}`, { waitUntil: 'load', timeout: 60_000 })
      visible = await page.evaluate(`(${countVisibleBlocks})(${JSON.stringify(PROBE_MARK)})`)
    }
  } finally {
    await context.close()
  }
  if (made.made > 0) pages.push({ name: 'blocks', path: `/?page_id=${made.id}` })

  // 作れても表側に何も出なかったブロックは、表示部分に数えない（何も写っていない画像で「変化なし」と言わないため）
  return {
    pages,
    hasSurface: tags.length > 0 || visible > 0,
    probe: { made: made.made, from_example: made.fromExample, visible },
  }
}
