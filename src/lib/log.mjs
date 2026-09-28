import { GuardError } from './errors.mjs'

// 公開リポジトリの Actions ログは誰でも読める。
// スラッグやバージョンが出ないよう、出せる値を型で絞る（数値・真偽値・null・キーのハッシュだけ）
const HASH_RE = /^[0-9a-f]{16}$/
const EVENT_RE = /^[a-z][a-z0-9_]{0,60}$/

let sink = (line) => console.log(line)

export function setLogSink(fn) {
  const prev = sink
  sink = fn
  return prev
}

function safe(value) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string' && HASH_RE.test(value)) return value
  return '[redacted]'
}

export function log(event, fields = {}) {
  const out = { event: EVENT_RE.test(event) ? event : 'redacted_event' }
  for (const [k, v] of Object.entries(fields)) out[k] = safe(v)
  sink(JSON.stringify(out))
}

// 原因の見当を付けるために出してよいエラーの種類。R2（S3 互換 API）の定型コードと、JS の組み込みの型だけ。
// ここに無い名前は出さない（名前にデータが入る余地を残さないため）
const SAFE_ERROR_CODES = new Set([
  'AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'NoSuchBucket', 'InvalidBucketName',
  'ExpiredToken', 'InvalidToken', 'Unauthorized', 'RequestTimeout', 'SlowDown', 'InternalError', 'ServiceUnavailable',
  'TypeError', 'SyntaxError', 'RangeError',
])

const toSnake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

function statusOf(err) {
  if (typeof err?.status === 'number') return err.status
  // R2 のエラー（AWS SDK）は HTTP のステータスを $metadata に持つ
  if (typeof err?.$metadata?.httpStatusCode === 'number') return err.$metadata.httpStatusCode
  return null
}

// err.message にはスラッグや URL が入りうるので出さない
export function reportFatal(stage, err) {
  log(`${stage}_failed`, { status: statusOf(err) })
  if (err instanceof GuardError) log(`guard_${err.code}`)
  else if (SAFE_ERROR_CODES.has(err?.name)) log(`${stage}_error_${toSnake(err.name)}`)
}
