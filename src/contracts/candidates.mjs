import { ContractError } from '../lib/errors.mjs'
import { makeKey } from '../lib/key.mjs'

export const CANDIDATES_SCHEMA_VERSION = 1
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/

// エラーメッセージには添字だけを入れる（スラッグをログに出さないため）
export function parseCandidates(json) {
  if (json?.schema_version !== CANDIDATES_SCHEMA_VERSION) {
    throw new ContractError(`candidates: schema_version が ${CANDIDATES_SCHEMA_VERSION} ではない`)
  }
  if (!Array.isArray(json.items)) throw new ContractError('candidates: items が配列ではない')
  const seen = new Set()
  const items = []
  for (const [i, it] of json.items.entries()) {
    if (!SLUG_RE.test(it?.slug ?? '')) throw new ContractError(`candidates: items[${i}].slug が不正`)
    if (!VERSION_RE.test(it?.from ?? '') || !VERSION_RE.test(it?.to ?? '')) {
      throw new ContractError(`candidates: items[${i}] のバージョンが不正`)
    }
    if (it.from === it.to) continue
    const item = { slug: it.slug, from: it.from, to: it.to }
    const key = makeKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    items.push(item)
  }
  return items
}
