import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import AdmZip from 'adm-zip'

import { zipUrl, fetchZip, readTree, NotOnWporgError } from '../src/collect/wporg.mjs'
import { makeZip } from './helpers/tree.mjs'

describe('zipUrl', () => {
  it('配布 URL を組む', () => {
    assert.equal(zipUrl('contact-form-7', '6.1.7'), 'https://downloads.wordpress.org/plugin/contact-form-7.6.1.7.zip')
  })
})

describe('fetchZip', () => {
  it('404 は NotOnWporgError', async () => {
    const fetchImpl = async () => new Response('nf', { status: 404 })
    await assert.rejects(fetchZip('x', '1.0', { fetchImpl }), NotOnWporgError)
  })
  it('500 は普通のエラー（翌日に再試行させる）', async () => {
    const fetchImpl = async () => new Response('err', { status: 500 })
    await assert.rejects(fetchZip('x', '1.0', { fetchImpl }), (err) => !(err instanceof NotOnWporgError))
  })
  it('200 なら中身を Buffer で返す', async () => {
    const zip = makeZip('x', { 'x.php': '<?php' })
    const fetchImpl = async () => new Response(zip, { status: 200 })
    assert.equal((await fetchZip('x', '1.0', { fetchImpl })).length, zip.length)
  })
})

describe('readTree', () => {
  it('先頭の slug/ を外した Map にする', () => {
    const t = readTree(makeZip('acme', { 'acme.php': '<?php', 'css/a.css': '.a{}' }), 'acme')
    assert.deepEqual([...t.keys()].sort(), ['acme.php', 'css/a.css'])
    assert.equal(t.get('css/a.css').toString(), '.a{}')
  })
  it('.. を含むパスがあれば投げる', () => {
    const zip = new AdmZip()
    zip.addFile('acme/ok.php', Buffer.from('<?php'))
    zip.getEntries()[0].entryName = 'acme/../evil.php'
    assert.throws(() => readTree(zip.toBuffer(), 'acme'))
  })
  it('slug のフォルダが無ければ投げる', () => {
    assert.throws(() => readTree(makeZip('other', { 'a.php': '<?php' }), 'acme'))
  })
})
