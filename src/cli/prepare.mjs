import { pathToFileURL } from 'node:url'

import { makeKey, keyHash } from '../lib/key.mjs'
import { log, reportFatal } from '../lib/log.mjs'
import { GuardError } from '../lib/errors.mjs'
import { todayJst } from '../lib/date.mjs'
import { writeWorkJSON, writeWorkFile, writeWorkSealed } from '../lib/work.mjs'
import { assertWorkKey } from '../lib/seal.mjs'
import { fetchZip, readTree, NotOnWporgError } from '../collect/wporg.mjs'
import { fetchPopular, diffPopular } from '../collect/popular.mjs'
import { fetchCandidatesFromManagewp, readCandidatesFile } from '../collect/candidates.mjs'
import { computeSignals } from '../signals/index.mjs'
import { createJevClient } from '../jev/client.mjs'
import { runJev } from '../jev/run.mjs'
import { scoreStatic, scoreWithJev, themeOverrideRisk } from '../score/score.mjs'
import { POLICY_VERSION, MAX_HUNKS, DAILY_VRT_LIMIT, POPULAR_COUNT, MAX_NEW_PER_RUN, JEV_CIRCUIT_THRESHOLD } from '../score/policy.mjs'
import { stratumOf, isSelected, planVrt } from '../select/select.mjs'
import { mergeQueue, removeFromQueue } from '../state/queue.mjs'
import { storeFromEnv } from '../state/store.mjs'
import { buildResultRecord, vrtPlaceholder } from '../contracts/result.mjs'

const SUDDEN_EMPTY_MIN = 5

function uniqueByKey(items) {
  const map = new Map()
  for (const it of items) map.set(makeKey(it), it)
  return [...map.values()]
}

function finalRecord(item, key, hash, reason, extra = {}) {
  return buildResultRecord({
    key, key_hash: hash, slug: item.slug, from: item.from, to: item.to,
    signals: null, jev: null, risk_score_static: null, risk_score: null, p_visual: null,
    policy_version: POLICY_VERSION, theme_override_risk: null, selection: null,
    ...extra,
    vrt: vrtPlaceholder('skipped', reason),
  })
}

