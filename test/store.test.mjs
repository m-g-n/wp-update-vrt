import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFsStore, createR2Store, storeFromEnv } from '../src/state/store.mjs'
import { readWorkJSON, writeWorkJSON } from '../src/lib/work.mjs'

describe('createFsStore', () => {
  it('無ければ fallback、書いたら読める', async () => {
    const store = createFsStore(await mkdtemp(join(tmpdir(), 'store-')))
    assert.deepEqual(await store.getJSON('state/queue.json', []), [])
    await store.putJSON('state/queue.json', [{ key: 'a' }])
    assert.deepEqual(await store.getJSON('state/queue.json', []), [{ key: 'a' }])
  })
  it('.. や絶対パスを拒む', async () => {
    const store = createFsStore(await mkdtemp(join(tmpdir(), 'store-')))
    await assert.rejects(store.putJSON('../x.json', {}))
    await assert.rejects(store.putJSON('/x.json', {}))
  })
  it('putFile は Buffer をそのまま書き込み、読み直せる', async () => {
    const root = await mkdtemp(join(tmpdir(), 'store-'))
    const store = createFsStore(root)
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    await store.putFile('image.png', buf)
    const read = await readFile(join(root, 'image.png'))
    assert.deepEqual(read, buf)
  })
})

describe('createR2Store', () => {
  it('NoSuchKey は fallback、put は Bucket と Key を渡す', async () => {
    const sent = []
    const client = {
      async send(cmd) {
        sent.push(cmd)
        if (cmd.constructor.name === 'GetObjectCommand') {
          const err = new Error('nf')
          err.name = 'NoSuchKey'
          throw err
        }
        return {}
      },
    }
    const store = createR2Store({ accountId: 'a', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', client })
    assert.deepEqual(await store.getJSON('state/q.json', []), [])
    await store.putJSON('state/q.json', [1])
    assert.equal(sent[1].input.Bucket, 'b')
    assert.equal(sent[1].input.Key, 'state/q.json')
    assert.equal(sent[1].input.ContentType, 'application/json')
  })
  it('putFile は Key、Body、ContentType を渡す', async () => {
    const sent = []
    const client = {
      async send(cmd) {
        sent.push(cmd)
        return {}
      },
    }
    const store = createR2Store({ accountId: 'a', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', client })
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    await store.putFile('image.png', buf, 'image/png')
    assert.equal(sent[0].input.Key, 'image.png')
    assert.equal(sent[0].input.Body, buf)
    assert.equal(sent[0].input.ContentType, 'image/png')
  })
})

describe('storeFromEnv', () => {
  it('STORE_DIR があればローカル、R2 の設定が欠けていれば投げる', () => {
    assert.ok(storeFromEnv({ STORE_DIR: '/tmp/x' }))
    assert.throws(() => storeFromEnv({ R2_ACCOUNT_ID: 'a' }))
  })
})

describe('work', () => {
  it('書いたら読め、無ければ fallback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'work-'))
    await writeWorkJSON(dir, 'a/b.json', { x: 1 })
    assert.deepEqual(await readWorkJSON(dir, 'a/b.json'), { x: 1 })
    assert.equal(await readWorkJSON(dir, 'none.json', null), null)
  })
  it('.. や絶対パスを拒む', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'work-'))
    await assert.rejects(writeWorkJSON(dir, '../x.json', {}))
  })
})
