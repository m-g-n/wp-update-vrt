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

// err.message にはスラッグや URL が入りうるので出さない
export function reportFatal(stage, err) {
  log(`${stage}_failed`, { status: typeof err?.status === 'number' ? err.status : null })
  if (err instanceof GuardError) log(`guard_${err.code}`)
}
