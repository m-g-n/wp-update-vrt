import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { runPublish, mergeRecords } from '../src/cli/publish.mjs'
import { createFsStore } from '../src/state/store.mjs'
import { writeWorkJSON, writeWorkFile, writeWorkSealed } from '../src/lib/work.mjs'
import { RESULT_FIELDS, vrtPlaceholder } from '../src/contracts/result.mjs'

const H = 'abcdef0123456789'
const KEY = randomBytes(32).toString('base64')
const PAIR = 'acme@1→2'
const partial = () => {
  const p = Object.fromEntries(RESULT_FIELDS.filter((f) => f !== 'vrt').map((f) => [f, null]))
  return { ...p, key: PAIR, key_hash: H, slug: 'acme', from: '1', to: '2' }
}

async function setup({ withVrt, attempts = 0, additions = [] }) {
  const root = await mkdtemp(join(tmpdir(), 'store-'))
  const store = createFsStore(root)
  const workDir = await mkdtemp(join(tmpdir(), 'work-'))
  await writeWorkJSON(workDir, 'jobs.json', [{ key_hash: H }])
  await writeWorkSealed(workDir, 'records.sealed', [], KEY)
  await writeWorkSealed(workDir, `pending/${H}.sealed`, partial(), KEY)
  await writeWorkSealed(workDir, 'state-next.sealed', {
    processed: [], queue: [{ key: PAIR, key_hash: H, stratum: 'above', risk_score: 0.5, first_queued: '2026-09-29', attempts }],
    additions, popular_versions: { acme: '2' }, input_count: 1,
  }, KEY)
  if (withVrt) {
    await writeWorkJSON(workDir, `vrt/${H}/result.json`, {
      ...vrtPlaceholder('done', null), pages: [{ page: 'home', width: 1280, diff_ratio: 0.1, images: { old: `img/${H}/home-1280-old.png`, new: `img/${H}/home-1280-new.png`, diff: `img/${H}/home-1280-diff.png` } }], vrt_changed: true,
    })
    for (const k of ['old', 'new', 'diff']) await writeWorkFile(workDir, `vrt/${H}/home-1280-${k}.png`, Buffer.from(k))
  }
  return { store, workDir }
}

describe('runPublish', () => {
  it('VRT の結果を結果ファイルに入れ、キューから外し、処理済みにする', async () => {
    const { store, workDir } = await setup({ withVrt: true })
    await runPublish({ store, workDir, today: '2026-09-29', workKey: KEY })
    const file = await store.getJSON('results/2026-09-29.json', null)
    assert.equal(file.schema_version, 1)
    assert.equal(file.records[0].vrt.status, 'done')
    assert.deepEqual(await store.getJSON('state/queue.json', null), [])
    assert.deepEqual(await store.getJSON('state/processed.json', null), [PAIR])
    assert.deepEqual(await store.getJSON('results/latest.json', null), { schema_version: 1, date: '2026-09-29', path: 'results/2026-09-29.json' })
    assert.deepEqual(await store.getJSON('state/popular-versions.json', null), { acme: '2' })
  })
  it('VRT の結果が無ければ試行を数えてキューに残す', async () => {
    const { store, workDir } = await setup({ withVrt: false })
    await runPublish({ store, workDir, today: '2026-09-29', workKey: KEY })
    const q = await store.getJSON('state/queue.json', null)
    assert.equal(q[0].attempts, 1)
  })
  it('3回目の失敗で failed として確定する', async () => {
    const { store, workDir } = await setup({ withVrt: false, attempts: 2 })
    await runPublish({ store, workDir, today: '2026-09-29', workKey: KEY })
    const file = await store.getJSON('results/2026-09-29.json', null)
    assert.equal(file.records[0].vrt.status, 'failed')
    assert.deepEqual(await store.getJSON('state/queue.json', null), [])
  })
  it('vrt 段が確定させた failed（画像なし）は、1回目でも結果に書いてキューから外す', async () => {
    const { store, workDir } = await setup({ withVrt: false })
    await writeWorkJSON(workDir, `vrt/${H}/result.json`, vrtPlaceholder('failed', 'vrt_failed'))
    await runPublish({ store, workDir, today: '2026-09-29', workKey: KEY })
    const file = await store.getJSON('results/2026-09-29.json', null)
    assert.equal(file.records[0].vrt.status, 'failed')
    assert.equal(file.records[0].vrt.pages, null)
    assert.deepEqual(await store.getJSON('state/queue.json', null), [])
    assert.deepEqual(await store.getJSON('state/processed.json', null), [PAIR])
  })
  it('今日追加して今日実行しなかった組は queued として出す', async () => {
    const { store, workDir } = await setup({ withVrt: false, additions: ['ffffffffffffffff'] })
    await writeWorkSealed(workDir, 'pending/ffffffffffffffff.sealed', { ...partial(), key: 'b@1→2', key_hash: 'ffffffffffffffff', slug: 'b' }, KEY)
    await runPublish({ store, workDir, today: '2026-09-29', workKey: KEY })
    const file = await store.getJSON('results/2026-09-29.json', null)
    assert.equal(file.records.find((r) => r.key === 'b@1→2').vrt.status, 'queued')
    assert.ok(await store.getJSON('state/pending/ffffffffffffffff.json', null))
  })
  it('同じ日の2回目は当日の結果ファイルに足す（Review Focus 4）', async () => {
    const { store, workDir } = await setup({ withVrt: true })
    await store.putJSON('results/2026-09-29.json', { schema_version: 1, date: '2026-09-29', records: [{ key: 'earlier@1→2', vrt: { status: 'skipped' } }] })
    await runPublish({ store, workDir, today: '2026-09-29', workKey: KEY })
    const file = await store.getJSON('results/2026-09-29.json', null)
    assert.deepEqual(file.records.map((r) => r.key).sort(), ['acme@1→2', 'earlier@1→2'])
  })
})

describe('mergeRecords', () => {
  it('確定した結果を queued で上書きしない', () => {
    const merged = mergeRecords([{ key: 'a', vrt: { status: 'done' } }], [{ key: 'a', vrt: { status: 'queued' } }])
    assert.equal(merged[0].vrt.status, 'done')
  })
  it('queued は確定した結果で置き換える', () => {
    const merged = mergeRecords([{ key: 'a', vrt: { status: 'queued' } }], [{ key: 'a', vrt: { status: 'done' } }])
    assert.equal(merged[0].vrt.status, 'done')
  })
})
