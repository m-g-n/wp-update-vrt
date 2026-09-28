import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseCandidates } from '../src/contracts/candidates.mjs'
import { RESULT_FIELDS, buildResultRecord, vrtPlaceholder, buildResultFile } from '../src/contracts/result.mjs'
import { parseLabels } from '../src/contracts/labels.mjs'
import { ContractError } from '../src/lib/errors.mjs'

/**
 * この3本は managewp との契約。項目を変えるとこのテストが落ちる。
 * 落ちたら docs/*-format.md と managewp 側の取り込みを同時に直し、schema_version を上げること。
 * 出す順番は、このリポジトリが先、managewp が後。
 */
describe('parseCandidates', () => {
  it('重複と from==to を除く', () => {
    const items = parseCandidates({ schema_version: 1, items: [
      { slug: 'acme', from: '1.0', to: '1.1' },
      { slug: 'acme', from: '1.0', to: '1.1' },
      { slug: 'same', from: '2.0', to: '2.0' },
    ] })
    assert.deepEqual(items, [{ slug: 'acme', from: '1.0', to: '1.1' }])
  })
  it('schema_version が違えば投げる', () => {
    assert.throws(() => parseCandidates({ schema_version: 2, items: [] }), ContractError)
  })
  it('スラッグやバージョンに使えない文字があれば投げる', () => {
    assert.throws(() => parseCandidates({ schema_version: 1, items: [{ slug: '../x', from: '1', to: '2' }] }), ContractError)
    assert.throws(() => parseCandidates({ schema_version: 1, items: [{ slug: 'x', from: '1 ; rm', to: '2' }] }), ContractError)
  })
  it('サイトの情報など余計な項目は捨てる', () => {
    const [item] = parseCandidates({ schema_version: 1, items: [{ slug: 'acme', from: '1', to: '2', site: 'example.com' }] })
    assert.deepEqual(Object.keys(item), ['slug', 'from', 'to'])
  })
})

describe('result', () => {
  it('項目の集合と順番を固定する', () => {
    assert.deepEqual(RESULT_FIELDS, [
      'key', 'key_hash', 'slug', 'from', 'to', 'signals', 'jev',
      'risk_score_static', 'risk_score', 'p_visual', 'policy_version',
      'theme_override_risk', 'selection', 'vrt',
    ])
  })
  it('vrt の項目を固定する', () => {
    assert.deepEqual(Object.keys(vrtPlaceholder('queued', null)), [
      'status', 'reason', 'env', 'noise_floor', 'pages', 'errors_new', 'vrt_changed',
    ])
  })
  it('足りない項目があれば投げ、余計な項目は捨てる', () => {
    const parts = Object.fromEntries(RESULT_FIELDS.map((f) => [f, null]))
    parts.vrt = vrtPlaceholder('skipped', 'not_selected')
    assert.deepEqual(Object.keys(buildResultRecord({ ...parts, source: 'maintained' })), RESULT_FIELDS)
    const { key, ...missing } = parts
    assert.throws(() => buildResultRecord(missing), ContractError)
  })
  it('vrt.status が語彙に無ければ投げる', () => {
    const parts = Object.fromEntries(RESULT_FIELDS.map((f) => [f, null]))
    parts.vrt = { ...vrtPlaceholder('done', null), status: 'ok' }
    assert.throws(() => buildResultRecord(parts), ContractError)
  })
  it('結果ファイルは schema_version を持つ', () => {
    assert.deepEqual(buildResultFile('2026-09-29', []), { schema_version: 1, date: '2026-09-29', records: [] })
  })
})

describe('parseLabels', () => {
  it('語彙と日付の形を検査する', () => {
    const labels = parseLabels({ schema_version: 1, labels: [{ key: 'acme@1→2', label: 'regression', labeled_at: '2026-10-03', by: 'someone' }] })
    assert.deepEqual(labels, [{ key: 'acme@1→2', label: 'regression', labeled_at: '2026-10-03' }])
    assert.throws(() => parseLabels({ schema_version: 1, labels: [{ key: 'k', label: 'broken', labeled_at: '2026-10-03' }] }), ContractError)
    assert.throws(() => parseLabels({ schema_version: 1, labels: [{ key: 'k', label: 'none', labeled_at: '10/03' }] }), ContractError)
  })
})
