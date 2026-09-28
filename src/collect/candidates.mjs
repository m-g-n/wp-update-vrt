import { readFile } from 'node:fs/promises'

import { parseCandidates } from '../contracts/candidates.mjs'

export async function fetchCandidatesFromManagewp({ url, token, fetchImpl = fetch }) {
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`managewp からの入力取得に失敗 (HTTP ${res.status})`)
  return parseCandidates(await res.json())
}

// 開発用。managewp のエンドポイントができるまでは手元のファイルを使う（コミットしない）
export async function readCandidatesFile(path) {
  return parseCandidates(JSON.parse(await readFile(path, 'utf8')))
}
