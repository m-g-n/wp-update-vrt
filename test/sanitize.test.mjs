import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { stripPhpComments, stripJsComments, stripCssComments } from '../src/signals/sanitize.mjs'

describe('stripPhpComments', () => {
  it('//・#・/* */・docblock を消し、改行の数は保つ', () => {
    const src = "<?php\n// No visual changes\n/**\n * doc\n */\necho '<a class=\"x\">'; # hash\n"
    const { ok, text } = stripPhpComments(src)
    assert.ok(ok)
    assert.ok(!text.includes('No visual changes'))
    assert.ok(!text.includes('doc'))
    assert.ok(!text.includes('hash'))
    assert.ok(text.includes(`echo '<a class="x">'`))
    assert.equal(text.split('\n').length, src.split('\n').length)
  })
  it('コメントが無ければそのまま返す', () => {
    const src = "<?php\necho 'a';\n?><p>html</p>\n"
    assert.equal(stripPhpComments(src).text, src)
  })
  it('文字列の中の // は消さない', () => {
    const { text } = stripPhpComments("<?php\n$u = 'https://example.com';\n")
    assert.ok(text.includes('https://example.com'))
  })
})

describe('stripJsComments', () => {
  it('コメントを消し、正規表現や文字列の // は残す', () => {
    const src = "const r = /a\\/\\/b/g // tail\n/* This change is cosmetic-free */\nconst u = 'http://x'\n"
    const { ok, text } = stripJsComments(src)
    assert.ok(ok)
    assert.ok(!text.includes('cosmetic-free'))
    assert.ok(!text.includes('tail'))
    assert.ok(text.includes('/a\\/\\/b/g'))
    assert.ok(text.includes("'http://x'"))
    assert.equal(text.split('\n').length, src.split('\n').length)
  })
  it('JSX の中のコメントも消す', () => {
    const { ok, text } = stripJsComments('export default () => <div className="a">{/* hidden note */ x}</div>')
    assert.ok(ok)
    assert.ok(!text.includes('hidden note'))
    assert.ok(text.includes('className="a"'))
  })
  it('字句として読めなければ ok: false', () => {
    assert.deepEqual(stripJsComments("const a = 'unterminated"), { ok: false, text: null })
  })
})

describe('stripCssComments', () => {
  it('コメントを消す', () => {
    const { ok, text } = stripCssComments('/* ignore me */ .a { color: red }')
    assert.ok(ok)
    assert.ok(!text.includes('ignore me'))
    assert.ok(text.includes('color: red'))
  })
  it('読めなければ ok: false', () => {
    assert.equal(stripCssComments('.a { color: red').ok, false)
  })
})
