import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { chromium } from 'playwright'

import { runVrt } from '../src/vrt/run.mjs'
import { makeZip } from '../test/helpers/tree.mjs'

// 色だけ変えたショートコードを出す架空のプラグイン。有効化時に出力する癖も入れておく（Review Focus 1）
const plugin = (version, color) => makeZip('vrt-fixture', {
  'vrt-fixture.php': `<?php
/**
 * Plugin Name: VRT Fixture
 * Version: ${version}
 */
register_activation_hook(__FILE__, function () { echo 'activated!'; });
add_shortcode('vrt_box', fn() => '<div class="vrt-box" style="width:200px;height:100px;background:${color}"></div>');
`,
})

// ブロックだけを持つ架空のプラグイン。どちらのブロックも、属性が空なら何も出力しない（コアの表ブロックと同じ作り）。
// example を持つのは card / narrow（375px でだけ見える）/ broken（example の値で save() が例外を投げる）。
// 色は表側の CSS で変える（保存済みの HTML は旧版のまま残るため）
const blockPlugin = (version, color, { withExample = true } = {}) => makeZip('vrt-blocks', {
  'vrt-blocks.php': `<?php
/**
 * Plugin Name: VRT Blocks
 * Version: ${version}
 */
add_action('enqueue_block_editor_assets', function () {
  wp_enqueue_script('vrt-blocks', plugins_url('editor.js', __FILE__), ['wp-blocks', 'wp-element'], '${version}');
});
add_action('wp_enqueue_scripts', function () {
  wp_register_style('vrt-blocks', false);
  wp_enqueue_style('vrt-blocks');
  wp_add_inline_style('vrt-blocks', '.vrt-card{width:200px;height:100px;background:${color}}'
    . '.vrt-narrow{display:none}@media (max-width:600px){.vrt-narrow{display:block;width:100px;height:50px;background:${color}}}');
});
`,
  'editor.js': `
const el = wp.element.createElement;
const save = ({ attributes }) => attributes.text ? el('div', { className: 'vrt-card' }, attributes.text) : null;
const attributes = { text: { type: 'string', default: '' } };
${withExample ? `wp.blocks.registerBlockType('vrt-blocks/card', {
  title: 'Card', category: 'widgets', attributes, edit: () => null, save,
  example: { attributes: { text: 'card' } },
});` : ''}
wp.blocks.registerBlockType('vrt-blocks/empty', { title: 'Empty', category: 'widgets', attributes, edit: () => null, save });
${withExample ? `wp.blocks.registerBlockType('vrt-blocks/narrow', {
  title: 'Narrow', category: 'widgets', attributes, edit: () => null,
  save: ({ attributes }) => attributes.text ? el('div', { className: 'vrt-narrow' }, attributes.text) : null,
  example: { attributes: { text: 'narrow' } },
});
wp.blocks.registerBlockType('vrt-blocks/broken', {
  title: 'Broken', category: 'widgets', attributes, edit: () => null,
  save: ({ attributes }) => { if (attributes.text) throw new Error('broken'); return null },
  example: { attributes: { text: 'broken' } },
});` : ''}
`,
})

describe('runVrt（Playground＋Chromium）', () => {
  let browser
  before(async () => {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined })
  })
  after(async () => {
    await browser?.close()
  })

  it('色を変えた更新は vrt_changed = true', async () => {
    const r = await runVrt({ oldZip: plugin('1.0.0', 'red'), newZip: plugin('1.1.0', 'blue') }, { browser, port: 9481 })
    assert.equal(r.status, 'done')
    assert.equal(r.vrt_changed, true)
    const sc = r.pages.find((p) => p.page === 'shortcodes' && p.width === 1280)
    assert.ok(sc.diff_ratio > 0.001)
    assert.equal(r.env.theme, 'twentytwentyfive')
  })

  it('中身が同じ更新は vrt_changed = false', async () => {
    const r = await runVrt({ oldZip: plugin('1.0.0', 'red'), newZip: plugin('1.0.1', 'red') }, { browser, port: 9482 })
    assert.equal(r.status, 'done')
    assert.equal(r.vrt_changed, false)
  })

  it('ブロックは example の属性で作るので、既定値では何も出さないブロックも比べられる', async () => {
    const r = await runVrt({ oldZip: blockPlugin('1.0.0', 'red'), newZip: blockPlugin('1.1.0', 'blue') }, { browser, port: 9483 })
    // broken の save() が例外を投げても、ページは作れて他のブロックも並ぶ（表側には何も出ない）。
    // narrow は 375px でだけ見えるので、見えた数に入る
    assert.deepEqual(r.probe, { made: 4, from_example: 3, visible: 2 })
    assert.equal(r.status, 'done')
    assert.equal(r.vrt_changed, true)
    const blocks = r.pages.find((p) => p.page === 'blocks' && p.width === 1280)
    assert.ok(blocks.diff_ratio > 0.001)
  })

  it('表側に何も出なかったブロックしか無ければ no_surface（「変化なし」と言い切らない）', async () => {
    const opts = { withExample: false }
    const r = await runVrt({ oldZip: blockPlugin('1.0.0', 'red', opts), newZip: blockPlugin('1.1.0', 'blue', opts) }, { browser, port: 9484 })
    assert.deepEqual(r.probe, { made: 1, from_example: 0, visible: 0 })
    assert.equal(r.status, 'no_surface')
  })
})
