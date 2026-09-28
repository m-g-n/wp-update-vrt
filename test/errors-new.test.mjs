import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { newErrors } from '../src/vrt/capture.mjs'

const empty = { php: [], js: [] }

describe('newErrors', () => {
  it('旧版でも出ていた PHP の行は、日時が違っても新版で増えたものに数えない', () => {
    const before = { php: ['[28-Sep-2026 10:00:00 UTC] PHP Warning:  Undefined variable $a in /wordpress/x.php on line 3'], js: [] }
    const after = { php: [
      '[28-Sep-2026 10:05:12 UTC] PHP Warning:  Undefined variable $a in /wordpress/x.php on line 3',
      '[28-Sep-2026 10:05:13 UTC] PHP Fatal error:  Uncaught Error in /wordpress/y.php:9',
    ], js: [] }
    assert.deepEqual(newErrors(before, after).php, ['PHP Fatal error:  Uncaught Error in /wordpress/y.php:9'])
  })
  it('新版で同じ行が何度出ても1つにまとめる', () => {
    const line = '[28-Sep-2026 10:05:12 UTC] PHP Notice:  x'
    assert.deepEqual(newErrors(empty, { php: [line, line.replace('10:05:12', '10:05:40')], js: [] }).php, ['PHP Notice:  x'])
  })
  it('JS も旧版で出ていたものは除く', () => {
    const r = newErrors({ php: [], js: ['TypeError: a is undefined'] }, { php: [], js: ['TypeError: a is undefined', 'ReferenceError: b'] })
    assert.deepEqual(r.js, ['ReferenceError: b'])
  })
  it('こちらで止めた通信によるコンソールのエラーは数えない', () => {
    const r = newErrors(empty, { php: [], js: [
      'Failed to load resource: net::ERR_FAILED',
      'Failed to load resource: net::ERR_ABORTED',
      'ReferenceError: b',
    ] })
    assert.deepEqual(r.js, ['ReferenceError: b'])
  })
  it('形は { php: [], js: [] } のまま、1件は300文字・合計は50件までにする', () => {
    const r = newErrors(empty, { php: Array.from({ length: 60 }, (_, i) => `[d t UTC] PHP Warning: ${i} ${'x'.repeat(400)}`), js: [] })
    assert.deepEqual(Object.keys(r), ['php', 'js'])
    assert.equal(r.php.length, 50)
    assert.ok(r.php.every((l) => l.length <= 300))
    assert.deepEqual(r.js, [])
  })
})
