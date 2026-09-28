import { readFile } from 'node:fs/promises'

import { parseCandidates } from '../contracts/candidates.mjs'

// トークンを平文で流さないよう、https 以外には送らない。
// http → https のリダイレクトでは防げない（最初の http のリクエストにトークンが載る）。
// エラーメッセージに URL は入れない（公開リポジトリのログに出さないため）
function assertHttps(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('MANAGEWP_CANDIDATES_URL が URL として読めない')
  }
  if (parsed.protocol !== 'https:') throw new Error('MANAGEWP_CANDIDATES_URL は https でなければならない')
}

export async function fetchCandidatesFromManagewp({ url, token, fetchImpl = fetch }) {
  assertHttps(url)
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`managewp からの入力取得に失敗 (HTTP ${res.status})`)
  return parseCandidates(await res.json())
}

// 開発用。managewp のエンドポイントができるまでは手元のファイルを使う（コミットしない）
export async function readCandidatesFile(path) {
  return parseCandidates(JSON.parse(await readFile(path, 'utf8')))
}
