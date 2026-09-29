import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { fetchPopular, diffPopular } from '../src/collect/popular.mjs'

describe('diffPopular', () => {
  it('前回と版が違うものだけを更新とみなす', () => {
    const { items, next } = diffPopular({ a: '1.0', b: '2.0' }, [{ slug: 'a', version: '1.1' }, { slug: 'b', version: '2.0' }])
    assert.deepEqual(items, [{ slug: 'a', from: '1.0', to: '1.1' }])
    assert.deepEqual(next, { a: '1.1', b: '2.0' })
  })
  it('初めて見たスラッグは記録だけする（どこから上がったか分からないため）', () => {
    const { items, next } = diffPopular({}, [{ slug: 'c', version: '3.0' }])
    assert.deepEqual(items, [])
    assert.deepEqual(next, { c: '3.0' })
  })
  it('今回の一覧から落ちたスラッグも前回の版を残す（また上位に戻ったときに使う）', () => {
    const { next } = diffPopular({ gone: '1.0' }, [])
    assert.deepEqual(next, { gone: '1.0' })
  })
  it('前回の版が契約の形でなければ、組にしない（記録は今回の版に進める）', () => {
    const { items, next } = diffPopular({ a: '1.0 beta' }, [{ slug: 'a', version: '1.1' }])
    assert.deepEqual(items, [])
    assert.deepEqual(next, { a: '1.1' })
  })
})

describe('fetchPopular の形の検査', () => {
  it('スラッグや版番号が A の契約の形に合わないものは取らない', async () => {
    const plugins = [
      { slug: 'ok-plugin', version: '1.2.3' },
      { slug: 'Bad_Slug', version: '1.0' },
      { slug: 'space-ver', version: '1.0 beta' },
      { slug: 'ctrl-ver', version: '1.0\n2' },
    ]
    const fetchImpl = async () => new Response(JSON.stringify({ info: { pages: 1 }, plugins }), { status: 200 })
    assert.deepEqual(await fetchPopular(10, { fetchImpl }), [{ slug: 'ok-plugin', version: '1.2.3' }])
  })
})

describe('fetchPopular', () => {
  it('ページをまたいで count 件まで集める', async () => {
    const pages = {
      1: { info: { pages: 2 }, plugins: Array.from({ length: 100 }, (_, i) => ({ slug: `p${i}`, version: '1.0' })) },
      2: { info: { pages: 2 }, plugins: [{ slug: 'q', version: '2.0' }] },
    }
    const urls = []
    const fetchImpl = async (url) => {
      urls.push(url)
      const page = Number(new URL(url).searchParams.get('request[page]'))
      return new Response(JSON.stringify(pages[page]), { status: 200 })
    }
    const got = await fetchPopular(101, { fetchImpl })
    assert.equal(got.length, 101)
    assert.deepEqual(got[100], { slug: 'q', version: '2.0' })
    assert.match(urls[0], /request\[browse\]=popular/)
  })
  it('HTTP エラーなら投げる', async () => {
    const fetchImpl = async () => new Response('', { status: 503 })
    await assert.rejects(fetchPopular(10, { fetchImpl }))
  })
})
