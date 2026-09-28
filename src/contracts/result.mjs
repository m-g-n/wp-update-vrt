import { ContractError } from '../lib/errors.mjs'

export const RESULT_SCHEMA_VERSION = 1

// 要素の順番ではなく名前で意味が決まる形にしている（scan-index.json の配列表現で起きた事故を避けるため）
export const RESULT_FIELDS = [
  'key', 'key_hash', 'slug', 'from', 'to', 'signals', 'jev',
  'risk_score_static', 'risk_score', 'p_visual', 'policy_version',
  'theme_override_risk', 'selection', 'vrt',
]

export const VRT_STATUSES = ['done', 'skipped', 'no_surface', 'failed', 'flaky', 'queued']

export function vrtPlaceholder(status, reason) {
  return { status, reason, env: null, noise_floor: null, pages: null, errors_new: null, vrt_changed: null }
}

// 結果に保守先由来か定点観測由来かを書かない。余計な項目はここで捨てる
export function buildResultRecord(parts) {
  const missing = RESULT_FIELDS.filter((f) => !(f in parts))
  if (missing.length > 0) throw new ContractError(`result: 項目が ${missing.length} 件足りない`)
  const record = {}
  for (const f of RESULT_FIELDS) record[f] = parts[f]
  if (!record.vrt || !VRT_STATUSES.includes(record.vrt.status)) throw new ContractError('result: vrt.status が不正')
  return record
}

export function buildResultFile(date, records) {
  return { schema_version: RESULT_SCHEMA_VERSION, date, records }
}
