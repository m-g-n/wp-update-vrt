import { sampleUnit } from '../lib/key.mjs'
import { hasRegistrations } from '../score/score.mjs'
import { THRESHOLD, SAMPLE_RATE, SAMPLE_RATE_VERSION_ONLY } from '../score/policy.mjs'

const ORDER = { forced: 0, above: 1, sample: 2, sample_version_only: 3 }

// Jev のエラーは強制にしない。Jev が止まった日に全件が VRT に回り、上限を使い切るのを防ぐ（spec §4.5）
export function stratumOf({ signals, jev, risk_score }) {
  if (jev.large_diff || signals.unsanitized_files > 0 || hasRegistrations(signals.registrations_diff)) {
    return { stratum: 'forced', rate: 1 }
  }
  if (signals.version_only) return { stratum: 'sample_version_only', rate: SAMPLE_RATE_VERSION_ONLY }
  if (risk_score >= THRESHOLD) return { stratum: 'above', rate: 1 }
  return { stratum: 'sample', rate: SAMPLE_RATE }
}

// キーのハッシュで決めるので、再実行しても同じ組が選ばれる。
// 区分と rate を結果に残し、見逃し率を逆確率の重み付けで推定できるようにする
export function isSelected(key, { rate }) {
  return rate >= 1 || sampleUnit(key) < rate
}

// 保守先の組を優先して並べない（優先すると並び順から保守先の組が推測できるため）
export function planVrt(entries, limit) {
  const sorted = [...entries].sort((a, b) =>
    ORDER[a.stratum] - ORDER[b.stratum]
    || b.risk_score - a.risk_score
    || a.first_queued.localeCompare(b.first_queued)
    || a.key_hash.localeCompare(b.key_hash))
  return { run: sorted.slice(0, limit), rest: sorted.slice(limit) }
}
