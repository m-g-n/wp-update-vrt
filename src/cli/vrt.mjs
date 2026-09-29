import { pathToFileURL } from 'node:url'

import { log, reportFatal } from '../lib/log.mjs'
import { readWorkJSON, readWorkFile, writeWorkJSON, writeWorkFile } from '../lib/work.mjs'
import { VRT_JOB_TIMEOUT_MS } from '../score/policy.mjs'
import { vrtErrorCode } from '../vrt/errors.mjs'

class VrtTimeout extends Error {}

// 時間切れになったら signal で止めさせ（Playground を破棄させる）、待たずに失敗として返す
async function withTimeout(fn, ms) {
  const ac = new AbortController()
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ac.abort()
      reject(new VrtTimeout('vrt_timeout'))
    }, ms)
  })
  try {
    return await Promise.race([fn(ac.signal), timeout])
  } finally {
    clearTimeout(timer)
  }
}

// このジョブには secret を渡さない（他人のプラグインのコードを実行するため。spec §4.6）
async function defaultRunOne() {
  const { chromium } = await import('playwright')
  const { runVrt } = await import('../vrt/run.mjs')
  let browser = null
  return {
    async run(job, port, signal) {
      browser ??= await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined })
      return runVrt(job, { browser, port, signal })
    },
    close: () => browser?.close(),
  }
}

// 1件も成功しなかった日（Playground が起動しない・Chromium が無いなど）は、ジョブを失敗にして通知に載せる。
// publish は試行回数を数えるために、このジョブが失敗しても走る
export function vrtAllFailed(jobCount, counts) {
  return jobCount > 0 && counts.error === jobCount
}

export async function runVrtStage({ workDir, runOne, portBase = 9400, timeoutMs = VRT_JOB_TIMEOUT_MS }) {
  const jobs = await readWorkJSON(workDir, 'jobs.json')
  const runner = runOne ? { run: runOne, close: async () => {} } : await defaultRunOne()
  const counts = { done: 0, no_surface: 0, flaky: 0, error: 0 }
  try {
    for (const [i, { key_hash }] of jobs.entries()) {
      const job = {
        oldZip: await readWorkFile(workDir, `zips/${key_hash}-old.zip`),
        newZip: await readWorkFile(workDir, `zips/${key_hash}-new.zip`),
      }
      let result = null
      for (let attempt = 0; attempt < 2 && !result; attempt++) {
        try {
          const port = portBase + ((i * 2 + attempt) % 100)
          result = await withTimeout((signal) => runner.run(job, port, signal), timeoutMs)
        } catch (err) {
          // 1回だけ再試行する。2回とも失敗したら何も書かず、publish が試行回数を数える。
          // 原因は決まった語のコードだけで残す（err.message にはプラグイン由来の文字列が入りうるため）
          if (err instanceof VrtTimeout) log('vrt_timeout', { key_hash, attempt })
          else log(`vrt_error_${vrtErrorCode(err)}`, { key_hash, attempt })
        }
      }
      if (!result) {
        counts.error++
        continue
      }
      // テストページに置けたブロックの数は、表示できなかったものがどれだけあるかを見るためにログにだけ出す
      const { probe, ...vrt } = result
      if (probe) log('vrt_blocks', { key_hash, made: probe.made, from_example: probe.from_example, visible: probe.visible })
      const pages = []
      for (const p of vrt.pages) {
        const images = {}
        for (const kind of ['old', 'new', 'diff']) {
          const name = `${p.page}-${p.width}-${kind}.png`
          await writeWorkFile(workDir, `vrt/${key_hash}/${name}`, p.images[kind])
          images[kind] = `img/${key_hash}/${name}`
        }
        pages.push({ ...p, images })
      }
      await writeWorkJSON(workDir, `vrt/${key_hash}/result.json`, { ...vrt, pages })
      counts[vrt.status] = (counts[vrt.status] ?? 0) + 1
    }
  } finally {
    await runner.close()
  }
  log('vrt_done', { jobs: jobs.length, ...counts })
  return counts
}

async function main() {
  const workDir = process.env.WORK_DIR ?? 'work'
  const counts = await runVrtStage({ workDir })
  const jobs = await readWorkJSON(workDir, 'jobs.json')
  const allFailed = vrtAllFailed(jobs.length, counts)
  if (allFailed) log('vrt_all_failed', { jobs: jobs.length })
  // 時間切れで見捨てた処理が残っていても待たずに終える（結果は書き終えている）
  process.exit(allFailed ? 1 : 0)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    reportFatal('vrt', err)
    process.exit(1)
  })
}
