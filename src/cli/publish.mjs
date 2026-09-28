import { pathToFileURL } from 'node:url'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { log, reportFatal } from '../lib/log.mjs'
import { todayJst } from '../lib/date.mjs'
import { readWorkJSON, readWorkFile, readWorkSealed, workExists } from '../lib/work.mjs'
import { assertWorkKey } from '../lib/seal.mjs'
import { GuardError } from '../lib/errors.mjs'
import { buildResultRecord, buildResultFile, vrtPlaceholder, RESULT_SCHEMA_VERSION } from '../contracts/result.mjs'
import { removeFromQueue, recordAttempt } from '../state/queue.mjs'
import { storeFromEnv } from '../state/store.mjs'

// 当日の結果ファイルは上書きせず key 単位で足す。確定した結果を queued で上書きしない
export function mergeRecords(prev, next) {
  const byKey = new Map(prev.map((r) => [r.key, r]))
  for (const r of next) {
    const old = byKey.get(r.key)
    if (old && old.vrt?.status !== 'queued' && r.vrt?.status === 'queued') continue
    byKey.set(r.key, r)
  }
  return [...byKey.values()]
}

// R2 に書くのはこの段だけ。結果と画像を先に書き、状態は最後に書く
// （途中で落ちたら、翌日に同じ組をもう一度処理するだけで済むように）
export async function runPublish({ store, workDir, today, workKey }) {
  assertWorkKey(workKey)
  const next = await readWorkSealed(workDir, 'state-next.sealed', workKey)
  const jobs = await readWorkJSON(workDir, 'jobs.json')
  const records = [...(await readWorkSealed(workDir, 'records.sealed', workKey))]
  const processed = new Set(next.processed)
  let queue = next.queue
  const counts = { published: 0, attempt_failed: 0, failed: 0, queued: 0 }
  const ran = new Set()

  for (const { key_hash } of jobs) {
    ran.add(key_hash)
    const pending = await readWorkSealed(workDir, `pending/${key_hash}.sealed`, workKey)
    const resultPath = `vrt/${key_hash}/result.json`
    if (await workExists(workDir, resultPath)) {
      const vrt = await readWorkJSON(workDir, resultPath)
      const dir = join(workDir, 'vrt', key_hash)
      for (const name of (await readdir(dir)).filter((n) => n.endsWith('.png'))) {
        await store.putFile(`img/${key_hash}/${name}`, await readWorkFile(workDir, `vrt/${key_hash}/${name}`), 'image/png')
      }
      records.push(buildResultRecord({ ...pending, vrt }))
      processed.add(pending.key)
      queue = removeFromQueue(queue, [pending.key])
      counts.published++
      continue
    }
    const attempt = recordAttempt(queue, pending.key)
    queue = attempt.queue
    if (attempt.exhausted) {
      records.push(buildResultRecord({ ...pending, vrt: vrtPlaceholder('failed', 'vrt_failed') }))
      processed.add(pending.key)
      queue = removeFromQueue(queue, [pending.key])
      counts.failed++
    } else {
      counts.attempt_failed++
    }
  }

  // 今日追加して今日は実行しなかった組。pending を R2 に残し、queued として知らせる
  for (const hash of next.additions) {
    const pending = await readWorkSealed(workDir, `pending/${hash}.sealed`, workKey)
    await store.putJSON(`state/pending/${hash}.json`, pending)
    if (ran.has(hash)) continue
    records.push(buildResultRecord({ ...pending, vrt: vrtPlaceholder('queued', null) }))
    counts.queued++
  }

  const path = `results/${today}.json`
  const prev = await store.getJSON(path, { records: [] })
  await store.putJSON(path, buildResultFile(today, mergeRecords(prev.records, records)))
  await store.putJSON('results/latest.json', { schema_version: RESULT_SCHEMA_VERSION, date: today, path })

  await store.putJSON('state/queue.json', queue)
  await store.putJSON('state/processed.json', [...processed])
  await store.putJSON('state/popular-versions.json', next.popular_versions)
  await store.putJSON('state/last-input-count.json', { count: next.input_count })

  log('publish_done', { ...counts, records: records.length, queue: queue.length })
  return counts
}

async function main() {
  const env = process.env
  if (!env.WORK_ENCRYPTION_KEY) throw new GuardError('missing_work_key')
  await runPublish({ store: storeFromEnv(env), workDir: env.WORK_DIR ?? 'work', today: todayJst(), workKey: env.WORK_ENCRYPTION_KEY })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    reportFatal('publish', err)
    process.exit(1)
  })
}
