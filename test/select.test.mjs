import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { stratumOf, isSelected, planVrt } from '../src/select/select.mjs'
import { mergeQueue, removeFromQueue, recordAttempt } from '../src/state/queue.mjs'

const sig = (over = {}) => ({
  version_only: false, unsanitized_files: 0,
  registrations_diff: { blocks_changed: [], shortcodes_added: [], shortcodes_removed: [] },
  ...over,
})
const jev = (over = {}) => ({ large_diff: false, error: null, ...over })

describe('stratumOf', () => {
  it('強制・閾値超え・抜き取りを分ける', () => {
    assert.deepEqual(stratumOf({ signals: sig(), jev: jev({ large_diff: true }), risk_score: 0 }), { stratum: 'forced', rate: 1 })
    assert.equal(stratumOf({ signals: sig({ unsanitized_files: 1 }), jev: jev(), risk_score: 0 }).stratum, 'forced')
    assert.equal(stratumOf({ signals: sig({ registrations_diff: { blocks_changed: ['a/b'], shortcodes_added: [], shortcodes_removed: [] } }), jev: jev(), risk_score: 0 }).stratum, 'forced')
    assert.deepEqual(stratumOf({ signals: sig({ version_only: true }), jev: jev(), risk_score: 0.02 }), { stratum: 'sample_version_only', rate: 0.02 })
    assert.deepEqual(stratumOf({ signals: sig(), jev: jev(), risk_score: 0.3 }), { stratum: 'above', rate: 1 })
    assert.deepEqual(stratumOf({ signals: sig(), jev: jev(), risk_score: 0.29 }), { stratum: 'sample', rate: 0.1 })
  })
  it('Jev がエラーでも強制にはしない（止まった日に上限を使い切らないため）', () => {
    assert.equal(stratumOf({ signals: sig(), jev: jev({ error: 'http_529' }), risk_score: 0.1 }).stratum, 'sample')
  })
})

describe('isSelected', () => {
  it('同じキーなら毎回同じ結果', () => {
    assert.equal(isSelected('a@1→2', { rate: 0.1 }), isSelected('a@1→2', { rate: 0.1 }))
  })
  it('抜き取り率はおおむね rate になる', () => {
    let n = 0
    for (let i = 0; i < 10000; i++) if (isSelected(`p${i}@1→2`, { rate: 0.1 })) n++
    assert.ok(n > 800 && n < 1200, `n=${n}`)
  })
  it('rate 1 は必ず選ぶ', () => {
    assert.equal(isSelected('x@1→2', { rate: 1 }), true)
  })
})

describe('planVrt', () => {
  const e = (key_hash, stratum, risk_score, first_queued = '2026-09-29') => ({ key: key_hash, key_hash, stratum, risk_score, first_queued, attempts: 0 })
  it('強制 → 閾値超え（高い順）→ 抜き取り → 小さい抜き取り の順で上限まで', () => {
    const { run, rest } = planVrt([
      e('s', 'sample', 0.1), e('a1', 'above', 0.4), e('v', 'sample_version_only', 0.02), e('f', 'forced', 0), e('a2', 'above', 0.9),
    ], 3)
    assert.deepEqual(run.map((x) => x.key_hash), ['f', 'a2', 'a1'])
    assert.deepEqual(rest.map((x) => x.key_hash), ['s', 'v'])
  })
  it('同じ区分・同じスコアなら古い順', () => {
    const { run } = planVrt([e('new', 'above', 0.5, '2026-09-30'), e('old', 'above', 0.5, '2026-09-28')], 1)
    assert.equal(run[0].key_hash, 'old')
  })
})

describe('queue', () => {
  it('上書きせず足す。既にある件は前回の attempts を残す', () => {
    const prev = [{ key: 'a', attempts: 2 }]
    const q = mergeQueue(prev, [{ key: 'a', attempts: 0 }, { key: 'b', attempts: 0 }])
    assert.deepEqual(q, [{ key: 'a', attempts: 2 }, { key: 'b', attempts: 0 }])
  })
  it('空の追加で前回の分が消えない（同じ日の2回目は新規0件になるため）', () => {
    assert.deepEqual(mergeQueue([{ key: 'a', attempts: 0 }], []), [{ key: 'a', attempts: 0 }])
  })
  it('完了したものを外す', () => {
    assert.deepEqual(removeFromQueue([{ key: 'a' }, { key: 'b' }], ['a']), [{ key: 'b' }])
  })
  it('試行を数え、3回で打ち切る', () => {
    let q = [{ key: 'a', attempts: 1 }]
    let r = recordAttempt(q, 'a')
    assert.equal(r.exhausted, false)
    assert.equal(r.queue[0].attempts, 2)
    r = recordAttempt(r.queue, 'a')
    assert.equal(r.exhausted, true)
  })
})
