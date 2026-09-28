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
})
