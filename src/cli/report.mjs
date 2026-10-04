import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'

import { storeFromEnv } from '../state/store.mjs'
import { buildReportHtml } from '../report/html.mjs'

// 手元で見るレポートを作る（Actions では動かさない）。
// 非公開の R2 から結果・画像・順番待ちを読み、リポジトリの外に HTML を書く。
// プラグイン名と版が入るので、公開リポジトリの中には書かない（spec §8）
//
//   npm run report               最新の日
//   npm run report -- 2026-10-04 その日
//
// R2 の読み取り用のキーは .env.report に置く（Git には入らない）

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const IMAGE_RE = /^img\/([0-9a-f]{16})\/[a-z]+-[0-9]+-(old|new|diff)\.png$/
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export function assertOutsideRepo(dir, repoRoot = REPO_ROOT) {
  const rel = relative(resolve(repoRoot), resolve(dir))
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(`レポートはリポジトリの外に書くこと（公開リポジトリにコミットしないため）: ${dir}`)
  }
}

export async function runReport({ store, outRoot, repoRoot = REPO_ROOT, date }) {
  if (date !== undefined && !DATE_RE.test(date)) throw new Error(`日付は YYYY-MM-DD で指定する: ${date}`)
  if (date === undefined) {
    const latest = await store.getJSON('results/latest.json', null)
    if (!latest) throw new Error('results/latest.json が無い')
    date = latest.date
  }
  const file = await store.getJSON(`results/${date}.json`, null)
  if (!file) throw new Error(`${date} の結果が無い`)
  // 順番待ちはいまの状態（その日の時点ではない）。ログに出た再試行中のハッシュを引くのに使う
  const queue = await store.getJSON('state/queue.json', [])

  const dir = join(outRoot, date)
  assertOutsideRepo(dir, repoRoot)
  await mkdir(dir, { recursive: true })

  for (const r of file.records) {
    for (const p of r.vrt?.pages ?? []) {
      for (const path of Object.values(p.images ?? {})) {
        // 結果の中のパスは形とハッシュを確かめてから使う（手元のファイルの外へ書かないため）
        const m = IMAGE_RE.exec(path ?? '')
        if (!m || m[1] !== r.key_hash) continue
        const bytes = await store.getBytes(path)
        if (!bytes) continue
        await mkdir(dirname(join(dir, path)), { recursive: true })
        await writeFile(join(dir, path), bytes)
      }
    }
  }
  await writeFile(join(dir, 'results.json'), JSON.stringify(file, null, 2))
  await writeFile(join(dir, 'index.html'), buildReportHtml({ date, records: file.records, queue }))
  return dir
}

async function main() {
  const outRoot = process.env.REPORT_DIR ?? resolve(REPO_ROOT, '..', 'wp-update-vrt-reports')
  const dir = await runReport({ store: storeFromEnv(), outRoot, date: process.argv[2] })
  console.log(join(dir, 'index.html'))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
