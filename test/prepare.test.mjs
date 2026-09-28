import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runPrepare } from '../src/cli/prepare.mjs'
import { createFsStore } from '../src/state/store.mjs'
import { readWorkJSON, readWorkSealed } from '../src/lib/work.mjs'
import { setLogSink } from '../src/lib/log.mjs'
import { GuardError } from '../src/lib/errors.mjs'
import { JevError } from '../src/jev/client.mjs'
import { makeZip } from './helpers/tree.mjs'

const SECRET = 'secret-fixture-plugin'
const KEY = randomBytes(32).toString('base64')
const zips = {
  [`${SECRET}.9.8.7`]: makeZip(SECRET, { 'p.php': "<?php\necho '<a class=\"x\">';\n", 'a.css': '.x{color:red}' }),
  [`${SECRET}.9.8.8`]: makeZip(SECRET, { 'p.php': "<?php\necho '<a class=\"y\">';\n", 'a.css': '.y{color:blue}' }),
  'broken-plugin.1.0': makeZip('other-folder', { 'p.php': '<?php' }),
  'broken-plugin.1.1': makeZip('other-folder', { 'p.php': '<?php' }),
}

const fakeFetch = (popular = []) => async (url) => {
  if (url.includes('query_plugins')) return new Response(JSON.stringify({ info: { pages: 1 }, plugins: popular }), { status: 200 })
  const m = url.match(/plugin\/(.+)\.zip$/)
  const buf = m && zips[decodeURIComponent(m[1])]
  return buf ? new Response(buf, { status: 200 }) : new Response('nf', { status: 404 })
}
const jevOk = { async ask(state, q) {
  const answers = {}
  for (const id of Object.keys(q)) answers[id] = { type: 'noul', noul: 0.9 }
  return { model: 'jev-1.13.0', answers }
} }
const jevDown = { async ask() { throw new JevError(529, 'x') } }

// 初回（定点観測の版がまだ無い日）は慣らし運転になるので、ふだんのテストは2日目以降の状態から始める
async function setup({ popularVersions = { 'seed-plugin': '1.0' } } = {}) {
  const store = createFsStore(await mkdtemp(join(tmpdir(), 'store-')))
  const workDir = await mkdtemp(join(tmpdir(), 'work-'))
  await store.putJSON('state/popular-versions.json', popularVersions)
  return { store, workDir }
}

const base = (over) => ({
  fetchImpl: fakeFetch(),
  jevClient: jevOk,
  today: '2026-09-29',
  workKey: KEY,
  limits: { popularCount: 10, dailyLimit: 30 },
  ...over,
})

