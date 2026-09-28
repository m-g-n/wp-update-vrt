import { ContractError } from '../lib/errors.mjs'

export const LABELS_SCHEMA_VERSION = 1
export const LABEL_VALUES = ['none', 'intended', 'regression']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// 付けた人の名前は受け取らない（受け取っても捨てる）
export function parseLabels(json) {
  if (json?.schema_version !== LABELS_SCHEMA_VERSION) {
    throw new ContractError(`labels: schema_version が ${LABELS_SCHEMA_VERSION} ではない`)
  }
  if (!Array.isArray(json.labels)) throw new ContractError('labels: labels が配列ではない')
  return json.labels.map((l, i) => {
    if (typeof l?.key !== 'string' || l.key === '') throw new ContractError(`labels[${i}].key が不正`)
    if (!LABEL_VALUES.includes(l.label)) throw new ContractError(`labels[${i}].label が不正`)
    if (!DATE_RE.test(l.labeled_at ?? '')) throw new ContractError(`labels[${i}].labeled_at が不正`)
    return { key: l.key, label: l.label, labeled_at: l.labeled_at }
  })
}
