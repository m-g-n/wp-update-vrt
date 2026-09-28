import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseMarked } from '../src/vrt/playground.mjs'

describe('parseMarked', () => {
  it('プラグインが先に何か出力していても、印の後の JSON だけを読む', () => {
    assert.deepEqual(parseMarked('Notice: hello from plugin\n<div>x</div>\n@@VRT@@{"ok":true}'), { ok: true })
  })
  it('印が複数あれば最後のものを使う', () => {
    assert.deepEqual(parseMarked('@@VRT@@{"a":1}\n@@VRT@@{"a":2}'), { a: 2 })
  })
  it('印が無ければ投げる', () => {
    assert.throws(() => parseMarked('Fatal error'))
  })
})
