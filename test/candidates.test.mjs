import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { fetchCandidatesFromManagewp } from '../src/collect/candidates.mjs'

const body = { schema_version: 1, generated_at: '2026-09-29T00:00:00Z', items: [{ slug: 'acme', from: '1.0', to: '1.1' }] }

describe('fetchCandidatesFromManagewp', () => {
  it('https でない URL にはトークンを送らずに止める', async () => {
    let called = false
    const fetchImpl = async () => { called = true; return new Response(JSON.stringify(body), { status: 200 }) }
    await assert.rejects(fetchCandidatesFromManagewp({ url: 'http://example.test/api', token: 't', fetchImpl }))
    await assert.rejects(fetchCandidatesFromManagewp({ url: 'not a url', token: 't', fetchImpl }))
    assert.equal(called, false)
  })

  it('https なら Bearer トークン付きで取得して契約どおりに読む', async () => {
    let seen
    const fetchImpl = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify(body), { status: 200 }) }
    const items = await fetchCandidatesFromManagewp({ url: 'https://example.test/api', token: 't', fetchImpl })
    assert.deepEqual(items, [{ slug: 'acme', from: '1.0', to: '1.1' }])
    assert.equal(seen.init.headers.Authorization, 'Bearer t')
  })

  it('エラーメッセージに URL を入れない（公開ログに出さないため）', async () => {
    await assert.rejects(
      fetchCandidatesFromManagewp({ url: 'http://secret-host.test/api', token: 't' }),
      (err) => !String(err.message).includes('secret-host'),
    )
  })
})
