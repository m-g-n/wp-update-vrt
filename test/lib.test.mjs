import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { makeKey, keyHash, sampleUnit } from '../src/lib/key.mjs'
import { log, setLogSink, reportFatal } from '../src/lib/log.mjs'
import { GuardError } from '../src/lib/errors.mjs'
import { todayJst } from '../src/lib/date.mjs'

const capture = (fn) => {
  const lines = []
  const prev = setLogSink((l) => lines.push(l))
  try { fn() } finally { setLogSink(prev) }
  return lines
}

describe('key', () => {
  it('キーはスラッグと新旧バージョンから作る', () => {
    assert.equal(makeKey({ slug: 'acme', from: '1.0', to: '1.1' }), 'acme@1.0→1.1')
  })
  it('keyHash は16桁の16進で、同じキーなら同じ値', () => {
    const h = keyHash('acme@1.0→1.1')
    assert.match(h, /^[0-9a-f]{16}$/)
    assert.equal(h, keyHash('acme@1.0→1.1'))
    assert.notEqual(h, keyHash('acme@1.0→1.2'))
  })
  it('sampleUnit は [0,1) で、同じキーなら同じ値', () => {
    const u = sampleUnit('acme@1.0→1.1')
    assert.ok(u >= 0 && u < 1)
    assert.equal(u, sampleUnit('acme@1.0→1.1'))
  })
})

describe('log', () => {
  it('数値・真偽値・null・ハッシュはそのまま出す', () => {
    const [line] = capture(() => log('stage_done', { n: 3, ok: true, x: null, key_hash: 'abcdef0123456789' }))
    assert.deepEqual(JSON.parse(line), { event: 'stage_done', n: 3, ok: true, x: null, key_hash: 'abcdef0123456789' })
  })
  it('それ以外の文字列は伏せる（スラッグやバージョンを出さない）', () => {
    const [line] = capture(() => log('stage_done', { slug: 'akismet', ver: '5.3.1' }))
    assert.ok(!line.includes('akismet'))
    assert.ok(!line.includes('5.3.1'))
  })
  it('イベント名に使えない文字が入っていたら伏せる', () => {
    const [line] = capture(() => log('acme@1.0→1.1'))
    assert.ok(!line.includes('acme'))
  })
  it('reportFatal はエラーメッセージを出さない', () => {
    const err = new Error('download failed for secret-plugin 9.8.7')
    const [line] = capture(() => reportFatal('prepare', err))
    assert.ok(!line.includes('secret-plugin'))
    assert.ok(!line.includes('9.8.7'))
    assert.equal(JSON.parse(line).event, 'prepare_failed')
  })
  it('reportFatal は GuardError の理由コードだけ別に出す', () => {
    const lines = capture(() => reportFatal('prepare', new GuardError('input_sudden_empty')))
    assert.equal(JSON.parse(lines[1]).event, 'guard_input_sudden_empty')
  })
})

describe('todayJst', () => {
  it('UTC 19:41 は JST の翌日', () => {
    assert.equal(todayJst(new Date('2026-09-28T19:41:00Z')), '2026-09-29')
  })
})
