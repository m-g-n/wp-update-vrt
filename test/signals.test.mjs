import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { fileKind, isAdminPath } from '../src/signals/classify.mjs'
import { computeSignals } from '../src/signals/index.mjs'
import { tree } from './helpers/tree.mjs'

const V = { from: '1.0.0', to: '1.0.1' }
const header = (v) => `<?php\n/**\n * Plugin Name: Acme\n * Version: ${v}\n */\nwp_enqueue_style('acme', 'a.css', [], '${v}');\n`

describe('fileKind / isAdminPath', () => {
  it('種別を分ける', () => {
    assert.equal(fileKind('readme.txt'), 'ignored')
    assert.equal(fileKind('languages/acme-ja.po'), 'ignored')
    assert.equal(fileKind('inc/render.php'), 'php')
    assert.equal(fileKind('build/index.js'), 'js')
    assert.equal(fileKind('src/edit.jsx'), 'js')
    assert.equal(fileKind('assets/a.css'), 'css')
    assert.equal(fileKind('assets/logo.svg'), 'asset')
    assert.equal(fileKind('blocks/card/block.json'), 'block_json')
    assert.equal(fileKind('src/style.scss'), 'other')
  })
  it('admin 用の JS をパスで見分ける', () => {
    assert.equal(isAdminPath('admin/js/settings.js'), true)
    assert.equal(isAdminPath('assets/js/admin.js'), true)
    assert.equal(isAdminPath('assets/js/acme-admin.min.js'), true)
    assert.equal(isAdminPath('assets/js/frontend.js'), false)
    assert.equal(isAdminPath('js/badminton.js'), false)
  })
})

