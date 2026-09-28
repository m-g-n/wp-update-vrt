import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { randomBytes } from 'node:crypto'

import { seal, unseal } from '../src/lib/seal.mjs'

const KEY = randomBytes(32).toString('base64')

describe('seal / unseal', () => {
  it('封をしたものを同じ鍵で開ける', () => {
    const obj = { slug: 'acme', list: [1, 'a→b'], nested: { x: null } }
    const buf = seal(obj, KEY)
    assert.ok(Buffer.isBuffer(buf))
    assert.ok(!buf.toString('latin1').includes('acme'))
    assert.deepEqual(unseal(buf, KEY), obj)
  })
  it('同じ中身でも毎回違う暗号文になる（IV が毎回違う）', () => {
    assert.notDeepEqual(seal({ a: 1 }, KEY), seal({ a: 1 }, KEY))
  })
  it('1バイトでも書き換えられていたら開かない', () => {
    const buf = seal({ slug: 'acme' }, KEY)
    buf[20] ^= 0x01
    assert.throws(() => unseal(buf, KEY), /開けない/)
  })
  it('鍵が違えば開かない', () => {
    const buf = seal({ slug: 'acme' }, KEY)
    assert.throws(() => unseal(buf, randomBytes(32).toString('base64')), /開けない/)
  })
  it('鍵が無い・長さが違うときは分かるように止める', () => {
    assert.throws(() => seal({ a: 1 }, undefined), /WORK_ENCRYPTION_KEY/)
    assert.throws(() => seal({ a: 1 }, ''), /WORK_ENCRYPTION_KEY/)
    assert.throws(() => seal({ a: 1 }, randomBytes(16).toString('base64')), /WORK_ENCRYPTION_KEY/)
    assert.throws(() => unseal(Buffer.alloc(40), undefined), /WORK_ENCRYPTION_KEY/)
  })
  it('短すぎるデータは開かない', () => {
    assert.throws(() => unseal(Buffer.alloc(10), KEY), /開けない/)
  })
})
