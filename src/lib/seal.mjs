import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// work/ は公開アーティファクトになる。組（スラッグ・バージョン）を含むファイルは
// prepare と publish だけが持つ鍵で封をしてから置く（vrt ジョブは鍵を持たない）
// 形式: IV 12バイト + 暗号文 + 認証タグ 16バイト（AES-256-GCM）
const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

// エラーの文言に鍵や中身を入れない（ログには出さないが、念のため）
function keyFrom(keyB64) {
  const key = typeof keyB64 === 'string' && keyB64 !== '' ? Buffer.from(keyB64, 'base64') : null
  if (!key || key.length !== 32) throw new Error('WORK_ENCRYPTION_KEY が無いか、32バイトの base64 ではない')
  return key
}

// 重い処理を始める前に鍵を確かめるため（最後の書き込みで気づくと、その日の Jev の呼び出しが無駄になる）
export function assertWorkKey(keyB64) {
  keyFrom(keyB64)
}

export function seal(obj, keyB64) {
  const key = keyFrom(keyB64)
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, key, iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()])
  return Buffer.concat([iv, body, cipher.getAuthTag()])
}

export function unseal(buf, keyB64) {
  const key = keyFrom(keyB64)
  if (!Buffer.isBuffer(buf) || buf.length < IV_LEN + TAG_LEN) throw new Error('封をしたデータを開けない（短すぎる）')
  try {
    const decipher = createDecipheriv(ALGO, key, buf.subarray(0, IV_LEN))
    decipher.setAuthTag(buf.subarray(buf.length - TAG_LEN))
    const text = Buffer.concat([decipher.update(buf.subarray(IV_LEN, buf.length - TAG_LEN)), decipher.final()]).toString('utf8')
    return JSON.parse(text)
  } catch {
    throw new Error('封をしたデータを開けない（鍵が違うか、改ざんされている）')
  }
}
