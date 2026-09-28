import { MAX_ATTEMPTS } from '../score/policy.mjs'

// キューは上書きせず前回の分に足す。
// wp-vuln-hub の X 投稿キューで、同じ日の2回目の実行（新規0件）が1回目の予定を消した事故と同じ構造を避ける
export function mergeQueue(prev, additions) {
  const byKey = new Map(prev.map((e) => [e.key, e]))
  for (const e of additions) if (!byKey.has(e.key)) byKey.set(e.key, e)
  return [...byKey.values()]
}

export function removeFromQueue(queue, keys) {
  const drop = new Set(keys)
  return queue.filter((e) => !drop.has(e.key))
}

export function recordAttempt(queue, key) {
  let exhausted = false
  const next = queue.map((e) => {
    if (e.key !== key) return e
    const attempts = (e.attempts ?? 0) + 1
    if (attempts >= MAX_ATTEMPTS) exhausted = true
    return { ...e, attempts }
  })
  return { queue: next, exhausted }
}