export async function runPrepare({ store, fetchCandidates, jevClient, fetchImpl = fetch, today, workDir, workKey, limits = {} }) {
  assertWorkKey(workKey)
  // 入力が取れない日・急に0件になった日は、空の結果を公開せずに止める
  const maintained = await fetchCandidates()
  const last = await store.getJSON('state/last-input-count.json', { count: 0 })
  if (maintained.length === 0 && last.count >= SUDDEN_EMPTY_MIN) throw new GuardError('input_sudden_empty')

  const popularPrev = await store.getJSON('state/popular-versions.json', {})
  const popularNow = await fetchPopular(limits.popularCount ?? POPULAR_COUNT, { fetchImpl })
  const popular = diffPopular(popularPrev, popularNow)
  // 初回は前日の版が無いので定点観測が0件になり、その日の組が全部保守先由来になってしまう。
  // その日は版だけ記録し、保守先の組には手を付けない（処理済みにもキューにも入れない）
  const warmup = Object.keys(popularPrev).length === 0
  if (warmup) log('popular_warmup', { popular_versions: Object.keys(popular.next).length })

  const processed = new Set(await store.getJSON('state/processed.json', []))
  let queue = await store.getJSON('state/queue.json', [])
  const queued = new Set(queue.map((e) => e.key))

  // 保守先の組と定点観測の組を区別せず、ハッシュ順に処理する（順番からも見分けられないように）
  const all = warmup ? [] : uniqueByKey([...maintained, ...popular.items])
    .map((item) => ({ item, key: makeKey(item) }))
    .map((x) => ({ ...x, hash: keyHash(x.key) }))
    .sort((a, b) => a.hash.localeCompare(b.hash))

  // 保守先由来の件数と定点観測の件数の内訳はログに出さない（公開ログから保守先の規模が読めてしまうため）
  const counts = { new: 0, deferred: 0, skipped: 0, selected: 0, not_selected: 0, download_error: 0, jev_error: 0 }
  const maxNew = limits.maxNew ?? MAX_NEW_PER_RUN
  let jevFailStreak = 0
  const records = []
  const additions = []
  const zipCache = new Map()

  for (const { item, key, hash } of all) {
    if (processed.has(key) || queued.has(key)) continue
    // 上限を超えた分は処理済みにもキューにも入れず、次回以降にハッシュ順で拾う
    if (counts.new >= maxNew) {
      counts.deferred++
      continue
    }
    counts.new++

    let oldZip
    let newZip
    try {
      oldZip = await fetchZip(item.slug, item.from, { fetchImpl })
      newZip = await fetchZip(item.slug, item.to, { fetchImpl })
    } catch (err) {
      if (err instanceof NotOnWporgError) {
        records.push(finalRecord(item, key, hash, 'not_on_wporg'))
        processed.add(key)
        counts.skipped++
      } else {
        counts.download_error++ // 一時的な失敗は確定させず、翌日に取り直す
      }
      continue
    }

    let computed
    try {
      computed = computeSignals(readTree(oldZip, item.slug), readTree(newZip, item.slug), item)
    } catch {
      records.push(finalRecord(item, key, hash, 'unreadable_zip'))
      processed.add(key)
      counts.skipped++
      continue
    }

    const { signals, hunks } = computed
    const circuitOpen = jevFailStreak >= JEV_CIRCUIT_THRESHOLD
    const jev = await runJev(hunks, jevClient, { maxHunks: MAX_HUNKS, circuitOpen })
    if (jev.error) counts.jev_error++
    // 実際に Jev に聞いて失敗した組だけを数え、聞いて成功したら数え直す（聞かなかった組では変えない）
    if (jev.error && jev.error !== 'circuit_open') {
      if (++jevFailStreak === JEV_CIRCUIT_THRESHOLD) log('jev_circuit_open')
    } else if (!jev.error && jev.hunks_sent > 0) {
      jevFailStreak = 0
    }
    const risk_score_static = scoreStatic(signals)
    const risk_score = scoreWithJev(signals, jev)
    const selection = stratumOf({ signals, jev, risk_score })
    const partial = {
      key, key_hash: hash, slug: item.slug, from: item.from, to: item.to,
      signals, jev, risk_score_static, risk_score, p_visual: null, policy_version: POLICY_VERSION,
      theme_override_risk: themeOverrideRisk(signals), selection,
    }

    if (isSelected(key, selection)) {
      await writeWorkSealed(workDir, `pending/${hash}.sealed`, partial, workKey)
      zipCache.set(hash, { oldZip, newZip })
      additions.push({ key, key_hash: hash, stratum: selection.stratum, risk_score, first_queued: today, attempts: 0 })
      counts.selected++
    } else {
      records.push(buildResultRecord({ ...partial, vrt: vrtPlaceholder('skipped', 'not_selected') }))
      processed.add(key)
      counts.not_selected++
    }
  }

  queue = mergeQueue(queue, additions)
  const { run } = warmup ? { run: [] } : planVrt(queue, limits.dailyLimit ?? DAILY_VRT_LIMIT)

  // 前日以前からキューに残っていた分は、pending を R2 から写し、zip を取り直す
  const jobs = []
  for (const entry of run) {
    let zipsFor = zipCache.get(entry.key_hash)
    if (!zipsFor) {
      const pending = await store.getJSON(`state/pending/${entry.key_hash}.json`, null)
      if (!pending) {
        queue = removeFromQueue(queue, [entry.key])
        continue
      }
      try {
        zipsFor = {
          oldZip: await fetchZip(pending.slug, pending.from, { fetchImpl }),
          newZip: await fetchZip(pending.slug, pending.to, { fetchImpl }),
        }
      } catch {
        counts.download_error++
        continue
      }
      await writeWorkSealed(workDir, `pending/${entry.key_hash}.sealed`, pending, workKey)
    }
    await writeWorkFile(workDir, `zips/${entry.key_hash}-old.zip`, zipsFor.oldZip)
    await writeWorkFile(workDir, `zips/${entry.key_hash}-new.zip`, zipsFor.newZip)
    jobs.push({ key_hash: entry.key_hash })
  }

  // jobs.json は vrt ジョブが鍵なしで読むので、ハッシュだけを平文で置く。ほかは封をする
  await writeWorkJSON(workDir, 'jobs.json', jobs)
  await writeWorkSealed(workDir, 'records.sealed', records, workKey)
  await writeWorkSealed(workDir, 'state-next.sealed', {
    processed: [...processed],
    queue,
    additions: additions.map((a) => a.key_hash),
    popular_versions: popular.next,
    input_count: maintained.length,
  }, workKey)

  log('prepare_done', { ...counts, jobs: jobs.length, queue: queue.length })
  return counts
}

async function main() {
  const env = process.env
  if (!env.WORK_ENCRYPTION_KEY) throw new GuardError('missing_work_key')
  const fetchCandidates = env.INPUT_FILE
    ? () => readCandidatesFile(env.INPUT_FILE)
    : () => fetchCandidatesFromManagewp({ url: env.MANAGEWP_CANDIDATES_URL, token: env.MANAGEWP_TOKEN })
  await runPrepare({
    store: storeFromEnv(env),
    fetchCandidates,
    jevClient: createJevClient({ apiKey: env.TYPESAFE_API_KEY }),
    today: todayJst(),
    workDir: env.WORK_DIR ?? 'work',
    workKey: env.WORK_ENCRYPTION_KEY,
  })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    reportFatal('prepare', err)
    process.exit(1)
  })
}
