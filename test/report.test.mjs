import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { buildReportHtml } from '../src/report/html.mjs'
import { assertOutsideRepo, runReport } from '../src/cli/report.mjs'
import { createFsStore } from '../src/state/store.mjs'

const H1 = 'aaaaaaaaaaaaaaaa'
const H2 = 'bbbbbbbbbbbbbbbb'
const H3 = 'cccccccccccccccc'

const page = (hash, name, ratio) => ({
  page: name, width: 1280, diff_ratio: ratio,
  images: { old: `img/${hash}/${name}-1280-old.png`, new: `img/${hash}/${name}-1280-new.png`, diff: `img/${hash}/${name}-1280-diff.png` },
})
const record = (over) => ({
  key: 'acme@1.0→1.1', key_hash: H1, slug: 'acme', from: '1.0', to: '1.1',
  risk_score: 0.9, selection: { stratum: 'above', rate: 1 }, theme_override_risk: { selectors_removed: [] },
  vrt: { status: 'done', reason: null, pages: [page(H1, 'home', 0.05)], errors_new: { php: [], js: [] }, vrt_changed: true },
  ...over,
})
const records = [
  record(),
  record({ key: 'quiet@2→3', key_hash: H2, slug: 'quiet', from: '2', to: '3', risk_score: 0.1, selection: { stratum: 'sample', rate: 0.1 },
    vrt: { status: 'skipped', reason: 'not_selected', pages: null, errors_new: null, vrt_changed: null } }),
  record({ key: 'evil@1→2', key_hash: H3, slug: 'evil', from: '1', to: '2',
    vrt: { status: 'done', reason: null, pages: [page(H3, 'home', 0.01)], errors_new: { php: ['<script>alert(1)</script>'], js: [] }, vrt_changed: true } }),
]
const queue = [{ key: 'waiting@1→2', key_hash: 'dddddddddddddddd', stratum: 'above', risk_score: 0.85, first_queued: '2026-10-03', attempts: 2 }]

describe('buildReportHtml', () => {
  const html = buildReportHtml({ date: '2026-10-04', records, queue })

  it('VRT が走った組を、ログのハッシュと一緒に一覧にする', () => {
    assert.match(html, /acme@1\.0→1\.1/)
    assert.match(html, new RegExp(H1))
    assert.match(html, /evil@1→2/)
  })
  it('変化ありの組は、旧版・新版・差分の画像を並べる', () => {
    assert.match(html, new RegExp(`img/${H1}/home-1280-old\\.png`))
    assert.match(html, new RegExp(`img/${H1}/home-1280-diff\\.png`))
  })
  it('VRT しなかった組も別の表に出す', () => {
    assert.match(html, /quiet@2→3/)
  })
  it('その日は順番待ちだった組は「VRT せず」に数えない', () => {
    const queued = record({ key: 'later@1→2', key_hash: 'eeeeeeeeeeeeeeee', vrt: { status: 'queued', reason: null, pages: null, errors_new: null, vrt_changed: null } })
    const h = buildReportHtml({ date: '2026-10-04', records: [...records, queued], queue: [] })
    assert.match(h, /<div class="v">1<\/div><div class="l">VRT せず<\/div>/)
    assert.match(h, /<div class="v">1<\/div><div class="l">その日は順番待ち<\/div>/)
  })
  it('順番待ち・再試行中の組を、試行回数と一緒に出す', () => {
    assert.match(html, /waiting@1→2/)
    assert.match(html, /dddddddddddddddd/)
  })
  it('プラグイン由来の文字列はエスケープする', () => {
    assert.ok(!html.includes('<script>alert(1)</script>'))
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  })
})

describe('assertOutsideRepo', () => {
  const repo = resolve('/x/wp-update-vrt')
  it('リポジトリの外なら通す', () => {
    assert.doesNotThrow(() => assertOutsideRepo('/x/wp-update-vrt-reports/2026-10-04', repo))
  })
  it('リポジトリの中なら止める（公開リポジトリにコミットしないため）', () => {
    assert.throws(() => assertOutsideRepo('/x/wp-update-vrt/reports', repo), /リポジトリの外/)
    assert.throws(() => assertOutsideRepo('/x/wp-update-vrt', repo), /リポジトリの外/)
  })
})

describe('runReport', () => {
  it('結果・画像・順番待ちを読み、日付のフォルダに HTML と画像を書く', async () => {
    const store = createFsStore(await mkdtemp(join(tmpdir(), 'store-')))
    await store.putJSON('results/latest.json', { schema_version: 1, date: '2026-10-04', path: 'results/2026-10-04.json' })
    await store.putJSON('results/2026-10-04.json', { schema_version: 1, date: '2026-10-04', records })
    await store.putJSON('state/queue.json', queue)
    for (const k of ['old', 'new', 'diff']) {
      await store.putFile(`img/${H1}/home-1280-${k}.png`, Buffer.from(k))
      await store.putFile(`img/${H3}/home-1280-${k}.png`, Buffer.from(k))
    }
    const outRoot = await mkdtemp(join(tmpdir(), 'reports-'))
    const dir = await runReport({ store, outRoot, repoRoot: '/nonexistent-repo' })
    assert.equal(dir, join(outRoot, '2026-10-04'))
    assert.match(await readFile(join(dir, 'index.html'), 'utf8'), /acme@1\.0→1\.1/)
    assert.equal((await readFile(join(dir, `img/${H1}/home-1280-diff.png`))).toString(), 'diff')
    // VRT しなかった組の画像は取りに行かない
    assert.deepEqual((await readdir(join(dir, 'img'))).sort(), [H1, H3])
  })
  it('日付を指定すればその日を読む。結果が無ければ止める', async () => {
    const store = createFsStore(await mkdtemp(join(tmpdir(), 'store-')))
    const outRoot = await mkdtemp(join(tmpdir(), 'reports-'))
    await assert.rejects(runReport({ store, outRoot, repoRoot: '/nonexistent-repo', date: '2026-10-01' }), /2026-10-01 の結果が無い/)
  })
  it('日付の形が違えば止める', async () => {
    const store = createFsStore(await mkdtemp(join(tmpdir(), 'store-')))
    await assert.rejects(runReport({ store, outRoot: '/tmp', repoRoot: '/nonexistent-repo', date: '../etc' }), /日付/)
  })
})
