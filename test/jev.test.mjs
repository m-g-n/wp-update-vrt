import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createJevClient, JevError } from '../src/jev/client.mjs'
import { runJev } from '../src/jev/run.mjs'

const ok = (answers) => new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: {} }), { status: 200 })
const noSleep = async () => {}

describe('createJevClient', () => {
  it('公式の形でリクエストする', async () => {
    let seen
    const fetchImpl = async (url, init) => { seen = { url, init }; return ok({ q: { type: 'noul', noul: 0.9 } }) }
    const client = createJevClient({ apiKey: 'k', fetchImpl, sleep: noSleep })
    await client.ask({ file: 'a.php', diff: '+x' }, { q: { type: 'noul', instructions: 'i' } })
    assert.equal(seen.url, 'https://api.typesafe.ai/v1/systemone')
    assert.equal(seen.init.headers.Authorization, 'Bearer k')
    const body = JSON.parse(seen.init.body)
    assert.equal(body.model, 'jev-latest')
    assert.deepEqual(body.state, { file: 'a.php', diff: '+x' })
  })
  it('529 は再試行して成功すれば返す', async () => {
    let n = 0
    const fetchImpl = async () => (++n < 3 ? new Response('', { status: 529 }) : ok({}))
    const client = createJevClient({ apiKey: 'k', fetchImpl, sleep: noSleep })
    await client.ask('s', {})
    assert.equal(n, 3)
  })
  it('401 は再試行せずに投げる', async () => {
    let n = 0
    const fetchImpl = async () => { n++; return new Response('', { status: 401 }) }
    const client = createJevClient({ apiKey: 'k', fetchImpl, sleep: noSleep })
    await assert.rejects(client.ask('s', {}), (e) => e instanceof JevError && e.status === 401)
    assert.equal(n, 1)
  })
  it('鍵が無ければ作れない', () => {
    assert.throws(() => createJevClient({ apiKey: '' }))
  })
  it('応答が JSON でなければ bad_response を投げる', async () => {
    const fetchImpl = async () => new Response('not json', { status: 200 })
    const client = createJevClient({ apiKey: 'k', fetchImpl, sleep: noSleep })
    await assert.rejects(client.ask('s', {}), (e) => e instanceof JevError && e.status === -1)
  })
})

const fakeClient = (fn) => ({ calls: 0, async ask(state, questions) { this.calls++; return fn(state, questions) } })

describe('runJev', () => {
  const hunks = { php: [{ path: 'a.php', text: '+echo 1' }, { path: 'b.php', text: '+echo 2' }], js: [{ path: 'f.js', text: '+x()' }] }

  it('塊ごとの最大値をとり、JS は「公開ページで動く × DOM を変える」も出す', async () => {
    const client = fakeClient((state, q) => {
      if (q.emits_markup) return { model: 'jev-1.13.0', answers: { emits_markup: { noul: state.file === 'a.php' ? 0.2 : 0.8 } } }
      return { model: 'jev-1.13.0', answers: { runs_on_front: { noul: 0.5 }, mutates_dom: { noul: 0.6 } } }
    })
    const r = await runJev(hunks, client, { maxHunks: 40 })
    assert.equal(r.emits_markup, 0.8)
    assert.equal(r.runs_on_front, 0.5)
    assert.equal(r.mutates_dom, 0.6)
    assert.equal(r.js_front_dom, 0.3)
    assert.equal(r.hunks_sent, 3)
    assert.equal(r.model, 'jev-1.13.0')
    assert.equal(r.error, null)
  })
  it('塊が上限を超えたら聞かずに large_diff', async () => {
    const client = fakeClient(() => { throw new Error('呼ばれてはいけない') })
    const r = await runJev(hunks, client, { maxHunks: 2 })
    assert.equal(r.large_diff, true)
    assert.equal(client.calls, 0)
  })
  it('circuitOpen なら聞かずに circuit_open を返す（塊が無い・大きすぎるときはそちらを優先）', async () => {
    let called = false
    const client = { async ask() { called = true } }
    const hunks = { php: [{ path: 'a.php', text: 'x' }], js: [] }
    const r = await runJev(hunks, client, { maxHunks: 40, circuitOpen: true })
    assert.equal(r.error, 'circuit_open')
    assert.equal(r.hunks_sent, 0)
    assert.equal(r.emits_markup, null)
    assert.equal(called, false)
    assert.equal((await runJev({ php: [], js: [] }, client, { maxHunks: 40, circuitOpen: true })).error, null)
    assert.equal((await runJev(hunks, client, { maxHunks: 0, circuitOpen: true })).large_diff, true)
  })

  it('塊が無ければ聞かない', async () => {
    const client = fakeClient(() => { throw new Error('呼ばれてはいけない') })
    const r = await runJev({ php: [], js: [] }, client, { maxHunks: 40 })
    assert.equal(r.emits_markup, null)
    assert.equal(client.calls, 0)
  })
  it('再試行しても 529 なら値は null で error に残す', async () => {
    const client = fakeClient(() => { throw new JevError(529, 'x') })
    const r = await runJev(hunks, client, { maxHunks: 40 })
    assert.equal(r.error, 'http_529')
    assert.equal(r.emits_markup, null)
  })
  it('応答の形が違えば bad_response', async () => {
    const client = fakeClient(() => ({ model: 'm', answers: {} }))
    assert.equal((await runJev(hunks, client, { maxHunks: 40 })).error, 'bad_response')
  })
  it('401 は全体を止めるために投げ直す', async () => {
    const client = fakeClient(() => { throw new JevError(401, 'x') })
    await assert.rejects(runJev(hunks, client, { maxHunks: 40 }), (e) => e.status === 401)
  })
})