describe('runPrepare', () => {
  it('ログにスラッグもバージョンも出さない（Review Focus 5）', async () => {
    const { store, workDir } = await setup()
    const lines = []
    const prev = setLogSink((l) => lines.push(l))
    try {
      await runPrepare(base({ store, workDir, fetchCandidates: async () => [{ slug: SECRET, from: '9.8.7', to: '9.8.8' }] }))
    } finally {
      setLogSink(prev)
    }
    const all = lines.join('\n')
    assert.ok(lines.length > 0)
    assert.ok(!all.includes(SECRET))
    assert.ok(!all.includes('9.8.7'))
  })

  it('閾値を超えた組は jobs と zip と pending に入る', async () => {
    const { store, workDir } = await setup()
    await runPrepare(base({ store, workDir, fetchCandidates: async () => [{ slug: SECRET, from: '9.8.7', to: '9.8.8' }] }))
    const jobs = await readWorkJSON(workDir, 'jobs.json')
    assert.equal(jobs.length, 1)
    const pending = await readWorkSealed(workDir, `pending/${jobs[0].key_hash}.sealed`, KEY)
    assert.equal(pending.selection.stratum, 'above')
    assert.equal(pending.jev.model, 'jev-1.13.0')
    assert.ok(!('source' in pending))
  })

  it('zips/ 以外の work のファイルに組を平文で残さない（公開アーティファクトになるため）', async () => {
    const { store, workDir } = await setup()
    await runPrepare(base({ store, workDir, fetchCandidates: async () => [
      { slug: SECRET, from: '9.8.7', to: '9.8.8' },
      { slug: 'paid-plugin', from: '1.0', to: '1.1' },
    ] }))
    const files = (await readdir(workDir, { recursive: true, withFileTypes: true }))
      .filter((d) => d.isFile())
      .map((d) => join(d.parentPath, d.name))
      .filter((f) => !f.startsWith(join(workDir, 'zips')))
    assert.ok(files.length >= 4)
    for (const f of files) {
      const text = (await readFile(f)).toString('latin1')
      for (const needle of [SECRET, 'paid-plugin', '9.8.7']) assert.ok(!text.includes(needle), `${f} に ${needle}`)
    }
  })

  it('鍵が無ければ何もせずに止める', async () => {
    const { store, workDir } = await setup()
    let called = false
    await assert.rejects(
      runPrepare(base({ store, workDir, workKey: undefined, fetchCandidates: async () => { called = true; return [] } })),
      /WORK_ENCRYPTION_KEY/,
    )
    assert.equal(called, false)
  })

  it('WordPress.org に無い組は skipped: not_on_wporg として確定する', async () => {
    const { store, workDir } = await setup()
    await runPrepare(base({ store, workDir, fetchCandidates: async () => [{ slug: 'paid-plugin', from: '1.0', to: '1.1' }] }))
    const records = await readWorkSealed(workDir, 'records.sealed', KEY)
    assert.equal(records[0].vrt.status, 'skipped')
    assert.equal(records[0].vrt.reason, 'not_on_wporg')
    const next = await readWorkSealed(workDir, 'state-next.sealed', KEY)
    assert.ok(next.processed.includes('paid-plugin@1.0→1.1'))
  })

  it('zip の構造が違う組は unreadable_zip で確定し、全体は止まらない（Review Focus 2）', async () => {
    const { store, workDir } = await setup()
    await runPrepare(base({ store, workDir, fetchCandidates: async () => [
      { slug: 'broken-plugin', from: '1.0', to: '1.1' },
      { slug: SECRET, from: '9.8.7', to: '9.8.8' },
    ] }))
    const records = await readWorkSealed(workDir, 'records.sealed', KEY)
    assert.equal(records.find((r) => r.slug === 'broken-plugin').vrt.reason, 'unreadable_zip')
    assert.equal((await readWorkJSON(workDir, 'jobs.json')).length, 1)
  })

  it('Jev が止まっていても強制は増えず、静的なスコアで選ぶ（Review Focus 3）', async () => {
    const { store, workDir } = await setup()
    await runPrepare(base({ store, workDir, jevClient: jevDown, fetchCandidates: async () => [{ slug: SECRET, from: '9.8.7', to: '9.8.8' }] }))
    const [job] = await readWorkJSON(workDir, 'jobs.json')
    const pending = await readWorkSealed(workDir, `pending/${job.key_hash}.sealed`, KEY)
    assert.equal(pending.jev.error, 'http_529')
    assert.notEqual(pending.selection.stratum, 'forced')
    assert.equal(pending.risk_score, pending.risk_score_static)
  })

  it('入力が取れなければ止める', async () => {
    const { store, workDir } = await setup()
    await assert.rejects(runPrepare(base({ store, workDir, fetchCandidates: async () => { throw new Error('HTTP 500') } })))
  })

  it('前回5件以上あったのに急に0件なら止める', async () => {
    const { store, workDir } = await setup()
    await store.putJSON('state/last-input-count.json', { count: 12 })
    await assert.rejects(runPrepare(base({ store, workDir, fetchCandidates: async () => [] })), GuardError)
  })

  it('処理済み・キュー済みの組は取り直さない', async () => {
    const { store, workDir } = await setup()
    const key = `${SECRET}@9.8.7→9.8.8`
    await store.putJSON('state/processed.json', [key])
    const counts = await runPrepare(base({ store, workDir, fetchCandidates: async () => [{ slug: SECRET, from: '9.8.7', to: '9.8.8' }] }))
    assert.equal(counts.new, 0)
  })

  it('1回に処理する新しい組は上限まで。残りは手を付けずに次回へ回す', async () => {
    const { store, workDir } = await setup()
    const lines = []
    const prev = setLogSink((l) => lines.push(l))
    let counts
    try {
      counts = await runPrepare(base({
        store, workDir, limits: { popularCount: 10, dailyLimit: 30, maxNew: 2 },
        fetchCandidates: async () => ['paid-a', 'paid-b', 'paid-c'].map((slug) => ({ slug, from: '1.0', to: '1.1' })),
      }))
    } finally {
      setLogSink(prev)
    }
    assert.equal(counts.new, 2)
    assert.equal(counts.deferred, 1)
    const next = await readWorkSealed(workDir, 'state-next.sealed', KEY)
    assert.equal(next.processed.length, 2)
    assert.deepEqual(next.queue, [])
    assert.equal((await readWorkSealed(workDir, 'records.sealed', KEY)).length, 2)
    assert.equal(lines.map((l) => JSON.parse(l)).find((e) => e.event === 'prepare_done').deferred, 1)
  })

  it('Jev の失敗が続いたら、その回の残りは Jev に聞かずに circuit_open とする', async () => {
    const { store, workDir } = await setup()
    const slugs = Array.from({ length: 8 }, (_, i) => `jevfail-${i}`)
    const own = {}
    for (const slug of slugs) {
      own[`${slug}.1.0`] = makeZip(slug, { 'p.php': "<?php\necho '<a class=\"x\">';\n" })
      own[`${slug}.1.1`] = makeZip(slug, { 'p.php': "<?php\necho '<a class=\"y\">';\n" })
    }
    const fetchImpl = async (url) => {
      if (url.includes('query_plugins')) return new Response(JSON.stringify({ info: { pages: 1 }, plugins: [] }), { status: 200 })
      const buf = own[decodeURIComponent(url.match(/plugin\/(.+)\.zip$/)[1])]
      return buf ? new Response(buf, { status: 200 }) : new Response('nf', { status: 404 })
    }
    let calls = 0
    const jevClient = { async ask() { calls++; throw new JevError(529, 'x') } }
    await runPrepare(base({
      store, workDir, fetchImpl, jevClient, limits: { popularCount: 10, dailyLimit: 0 },
      fetchCandidates: async () => slugs.map((slug) => ({ slug, from: '1.0', to: '1.1' })),
    }))
    assert.equal(calls, 5)
    const next = await readWorkSealed(workDir, 'state-next.sealed', KEY)
    const outs = [
      ...(await readWorkSealed(workDir, 'records.sealed', KEY)),
      ...(await Promise.all(next.additions.map((h) => readWorkSealed(workDir, `pending/${h}.sealed`, KEY)))),
    ]
    assert.equal(outs.length, 8)
    assert.equal(outs.filter((r) => r.jev.error === 'http_529').length, 5)
    const open = outs.filter((r) => r.jev.error === 'circuit_open')
    assert.equal(open.length, 3)
    for (const r of open) assert.equal(r.risk_score, r.risk_score_static)
  })

  it('定点観測の版が1つも無い日は版だけ記録し、保守先の組は1件も処理しない（慣らし運転）', async () => {
    const { store, workDir } = await setup({ popularVersions: {} })
    const lines = []
    const prev = setLogSink((l) => lines.push(l))
    let counts
    try {
      counts = await runPrepare(base({
        store, workDir,
        fetchImpl: fakeFetch([{ slug: 'popular-a', version: '2.0' }]),
        fetchCandidates: async () => [{ slug: SECRET, from: '9.8.7', to: '9.8.8' }],
      }))
    } finally {
      setLogSink(prev)
    }
    assert.equal(counts.new, 0)
    assert.deepEqual(await readWorkJSON(workDir, 'jobs.json'), [])
    const next = await readWorkSealed(workDir, 'state-next.sealed', KEY)
    assert.deepEqual(next.processed, [])
    assert.deepEqual(next.queue, [])
    assert.deepEqual(next.additions, [])
    assert.deepEqual(next.popular_versions, { 'popular-a': '2.0' })
    assert.deepEqual(await readWorkSealed(workDir, 'records.sealed', KEY), [])
    assert.ok(lines.some((l) => JSON.parse(l).event === 'popular_warmup'))

    // 翌日は定点観測と一緒に処理する
    await store.putJSON('state/popular-versions.json', next.popular_versions)
    const workDir2 = await mkdtemp(join(tmpdir(), 'work-'))
    const counts2 = await runPrepare(base({ store, workDir: workDir2, fetchCandidates: async () => [{ slug: SECRET, from: '9.8.7', to: '9.8.8' }] }))
    assert.equal(counts2.new, 1)
  })

  it('定点観測の組も同じ規則で処理し、結果には由来を書かない', async () => {
    const { store, workDir } = await setup()
    await store.putJSON('state/popular-versions.json', { [SECRET]: '9.8.7' })
    await runPrepare(base({ store, workDir, fetchImpl: fakeFetch([{ slug: SECRET, version: '9.8.8' }]), fetchCandidates: async () => [] }))
    const next = await readWorkSealed(workDir, 'state-next.sealed', KEY)
    assert.equal(next.popular_versions[SECRET], '9.8.8')
    assert.equal((await readWorkJSON(workDir, 'jobs.json')).length, 1)
  })
})
