import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseMarked } from '../src/vrt/playground.mjs'
import { vrtErrorCode } from '../src/vrt/errors.mjs'

describe('parseMarked', () => {
  it('プラグインが先に何か出力していても、印の間の JSON だけを読む', () => {
    assert.deepEqual(parseMarked('Notice: hello from plugin\n<div>x</div>\n@@VRT@@{"ok":true}@@VRT-END@@'), { ok: true })
  })
  it('プラグインが後に何か出力していても（shutdown など）、印の間の JSON だけを読む', () => {
    assert.deepEqual(parseMarked('@@VRT@@{"ok":true}@@VRT-END@@<!-- cache by plugin -->\n'), { ok: true })
  })
  it('印が複数あれば最後のものを使う', () => {
    assert.deepEqual(parseMarked('@@VRT@@{"a":1}@@VRT-END@@\n@@VRT@@{"a":2}@@VRT-END@@'), { a: 2 })
  })
  it('印が無ければ php_no_marker（PHP が途中で止まった）', () => {
    assert.throws(() => parseMarked('Fatal error'), (e) => vrtErrorCode(e) === 'php_no_marker')
  })
  it('印の間が JSON として読めなければ php_bad_output', () => {
    assert.throws(() => parseMarked('@@VRT@@{"a":@@VRT-END@@'), (e) => vrtErrorCode(e) === 'php_bad_output')
  })
})