describe('computeSignals', () => {
  it('バージョン番号と readme だけの変更は version_only', () => {
    const { signals } = computeSignals(
      tree({ 'acme.php': header('1.0.0'), 'readme.txt': 'Stable tag: 1.0.0' }),
      tree({ 'acme.php': header('1.0.1'), 'readme.txt': 'Stable tag: 1.0.1\n= 1.0.1 =\n* fix' }),
      V,
    )
    assert.equal(signals.version_only, true)
    assert.equal(signals.files_changed, 0)
  })
  it('バージョン文字列の置き換えは版の区切りでだけ行う（11.0 や 1.05 の中は置き換えない）', () => {
    const W = { from: '1.0', to: '1.1' }
    const inside = computeSignals(
      tree({ 'acme.php': "<?php\necho '<p>11.0</p>';\n" }),
      tree({ 'acme.php': "<?php\necho '<p>11.1</p>';\n" }),
      W,
    )
    assert.equal(inside.signals.version_only, false)
    assert.equal(inside.signals.php_output_hunks, 1)
    const css = computeSignals(tree({ 'a.css': '.a{opacity:1.05}' }), tree({ 'a.css': '.a{opacity:1.15}' }), W)
    assert.equal(css.signals.version_only, false)
    assert.equal(css.signals.css_decl_changes, 2)
    // 区切りにある版の番号は今までどおり置き換える
    const ver = computeSignals(
      tree({ 'acme.php': "<?php\nwp_enqueue_style('acme', 'a.css', [], '1.0');\n// Version: 1.0\n$u = 'x.css?ver=1.0';\n" }),
      tree({ 'acme.php': "<?php\nwp_enqueue_style('acme', 'a.css', [], '1.1');\n// Version: 1.1\n$u = 'x.css?ver=1.1';\n" }),
      W,
    )
    assert.equal(ver.signals.version_only, true)
  })
  it('コメントだけの変更も version_only', () => {
    const { signals } = computeSignals(
      tree({ 'acme.php': "<?php\n// old note\necho 'a';\n" }),
      tree({ 'acme.php': "<?php\n// new note, much longer\necho 'a';\n" }),
      V,
    )
    assert.equal(signals.version_only, true)
  })
  it('CSS の宣言の変更を数える', () => {
    const { signals } = computeSignals(
      tree({ 'a.css': '.a { color: red } .b { margin: 0 }' }),
      tree({ 'a.css': '.a { color: blue } .b { margin: 0 }' }),
      V,
    )
    assert.equal(signals.version_only, false)
    assert.equal(signals.css_decl_changes, 2)
  })
  it('消えたクラス名・ID を出す（別ファイルへ移っただけなら出さない）', () => {
    const { signals } = computeSignals(
      tree({ 'a.css': '.btn { color: red } #hero { margin: 0 } .moved { top: 0 }' }),
      tree({ 'a.css': '#hero { margin: 0 }', 'b.css': '.moved { top: 0 }' }),
      V,
    )
    assert.deepEqual(signals.selectors_removed, ['.btn'])
  })
  it('HTML を出力する PHP の塊だけを Jev 行きにし、コメントは含めない', () => {
    const { signals, hunks } = computeSignals(
      tree({ 'r.php': "<?php\nfunction r() {\n  $x = 1;\n  echo '<a class=\"btn\">';\n}\n" }),
      tree({ 'r.php': "<?php\nfunction r() {\n  $x = 2;\n  // No visual changes in this release\n  echo '<a class=\"btn-new\">';\n}\n" }),
      V,
    )
    assert.equal(signals.php_output_hunks, 1)
    assert.equal(hunks.php.length, 1)
    assert.match(hunks.php[0].text, /btn-new/)
    assert.ok(!hunks.php[0].text.includes('No visual changes'))
  })
  it('出力に関係しない PHP の変更は Jev に送らない', () => {
    const { signals, hunks } = computeSignals(
      tree({ 'l.php': "<?php\n$limit = 10;\n" }),
      tree({ 'l.php': "<?php\n$limit = 20;\n" }),
      V,
    )
    assert.equal(signals.php_output_hunks, 0)
    assert.equal(hunks.php.length, 0)
    assert.equal(signals.version_only, false)
  })
  it('admin 用の JS は数えるが Jev には送らない', () => {
    const { signals, hunks } = computeSignals(
      tree({ 'admin/js/s.js': 'a()', 'js/front.js': 'b()' }),
      tree({ 'admin/js/s.js': 'a(1)', 'js/front.js': 'b(1)' }),
      V,
    )
    assert.deepEqual(signals.js_changed, { front: 1, admin: 1 })
    assert.deepEqual(hunks.js.map((h) => h.path), ['js/front.js'])
  })
  it('.min.js は元のファイルがあれば Jev に送らない', () => {
    const { hunks } = computeSignals(
      tree({ 'js/a.js': 'a()', 'js/a.min.js': 'a()' }),
      tree({ 'js/a.js': 'a(1)', 'js/a.min.js': 'a(1)' }),
      V,
    )
    assert.deepEqual(hunks.js.map((h) => h.path), ['js/a.js'])
  })
  it('block.json の attributes の変更はブロック登録の差として出し、version だけなら出さない', () => {
    const oldJ = JSON.stringify({ name: 'acme/card', version: '1.0.0', attributes: { a: { type: 'string' } } })
    const verJ = JSON.stringify({ name: 'acme/card', version: '1.0.1', attributes: { a: { type: 'string' } } })
    const attrJ = JSON.stringify({ name: 'acme/card', version: '1.0.1', attributes: { a: { type: 'number' } } })
    assert.deepEqual(computeSignals(tree({ 'block.json': oldJ }), tree({ 'block.json': verJ }), V).signals.registrations_diff.blocks_changed, [])
    assert.deepEqual(computeSignals(tree({ 'block.json': oldJ }), tree({ 'block.json': attrJ }), V).signals.registrations_diff.blocks_changed, ['acme/card'])
  })
  it('ショートコードの増減を出す', () => {
    const { signals } = computeSignals(
      tree({ 'a.php': "<?php\nadd_shortcode('old_box', 'f');\n" }),
      tree({ 'a.php': "<?php\nadd_shortcode( \"new_box\", 'f' );\n" }),
      V,
    )
    assert.deepEqual(signals.registrations_diff.shortcodes_added, ['new_box'])
    assert.deepEqual(signals.registrations_diff.shortcodes_removed, ['old_box'])
  })
  it('コメントを取り除けないファイルは unsanitized_files に数える', () => {
    const { signals, hunks } = computeSignals(
      tree({ 'js/a.js': 'a()' }),
      tree({ 'js/a.js': "const s = 'unterminated" }),
      V,
    )
    assert.equal(signals.unsanitized_files, 1)
    assert.equal(hunks.js.length, 0)
  })
  it('画像の変更を数える', () => {
    const { signals } = computeSignals(tree({ 'i/a.png': 'x' }), tree({ 'i/a.png': 'y', 'i/b.svg': '<svg/>' }), V)
    assert.equal(signals.assets_changed, 2)
  })
})
