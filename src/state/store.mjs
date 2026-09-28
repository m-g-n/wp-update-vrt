import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { safePath } from '../lib/safe-path.mjs'

// 開発とテスト用。本番は R2
export function createFsStore(root) {
  const full = (p) => join(root, safePath(p))
  const put = async (p, data) => {
    const f = full(p)
    await mkdir(dirname(f), { recursive: true })
    await writeFile(f, data)
  }
  return {
    async getJSON(p, fallback) {
      try {
        return JSON.parse(await readFile(full(p), 'utf8'))
      } catch (err) {
        if (err.code === 'ENOENT') return fallback
        throw err
      }
    },
    putJSON: (p, obj) => put(p, JSON.stringify(obj, null, 2)),
    putFile: (p, buf) => put(p, buf),
  }
}

// 結果は非公開のバケットに置く（公開リポジトリから読めないようにするため。spec §8）
export function createR2Store({ accountId, bucket, accessKeyId, secretAccessKey, client }) {
  const s3 = client ?? new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  })
  const put = (p, Body, ContentType) => s3.send(new PutObjectCommand({ Bucket: bucket, Key: safePath(p), Body, ContentType }))
  return {
    async getJSON(p, fallback) {
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: safePath(p) }))
        return JSON.parse(await res.Body.transformToString())
      } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return fallback
        throw err
      }
    },
    putJSON: (p, obj) => put(p, JSON.stringify(obj), 'application/json'),
    putFile: (p, buf, contentType) => put(p, buf, contentType),
  }
}

export function storeFromEnv(env = process.env) {
  if (env.STORE_DIR) return createFsStore(env.STORE_DIR)
  const need = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']
  const missing = need.filter((k) => !env[k])
  if (missing.length > 0) throw new Error(`ストアの設定が足りない: ${missing.join(', ')}`)
  return createR2Store({
    accountId: env.R2_ACCOUNT_ID,
    bucket: env.R2_BUCKET,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  })
}
