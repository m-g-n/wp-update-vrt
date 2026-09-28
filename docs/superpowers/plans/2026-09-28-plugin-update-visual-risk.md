# プラグイン更新の見栄えリスク判定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** managewp から受け取った「プラグイン × 旧版 × 新版」の組について、差分の静的解析と Jev で見栄えリスクを判定し、選んだものを WordPress Playground 上の単体 VRT で実測して、結果を非公開の R2 に毎日出す。

**Architecture:** GitHub Actions の日次ワークフローを3ジョブに分ける。prepare（収集・静的解析・Jev・スコア・選択。R2 は読むだけ）→ vrt（Playground＋Playwright。secret なし）→ publish（R2 へ書く唯一のジョブ）。各段は `work/` のファイルだけで受け渡す。ログには件数とキーのハッシュしか出さない。

**Tech Stack:** Node.js 22（ESM・`node:test`）、`@wp-playground/cli` 3.1.x、`playwright`、`pixelmatch`＋`pngjs`、`php-parser`、`acorn`＋`acorn-jsx`、`postcss`＋`postcss-selector-parser`、`diff`、`adm-zip`、`@aws-sdk/client-s3`（R2）、TypeSafe Jev API。

**Spec:** `docs/superpowers/specs/2026-09-28-plugin-update-visual-risk-design.md`

## Global Constraints

- Node.js 22 以上。`"type": "module"`。テストは `node --test`。コードはセミコロンなし・シングルクォート・2スペース（wp-vuln-hub と同じ書き方）
- キーは `slug@from→to`。ログ・画像パス・アーティファクトのファイル名に出してよいのは `keyHash()`（16桁の16進）だけ
- ログは必ず `src/lib/log.mjs` の `log()` / `reportFatal()` を通す。`console.log` を直接呼ばない。`err.message` をログに出さない
- Jev: `POST https://api.typesafe.ai/v1/systemone`、`model: "jev-latest"`、Noul の答えは `answers[id].noul`（0〜1、confidence なし）。401 は全体を止める。429 / 529 は指数バックオフで最大3回まで再試行
- Jev に渡す state は、コメントを取り除いた差分の塊だけ。readme / changelog は渡さない
- VRT 環境: WordPress は `latest`、PHP `8.2`、テーマは `twentytwentyfive`、幅は `1280` と `375`
- VRT ジョブに secret を渡さない。R2 に書くのは publish ジョブだけ。prepare は読み取り専用のキーを使う
- 結果に「保守先由来か定点観測由来か」を書かない
- 形式は `schema_version: 1` の名前付きオブジェクト。変えるときは新リポジトリを先に出し、managewp を後に出す
- キューと当日の結果ファイルは上書きせず、前回の分に足す
- cron の分をキリ番（:00 / :10 / :30 …）にしない
- アーティファクトの保持期間は1日
- 初期値は `src/score/policy.mjs` にまとめる: T=0.3、抜き取り 10% / 2%、1日の VRT 上限 30件、塊の上限 40、差分率の最小値 0.001、定点観測 300件、VRT の試行上限 3回

## Review Focus

1. **有効化時に何かを出力するプラグイン** — Playground の PHP 実行結果に余計な文字が混ざっても、JSON を取り違えずに読めること（Task 12 の `parseMarked` のテスト）
2. **zip の構造が想定と違う（先頭のフォルダがスラッグと違う・空）** — その組だけ `skipped: unreadable_zip` になり、全体は止まらないこと（Task 13 のテスト）
3. **Jev が1日じゅう 529 を返す** — 全件が `jev.error` 付きになり、強制で VRT に回る件は増えないこと（Task 13 のテスト）
4. **同じ日に2回実行する** — 当日の結果ファイルが上書きされず、1回目の記録が残ること（Task 14 のテスト）
5. **エラーの経路からのスラッグ漏れ** — ダウンロード失敗などの例外メッセージにスラッグが含まれても、ログに出ないこと（Task 1 の `reportFatal` のテストと、Task 13 の漏れテスト）

---

## ファイル構成

```
wp-update-vrt/
  package.json / .gitignore / README.md / CLAUDE.md
  .github/workflows/test.yml       … push と PR でテスト（単体＋VRT 結合）
  .github/workflows/daily.yml      … 日次の3ジョブ＋失敗通知
  docs/update-candidates-format.md / result-format.md / labels-format.md
  src/lib/key.mjs                  … makeKey / keyHash / sampleUnit
  src/lib/log.mjs                  … log / setLogSink / reportFatal（漏れ防止）
  src/lib/errors.mjs               … ContractError / GuardError
  src/lib/date.mjs                 … todayJst
  src/lib/work.mjs                 … work ディレクトリの読み書き
  src/contracts/candidates.mjs / result.mjs / labels.mjs
  src/collect/wporg.mjs            … zip の取得と展開
  src/collect/popular.mjs            … 人気プラグインの定点観測
  src/collect/candidates.mjs       … managewp / ローカルファイルからの入力
  src/signals/sanitize.mjs         … コメント除去（PHP / JS / CSS）
  src/signals/classify.mjs         … ファイル種別・admin 判定
  src/signals/css.mjs              … セレクタ名と宣言の抽出
  src/signals/index.mjs            … computeSignals
  src/jev/client.mjs / questions.mjs / run.mjs
  src/score/policy.mjs / score.mjs
  src/select/select.mjs            … 区分・抜き取り・優先順
  src/state/queue.mjs / store.mjs  … キュー操作・fs / R2 ストア
  src/vrt/compare.mjs              … 画像比較と判定
  src/vrt/playground.mjs           … 起動・PHP 実行・プラグインの導入
  src/vrt/pages.mjs                … テストページの生成
  src/vrt/capture.mjs              … 撮影（外部通信の遮断・アニメ停止）
  src/vrt/run.mjs                  … 1件の VRT
  src/notify/slack.mjs
  src/cli/prepare.mjs / vrt.mjs / publish.mjs / notify-failure.mjs
  test/**/*.test.mjs               … 単体テスト
  test-vrt/vrt.test.mjs            … Playground＋Chromium の結合テスト
  test/helpers/tree.mjs            … テスト用のファイルツリー・zip
```

---

### Task 1: リポジトリの土台・キー・漏れ防止ログ

**Files:**
- Create: `package.json`, `.gitignore`, `README.md`, `.github/workflows/test.yml`
- Create: `src/lib/key.mjs`, `src/lib/log.mjs`, `src/lib/errors.mjs`, `src/lib/date.mjs`
- Test: `test/lib.test.mjs`

**Interfaces:**
- Produces: `makeKey({slug, from, to}) → string`、`keyHash(key) → string(16 hex)`、`sampleUnit(key) → number [0,1)`、`log(event, fields)`、`setLogSink(fn) → prevFn`、`reportFatal(stage, err)`、`class ContractError`、`class GuardError(code)`（`err.code`）、`todayJst(now?) → 'YYYY-MM-DD'`

- [ ] **Step 1: package.json と .gitignore を作る**

```json
{
  "name": "wp-update-vrt",
  "version": "0.1.0",
  "private": true,
  "license": "UNLICENSED",
  "type": "module",
  "description": "WordPress プラグイン更新の見栄えリスク判定（Jev＋Playground VRT）",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "node --test 'test/**/*.test.mjs'",
    "test:vrt": "node --test --test-timeout=600000 'test-vrt/**/*.test.mjs'",
    "prepare-stage": "node src/cli/prepare.mjs",
    "vrt-stage": "node src/cli/vrt.mjs",
    "publish-stage": "node src/cli/publish.mjs"
  }
}
```

`.gitignore`:

```
node_modules/
work/
.local-store/
local-candidates.json
*.zip
```

- [ ] **Step 2: 失敗するテストを書く**

`test/lib.test.mjs`:

```js
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { makeKey, keyHash, sampleUnit } from '../src/lib/key.mjs'
import { log, setLogSink, reportFatal } from '../src/lib/log.mjs'
import { GuardError } from '../src/lib/errors.mjs'
import { todayJst } from '../src/lib/date.mjs'

const capture = (fn) => {
  const lines = []
  const prev = setLogSink((l) => lines.push(l))
  try { fn() } finally { setLogSink(prev) }
  return lines
}

describe('key', () => {
  it('キーはスラッグと新旧バージョンから作る', () => {
    assert.equal(makeKey({ slug: 'acme', from: '1.0', to: '1.1' }), 'acme@1.0→1.1')
  })
  it('keyHash は16桁の16進で、同じキーなら同じ値', () => {
    const h = keyHash('acme@1.0→1.1')
    assert.match(h, /^[0-9a-f]{16}$/)
    assert.equal(h, keyHash('acme@1.0→1.1'))
    assert.notEqual(h, keyHash('acme@1.0→1.2'))
  })
  it('sampleUnit は [0,1) で、同じキーなら同じ値', () => {
    const u = sampleUnit('acme@1.0→1.1')
    assert.ok(u >= 0 && u < 1)
    assert.equal(u, sampleUnit('acme@1.0→1.1'))
  })
})

describe('log', () => {
  it('数値・真偽値・null・ハッシュはそのまま出す', () => {
    const [line] = capture(() => log('stage_done', { n: 3, ok: true, x: null, key_hash: 'abcdef0123456789' }))
    assert.deepEqual(JSON.parse(line), { event: 'stage_done', n: 3, ok: true, x: null, key_hash: 'abcdef0123456789' })
  })
  it('それ以外の文字列は伏せる（スラッグやバージョンを出さない）', () => {
    const [line] = capture(() => log('stage_done', { slug: 'akismet', ver: '5.3.1' }))
    assert.ok(!line.includes('akismet'))
    assert.ok(!line.includes('5.3.1'))
  })
  it('イベント名に使えない文字が入っていたら伏せる', () => {
    const [line] = capture(() => log('acme@1.0→1.1'))
    assert.ok(!line.includes('acme'))
  })
  it('reportFatal はエラーメッセージを出さない', () => {
    const err = new Error('download failed for secret-plugin 9.8.7')
    const [line] = capture(() => reportFatal('prepare', err))
    assert.ok(!line.includes('secret-plugin'))
    assert.ok(!line.includes('9.8.7'))
    assert.equal(JSON.parse(line).event, 'prepare_failed')
  })
  it('reportFatal は GuardError の理由コードだけ別に出す', () => {
    const lines = capture(() => reportFatal('prepare', new GuardError('input_sudden_empty')))
    assert.equal(JSON.parse(lines[1]).event, 'guard_input_sudden_empty')
  })
})

describe('todayJst', () => {
  it('UTC 19:41 は JST の翌日', () => {
    assert.equal(todayJst(new Date('2026-09-28T19:41:00Z')), '2026-09-29')
  })
})
```

- [ ] **Step 3: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/lib/key.mjs'`）

- [ ] **Step 4: 実装する**

`src/lib/key.mjs`:

```js
import { createHash } from 'node:crypto'

// 処理の単位は「プラグイン × 更新前 × 更新後」。同じ更新が複数サイトで出ても1回だけ処理する
export function makeKey({ slug, from, to }) {
  return `${slug}@${from}→${to}`
}

// ログ・画像のパス・アーティファクトに出してよいのはこのハッシュだけ（公開リポジトリのため）
export function keyHash(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

// 抜き取りの判定に使う [0, 1) の値。キーが同じなら再実行しても同じ組が選ばれる
export function sampleUnit(key) {
  const hex = createHash('sha256').update(`sample:${key}`).digest('hex').slice(0, 8)
  return parseInt(hex, 16) / 0x100000000
}
```

`src/lib/errors.mjs`:

```js
export class ContractError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ContractError'
  }
}

// 空の結果を公開しないための停止。code はログに出るので、固定の語だけを使う
export class GuardError extends Error {
  constructor(code) {
    super(code)
    this.name = 'GuardError'
    this.code = code
  }
}
```

`src/lib/log.mjs`:

```js
import { GuardError } from './errors.mjs'

// 公開リポジトリの Actions ログは誰でも読める。
// スラッグやバージョンが出ないよう、出せる値を型で絞る（数値・真偽値・null・キーのハッシュだけ）
const HASH_RE = /^[0-9a-f]{16}$/
const EVENT_RE = /^[a-z][a-z0-9_]{0,60}$/

let sink = (line) => console.log(line)

export function setLogSink(fn) {
  const prev = sink
  sink = fn
  return prev
}

function safe(value) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string' && HASH_RE.test(value)) return value
  return '[redacted]'
}

export function log(event, fields = {}) {
  const out = { event: EVENT_RE.test(event) ? event : 'redacted_event' }
  for (const [k, v] of Object.entries(fields)) out[k] = safe(v)
  sink(JSON.stringify(out))
}

// err.message にはスラッグや URL が入りうるので出さない
export function reportFatal(stage, err) {
  log(`${stage}_failed`, { status: typeof err?.status === 'number' ? err.status : null })
  if (err instanceof GuardError) log(`guard_${err.code}`)
}
```

`src/lib/date.mjs`:

```js
// 日次の区切りは日本時間（JST 04:41 に動くので、UTC の日付だと前日になる）
export function todayJst(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10)
}
```

`README.md`:

```markdown
# wp-update-vrt

WordPress プラグインの更新について、差分の静的解析と Jev で見栄えリスクを判定し、
選んだものを WordPress Playground 上の単体 VRT で実測する。結果は managewp が取り込む。

設計: `docs/superpowers/specs/2026-09-28-plugin-update-visual-risk-design.md`
```

`.github/workflows/test.yml`:

```yaml
name: test
on:
  push:
  pull_request:
permissions:
  contents: read
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm test
```

- [ ] **Step 5: 通ることを確認する**

Run: `npm install && npm test`
Expected: PASS（`lib.test.mjs` の全件）。`npm install` で `package-lock.json` ができる

- [ ] **Step 6: コミット**

```bash
git add package.json package-lock.json .gitignore README.md .github/workflows/test.yml src/lib test/lib.test.mjs
git commit -m "feat: リポジトリの土台とキー・漏れ防止ログを追加"
```

---

### Task 2: managewp との受け渡し契約

**Files:**
- Create: `src/contracts/candidates.mjs`, `src/contracts/result.mjs`, `src/contracts/labels.mjs`
- Create: `docs/update-candidates-format.md`, `docs/result-format.md`, `docs/labels-format.md`
- Test: `test/contracts.test.mjs`

**Interfaces:**
- Consumes: `ContractError`（Task 1）
- Produces: `parseCandidates(json) → [{slug, from, to}]`、`RESULT_SCHEMA_VERSION`、`RESULT_FIELDS`、`VRT_STATUSES`、`buildResultRecord(parts) → record`、`vrtPlaceholder(status, reason) → vrt`、`buildResultFile(date, records) → {schema_version, date, records}`、`parseLabels(json) → [{key, label, labeled_at}]`

- [ ] **Step 1: 失敗するテストを書く**

`test/contracts.test.mjs`:

```js
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseCandidates } from '../src/contracts/candidates.mjs'
import { RESULT_FIELDS, buildResultRecord, vrtPlaceholder, buildResultFile } from '../src/contracts/result.mjs'
import { parseLabels } from '../src/contracts/labels.mjs'
import { ContractError } from '../src/lib/errors.mjs'

/**
 * この3本は managewp との契約。項目を変えるとこのテストが落ちる。
 * 落ちたら docs/*-format.md と managewp 側の取り込みを同時に直し、schema_version を上げること。
 * 出す順番は、このリポジトリが先、managewp が後。
 */
describe('parseCandidates', () => {
  it('重複と from==to を除く', () => {
    const items = parseCandidates({ schema_version: 1, items: [
      { slug: 'acme', from: '1.0', to: '1.1' },
      { slug: 'acme', from: '1.0', to: '1.1' },
      { slug: 'same', from: '2.0', to: '2.0' },
    ] })
    assert.deepEqual(items, [{ slug: 'acme', from: '1.0', to: '1.1' }])
  })
  it('schema_version が違えば投げる', () => {
    assert.throws(() => parseCandidates({ schema_version: 2, items: [] }), ContractError)
  })
  it('スラッグやバージョンに使えない文字があれば投げる', () => {
    assert.throws(() => parseCandidates({ schema_version: 1, items: [{ slug: '../x', from: '1', to: '2' }] }), ContractError)
    assert.throws(() => parseCandidates({ schema_version: 1, items: [{ slug: 'x', from: '1 ; rm', to: '2' }] }), ContractError)
  })
  it('サイトの情報など余計な項目は捨てる', () => {
    const [item] = parseCandidates({ schema_version: 1, items: [{ slug: 'acme', from: '1', to: '2', site: 'example.com' }] })
    assert.deepEqual(Object.keys(item), ['slug', 'from', 'to'])
  })
})

describe('result', () => {
  it('項目の集合と順番を固定する', () => {
    assert.deepEqual(RESULT_FIELDS, [
      'key', 'key_hash', 'slug', 'from', 'to', 'signals', 'jev',
      'risk_score_static', 'risk_score', 'p_visual', 'policy_version',
      'theme_override_risk', 'selection', 'vrt',
    ])
  })
  it('vrt の項目を固定する', () => {
    assert.deepEqual(Object.keys(vrtPlaceholder('queued', null)), [
      'status', 'reason', 'env', 'noise_floor', 'pages', 'errors_new', 'vrt_changed',
    ])
  })
  it('足りない項目があれば投げ、余計な項目は捨てる', () => {
    const parts = Object.fromEntries(RESULT_FIELDS.map((f) => [f, null]))
    parts.vrt = vrtPlaceholder('skipped', 'not_selected')
    assert.deepEqual(Object.keys(buildResultRecord({ ...parts, source: 'maintained' })), RESULT_FIELDS)
    const { key, ...missing } = parts
    assert.throws(() => buildResultRecord(missing), ContractError)
  })
  it('vrt.status が語彙に無ければ投げる', () => {
    const parts = Object.fromEntries(RESULT_FIELDS.map((f) => [f, null]))
    parts.vrt = { ...vrtPlaceholder('done', null), status: 'ok' }
    assert.throws(() => buildResultRecord(parts), ContractError)
  })
  it('結果ファイルは schema_version を持つ', () => {
    assert.deepEqual(buildResultFile('2026-09-29', []), { schema_version: 1, date: '2026-09-29', records: [] })
  })
})

describe('parseLabels', () => {
  it('語彙と日付の形を検査する', () => {
    const labels = parseLabels({ schema_version: 1, labels: [{ key: 'acme@1→2', label: 'regression', labeled_at: '2026-10-03', by: 'someone' }] })
    assert.deepEqual(labels, [{ key: 'acme@1→2', label: 'regression', labeled_at: '2026-10-03' }])
    assert.throws(() => parseLabels({ schema_version: 1, labels: [{ key: 'k', label: 'broken', labeled_at: '2026-10-03' }] }), ContractError)
    assert.throws(() => parseLabels({ schema_version: 1, labels: [{ key: 'k', label: 'none', labeled_at: '10/03' }] }), ContractError)
  })
})
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/contracts/candidates.mjs'`）

- [ ] **Step 3: 実装する**

`src/contracts/candidates.mjs`:

```js
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
```

`src/contracts/result.mjs`:

```js
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
```

`src/contracts/labels.mjs`:

```js
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
```

`docs/update-candidates-format.md`:

````markdown
# 更新待ちの組（managewp → wp-update-vrt、日次）

managewp が、保守先で更新待ちになっているプラグインの組を返す。**サイトの情報は含めない。**

```json
{
  "schema_version": 1,
  "generated_at": "2026-09-28T19:00:00Z",
  "items": [{ "slug": "contact-form-7", "from": "5.9.8", "to": "6.0.1" }]
}
```

- `slug`: `^[a-z0-9][a-z0-9-]*$`
- `from` / `to`: `^[0-9A-Za-z][0-9A-Za-z.+-]*$`
- 重複と `from == to` は wp-update-vrt 側でも除く
- 取得はトークン認証（`Authorization: Bearer <token>`）。URL とトークンは Actions の secret
- 形式を変えるときは `schema_version` を上げ、wp-update-vrt を先に出す
````

`docs/result-format.md`:

````markdown
# 結果（wp-update-vrt → managewp、日次）

非公開の R2 バケットに置く。managewp は読み取り専用のキーで取得する。

- `results/latest.json`: `{ "schema_version": 1, "date": "YYYY-MM-DD", "path": "results/YYYY-MM-DD.json" }`
- `results/YYYY-MM-DD.json`: `{ "schema_version": 1, "date": "YYYY-MM-DD", "records": [ ... ] }`
- `img/{key_hash}/{page}-{width}-{old|new|diff}.png`

同じ日に2回実行した場合、当日のファイルは上書きせず `key` 単位で足す。managewp は `key` で upsert する。

## record

| 項目 | 内容 |
|---|---|
| `key` | `slug@from→to` |
| `key_hash` | `key` の sha256 の先頭16桁 |
| `slug` / `from` / `to` | |
| `signals` | 静的な信号（WordPress.org に無い組では `null`） |
| `jev` | `emits_markup` / `runs_on_front` / `mutates_dom` / `js_front_dom`（Noul の値。confidence は無い）、`model`、`hunks_sent`、`error`、`large_diff` |
| `risk_score_static` / `risk_score` | 0〜1。較正前なので確率ではない |
| `p_visual` | spec 1 では常に `null` |
| `policy_version` | 重みの版 |
| `theme_override_risk` | `{ "selectors_removed": [".btn", "#hero"] }` |
| `selection` | `{ "stratum": "forced|above|sample|sample_version_only", "rate": 0.1 }` |
| `vrt` | 下記 |

## vrt

| 項目 | 内容 |
|---|---|
| `status` | `done` / `skipped` / `no_surface` / `failed` / `flaky` / `queued` |
| `reason` | `not_selected` / `not_on_wporg` / `unreadable_zip` / `vrt_failed` / `null` |
| `env` | `{ "wp": "7.1.2", "php": "8.2", "theme": "twentytwentyfive" }` |
| `noise_floor` | 旧版を2回撮った差分率の最大値 |
| `pages` | `[{ "page": "home|post|shortcodes|blocks", "width": 1280, "diff_ratio": 0.0123, "images": { "old": "img/…", "new": "img/…", "diff": "img/…" } }]` |
| `errors_new` | `{ "php": ["PHP Warning: …"], "js": ["…"] }`（新版で増えたもの） |
| `vrt_changed` | `true` / `false`。`flaky` のときは `null` |

保守先由来か定点観測由来かは書かない。
````

`docs/labels-format.md`:

````markdown
# 正解データ（managewp → wp-update-vrt、月次）

```json
{
  "schema_version": 1,
  "labels": [{ "key": "contact-form-7@5.9.8→6.0.1", "label": "regression", "labeled_at": "2026-10-03" }]
}
```

- `label`: `none`（変化なし）/ `intended`（意図した変更）/ `regression`（崩れ）
- 付けた人の名前は含めない
- spec 1 では形式の検査だけを実装する。較正での利用は spec 2
````

- [ ] **Step 4: 通ることを確認する**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/contracts docs/*-format.md test/contracts.test.mjs
git commit -m "feat: managewp との受け渡し形式（入力・結果・正解データ）を追加"
```

---

### Task 3: WordPress.org からの zip 取得と展開

**Files:**
- Create: `src/collect/wporg.mjs`, `test/helpers/tree.mjs`
- Test: `test/wporg.test.mjs`

**Interfaces:**
- Produces: `zipUrl(slug, version) → string`、`fetchZip(slug, version, {fetchImpl, timeoutMs}) → Promise<Buffer>`（404 は `NotOnWporgError`）、`readTree(zipBuffer, slug) → Map<string, Buffer>`、`class NotOnWporgError`
- Produces (test helper): `makeZip(slug, files) → Buffer`、`tree(files) → Map<string, Buffer>`（`files` は `{ 'path': 'content' }`）

- [ ] **Step 1: 依存を入れる**

Run: `npm install adm-zip@0.6`

- [ ] **Step 2: テスト用ヘルパーを書く**

`test/helpers/tree.mjs`:

```js
import AdmZip from 'adm-zip'

export function tree(files) {
  return new Map(Object.entries(files).map(([p, c]) => [p, Buffer.from(c)]))
}

// WordPress.org の配布 zip と同じく、先頭に `slug/` を付けて固める
export function makeZip(slug, files) {
  const zip = new AdmZip()
  for (const [p, c] of Object.entries(files)) zip.addFile(`${slug}/${p}`, Buffer.from(c))
  return zip.toBuffer()
}
```

- [ ] **Step 3: 失敗するテストを書く**

`test/wporg.test.mjs`:

```js
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import AdmZip from 'adm-zip'

import { zipUrl, fetchZip, readTree, NotOnWporgError } from '../src/collect/wporg.mjs'
import { makeZip } from './helpers/tree.mjs'

describe('zipUrl', () => {
  it('配布 URL を組む', () => {
    assert.equal(zipUrl('contact-form-7', '6.1.7'), 'https://downloads.wordpress.org/plugin/contact-form-7.6.1.7.zip')
  })
})

describe('fetchZip', () => {
  it('404 は NotOnWporgError', async () => {
    const fetchImpl = async () => new Response('nf', { status: 404 })
    await assert.rejects(fetchZip('x', '1.0', { fetchImpl }), NotOnWporgError)
  })
  it('500 は普通のエラー（翌日に再試行させる）', async () => {
    const fetchImpl = async () => new Response('err', { status: 500 })
    await assert.rejects(fetchZip('x', '1.0', { fetchImpl }), (err) => !(err instanceof NotOnWporgError))
  })
  it('200 なら中身を Buffer で返す', async () => {
    const zip = makeZip('x', { 'x.php': '<?php' })
    const fetchImpl = async () => new Response(zip, { status: 200 })
    assert.equal((await fetchZip('x', '1.0', { fetchImpl })).length, zip.length)
  })
})

describe('readTree', () => {
  it('先頭の slug/ を外した Map にする', () => {
    const t = readTree(makeZip('acme', { 'acme.php': '<?php', 'css/a.css': '.a{}' }), 'acme')
    assert.deepEqual([...t.keys()].sort(), ['acme.php', 'css/a.css'])
    assert.equal(t.get('css/a.css').toString(), '.a{}')
  })
  it('.. を含むパスがあれば投げる', () => {
    const zip = new AdmZip()
    zip.addFile('acme/ok.php', Buffer.from('<?php'))
    zip.getEntries()[0].entryName = 'acme/../evil.php'
    assert.throws(() => readTree(zip.toBuffer(), 'acme'))
  })
  it('slug のフォルダが無ければ投げる', () => {
    assert.throws(() => readTree(makeZip('other', { 'a.php': '<?php' }), 'acme'))
  })
})
```

- [ ] **Step 4: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/collect/wporg.mjs'`）

- [ ] **Step 5: 実装する**

`src/collect/wporg.mjs`:

```js
import AdmZip from 'adm-zip'

export class NotOnWporgError extends Error {
  constructor() {
    super('not_on_wporg')
    this.name = 'NotOnWporgError'
  }
}

const MAX_ZIP_BYTES = 50 * 1024 * 1024
const MAX_TREE_BYTES = 200 * 1024 * 1024

export function zipUrl(slug, version) {
  return `https://downloads.wordpress.org/plugin/${encodeURIComponent(slug)}.${encodeURIComponent(version)}.zip`
}

// 存在しない版・有料版は 404 になる（2026-09-28 に実測）
export async function fetchZip(slug, version, { fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  const res = await fetchImpl(zipUrl(slug, version), { signal: AbortSignal.timeout(timeoutMs) })
  if (res.status === 404) throw new NotOnWporgError()
  if (!res.ok) throw new Error(`zip の取得に失敗 (HTTP ${res.status})`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_ZIP_BYTES) throw new Error('zip が大きすぎる')
  return buf
}

// zip を Map<プラグイン内の相対パス, Buffer> にする。展開前に宣言サイズで上限を見る（zip 爆弾対策）
export function readTree(zipBuffer, slug) {
  const zip = new AdmZip(zipBuffer)
  const prefix = `${slug}/`
  const out = new Map()
  let total = 0
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const name = entry.entryName.replace(/\\/g, '/')
    if (name.startsWith('/') || name.split('/').includes('..')) throw new Error('zip に不正なパスがある')
    if (!name.startsWith(prefix)) continue
    total += entry.header.size
    if (total > MAX_TREE_BYTES) throw new Error('展開後のサイズが大きすぎる')
    out.set(name.slice(prefix.length), entry.getData())
  }
  if (out.size === 0) throw new Error('zip にプラグインのファイルが無い')
  return out
}
```

- [ ] **Step 6: 通ることを確認する**

Run: `npm test`
Expected: PASS。`.. を含むパス` のテストは `addFile` の後で `entryName` を書き換えている。adm-zip 0.6 は `addFile('acme/../evil.php')` だと `..` を取り除いてしまうが、`entryName` を後から書き換えれば `..` 入りのまま書き出される（2026-09-28 に確認）

- [ ] **Step 7: コミット**

```bash
git add package.json package-lock.json src/collect/wporg.mjs test/helpers/tree.mjs test/wporg.test.mjs
git commit -m "feat: WordPress.org から新旧の zip を取得・展開する"
```

---

### Task 4: 人気プラグインの定点観測

**Files:**
- Create: `src/collect/popular.mjs`
- Test: `test/popular.test.mjs`

**Interfaces:**
- Produces: `fetchPopular(count, {fetchImpl}) → Promise<[{slug, version}]>`、`diffPopular(prevVersions: {slug: version}, current) → {items: [{slug, from, to}], next: {slug: version}}`

- [ ] **Step 1: 失敗するテストを書く**

`test/popular.test.mjs`:

```js
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { fetchPopular, diffPopular } from '../src/collect/popular.mjs'

describe('diffPopular', () => {
  it('前回と版が違うものだけを更新とみなす', () => {
    const { items, next } = diffPopular({ a: '1.0', b: '2.0' }, [{ slug: 'a', version: '1.1' }, { slug: 'b', version: '2.0' }])
    assert.deepEqual(items, [{ slug: 'a', from: '1.0', to: '1.1' }])
    assert.deepEqual(next, { a: '1.1', b: '2.0' })
  })
  it('初めて見たスラッグは記録だけする（どこから上がったか分からないため）', () => {
    const { items, next } = diffPopular({}, [{ slug: 'c', version: '3.0' }])
    assert.deepEqual(items, [])
    assert.deepEqual(next, { c: '3.0' })
  })
  it('今回の一覧から落ちたスラッグも前回の版を残す（また上位に戻ったときに使う）', () => {
    const { next } = diffPopular({ gone: '1.0' }, [])
    assert.deepEqual(next, { gone: '1.0' })
  })
})

describe('fetchPopular', () => {
  it('ページをまたいで count 件まで集める', async () => {
    const pages = {
      1: { info: { pages: 2 }, plugins: Array.from({ length: 100 }, (_, i) => ({ slug: `p${i}`, version: '1.0' })) },
      2: { info: { pages: 2 }, plugins: [{ slug: 'q', version: '2.0' }] },
    }
    const urls = []
    const fetchImpl = async (url) => {
      urls.push(url)
      const page = Number(new URL(url).searchParams.get('request[page]'))
      return new Response(JSON.stringify(pages[page]), { status: 200 })
    }
    const got = await fetchPopular(101, { fetchImpl })
    assert.equal(got.length, 101)
    assert.deepEqual(got[100], { slug: 'q', version: '2.0' })
    assert.match(urls[0], /request\[browse\]=popular/)
  })
  it('HTTP エラーなら投げる', async () => {
    const fetchImpl = async () => new Response('', { status: 503 })
    await assert.rejects(fetchPopular(10, { fetchImpl }))
  })
})
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/collect/popular.mjs'`）

- [ ] **Step 3: 実装する**

`src/collect/popular.mjs`:

```js
// 公開リポジトリのログやアーティファクトから「保守先が使っている古い版」を読み取られないよう、
// 保守先と関係のない人気プラグインの更新も毎日一緒に処理する（spec §8）
const POPULAR_API = 'https://api.wordpress.org/plugins/info/1.2/?action=query_plugins'
  + '&request[browse]=popular'
  + '&request[fields][description]=0&request[fields][sections]=0&request[fields][tags]=0'
  + '&request[fields][ratings]=0&request[fields][icons]=0&request[fields][banners]=0'
const PER_PAGE = 100

export async function fetchPopular(count, { fetchImpl = fetch } = {}) {
  const out = []
  for (let page = 1; out.length < count; page++) {
    const url = `${POPULAR_API}&request[per_page]=${PER_PAGE}&request[page]=${page}`
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`人気プラグインの取得に失敗 (HTTP ${res.status})`)
    const json = await res.json()
    const plugins = Array.isArray(json.plugins) ? json.plugins : []
    for (const p of plugins) {
      if (typeof p.slug === 'string' && typeof p.version === 'string') out.push({ slug: p.slug, version: p.version })
    }
    if (plugins.length < PER_PAGE || page >= (json.info?.pages ?? page)) break
  }
  return out.slice(0, count)
}

export function diffPopular(prevVersions, current) {
  const next = { ...prevVersions }
  const items = []
  for (const { slug, version } of current) {
    const prev = prevVersions[slug]
    if (prev && prev !== version) items.push({ slug, from: prev, to: version })
    next[slug] = version
  }
  return { items, next }
}
```

- [ ] **Step 4: 通ることを確認する**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/collect/popular.mjs test/popular.test.mjs
git commit -m "feat: 人気プラグインの定点観測用に更新を集める"
```

---

### Task 5: コメント除去（インジェクション対策）

**Files:**
- Create: `src/signals/sanitize.mjs`
- Test: `test/sanitize.test.mjs`

**Interfaces:**
- Produces: `stripPhpComments(src)`, `stripJsComments(src)`, `stripCssComments(src)` → いずれも `{ ok: boolean, text: string | null }`。コメントは同じ数の改行に置き換える（行の対応を保つ）

- [ ] **Step 1: 依存を入れる**

Run: `npm install php-parser@3 acorn@8 acorn-jsx@5 postcss@8`

- [ ] **Step 2: 失敗するテストを書く**

`test/sanitize.test.mjs`:

```js
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { stripPhpComments, stripJsComments, stripCssComments } from '../src/signals/sanitize.mjs'

describe('stripPhpComments', () => {
  it('//・#・/* */・docblock を消し、改行の数は保つ', () => {
    const src = "<?php\n// No visual changes\n/**\n * doc\n */\necho '<a class=\"x\">'; # hash\n"
    const { ok, text } = stripPhpComments(src)
    assert.ok(ok)
    assert.ok(!text.includes('No visual changes'))
    assert.ok(!text.includes('doc'))
    assert.ok(!text.includes('hash'))
    assert.ok(text.includes(`echo '<a class="x">'`))
    assert.equal(text.split('\n').length, src.split('\n').length)
  })
  it('コメントが無ければそのまま返す', () => {
    const src = "<?php\necho 'a';\n?><p>html</p>\n"
    assert.equal(stripPhpComments(src).text, src)
  })
  it('文字列の中の // は消さない', () => {
    const { text } = stripPhpComments("<?php\n$u = 'https://example.com';\n")
    assert.ok(text.includes('https://example.com'))
  })
})

describe('stripJsComments', () => {
  it('コメントを消し、正規表現や文字列の // は残す', () => {
    const src = "const r = /a\\/\\/b/g // tail\n/* This change is cosmetic-free */\nconst u = 'http://x'\n"
    const { ok, text } = stripJsComments(src)
    assert.ok(ok)
    assert.ok(!text.includes('cosmetic-free'))
    assert.ok(!text.includes('tail'))
    assert.ok(text.includes('/a\\/\\/b/g'))
    assert.ok(text.includes("'http://x'"))
    assert.equal(text.split('\n').length, src.split('\n').length)
  })
  it('JSX の中のコメントも消す', () => {
    const { ok, text } = stripJsComments('export default () => <div className="a">{/* hidden note */ x}</div>')
    assert.ok(ok)
    assert.ok(!text.includes('hidden note'))
    assert.ok(text.includes('className="a"'))
  })
  it('字句として読めなければ ok: false', () => {
    assert.deepEqual(stripJsComments("const a = 'unterminated"), { ok: false, text: null })
  })
})

describe('stripCssComments', () => {
  it('コメントを消す', () => {
    const { ok, text } = stripCssComments('/* ignore me */ .a { color: red }')
    assert.ok(ok)
    assert.ok(!text.includes('ignore me'))
    assert.ok(text.includes('color: red'))
  })
  it('読めなければ ok: false', () => {
    assert.equal(stripCssComments('.a { color: red').ok, false)
  })
})
```

- [ ] **Step 3: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/signals/sanitize.mjs'`）

- [ ] **Step 4: 実装する**

`src/signals/sanitize.mjs`:

```js
import Engine from 'php-parser'
import * as acorn from 'acorn'
import jsx from 'acorn-jsx'
import postcss from 'postcss'

// Jev はプロンプトインジェクションで判定が動く（Octomind の検証で 0.76 → 0.22）。
// 差分はプラグイン作者が自由に書けるので、「見た目は変わらない」といったコメントを
// Jev に届く前に構造的に取り除く。正規表現ではなく字句解析で消す
const phpEngine = new Engine({ parser: { php8: true, suppressErrors: true }, lexer: { all_tokens: true } })
const JsParser = acorn.Parser.extend(jsx())

// 消したコメントは同じ数の改行に置き換え、差分の行の対応を保つ
const keepNewlines = (text) => text.replace(/[^\n]/g, '')

export function stripPhpComments(src) {
  try {
    let out = ''
    for (const token of phpEngine.tokenGetAll(src)) {
      if (typeof token === 'string') {
        out += token
        continue
      }
      const [name, text] = token
      out += name === 'T_COMMENT' || name === 'T_DOC_COMMENT' ? keepNewlines(text) : text
    }
    return { ok: true, text: out }
  } catch {
    return { ok: false, text: null }
  }
}

export function stripJsComments(src) {
  for (const sourceType of ['module', 'script']) {
    try {
      const comments = []
      const opts = { ecmaVersion: 'latest', sourceType, onComment: comments, allowHashBang: true }
      for (const _ of JsParser.tokenizer(src, opts)) { /* 最後まで読んでコメントを集める */ }
      let out = ''
      let pos = 0
      for (const c of comments) {
        out += src.slice(pos, c.start) + keepNewlines(src.slice(c.start, c.end))
        pos = c.end
      }
      return { ok: true, text: out + src.slice(pos) }
    } catch {
      // module で読めなければ script で試す
    }
  }
  return { ok: false, text: null }
}

export function stripCssComments(src) {
  try {
    const root = postcss.parse(src)
    root.walkComments((c) => c.remove())
    return { ok: true, text: root.toString() }
  } catch {
    return { ok: false, text: null }
  }
}
```

- [ ] **Step 5: 通ることを確認する**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add package.json package-lock.json src/signals/sanitize.mjs test/sanitize.test.mjs
git commit -m "feat: Jev に渡す前に PHP・JS・CSS のコメントを字句解析で取り除く"
```

---

### Task 6: 静的な信号

**Files:**
- Create: `src/signals/classify.mjs`, `src/signals/css.mjs`, `src/signals/index.mjs`
- Test: `test/signals.test.mjs`

**Interfaces:**
- Consumes: `stripPhpComments` / `stripJsComments` / `stripCssComments`（Task 5）、`tree()`（Task 3 のヘルパー）
- Produces: `fileKind(path) → 'php'|'js'|'css'|'asset'|'block_json'|'ignored'|'other'`、`isAdminPath(path) → boolean`、`cssFacts(text) → {names: Set, decls: Set}`、`computeSignals(oldTree, newTree, {from, to}) → { signals, hunks: { php: [{path, text}], js: [{path, text}] } }`

`signals` の形（以降のタスクはこれに依存する）:

```js
{
  version_only: boolean,
  files_changed: number,
  css_decl_changes: number,
  selectors_removed: string[],        // ['.btn', '#hero']
  assets_changed: number,
  registrations_diff: { blocks_changed: string[], shortcodes_added: string[], shortcodes_removed: string[] },
  js_changed: { front: number, admin: number },
  php_output_hunks: number,           // 塊の上限超えぶんも含む
  unsanitized_files: number,
  oversized_hunks: number,
}
```

- [ ] **Step 1: 依存を入れる**

Run: `npm install postcss-selector-parser@7 diff@9`

- [ ] **Step 2: 失敗するテストを書く**

`test/signals.test.mjs`:

```js
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { fileKind, isAdminPath } from '../src/signals/classify.mjs'
import { computeSignals } from '../src/signals/index.mjs'
import { tree } from './helpers/tree.mjs'

const V = { from: '1.0.0', to: '1.0.1' }
const header = (v) => `<?php\n/**\n * Plugin Name: Acme\n * Version: ${v}\n */\nwp_enqueue_style('acme', 'a.css', [], '${v}');\n`

describe('fileKind / isAdminPath', () => {
  it('種別を分ける', () => {
    assert.equal(fileKind('readme.txt'), 'ignored')
    assert.equal(fileKind('languages/acme-ja.po'), 'ignored')
    assert.equal(fileKind('inc/render.php'), 'php')
    assert.equal(fileKind('build/index.js'), 'js')
    assert.equal(fileKind('src/edit.jsx'), 'js')
    assert.equal(fileKind('assets/a.css'), 'css')
    assert.equal(fileKind('assets/logo.svg'), 'asset')
    assert.equal(fileKind('blocks/card/block.json'), 'block_json')
    assert.equal(fileKind('src/style.scss'), 'other')
  })
  it('admin 用の JS をパスで見分ける', () => {
    assert.equal(isAdminPath('admin/js/settings.js'), true)
    assert.equal(isAdminPath('assets/js/admin.js'), true)
    assert.equal(isAdminPath('assets/js/acme-admin.min.js'), true)
    assert.equal(isAdminPath('assets/js/frontend.js'), false)
    assert.equal(isAdminPath('js/badminton.js'), false)
  })
})

describe('computeSignals', () => {
  it('バージョン番号と readme だけの変更は version_only', () => {
    const { signals } = computeSignals(
      tree({ 'acme.php': header('1.0.0'), 'readme.txt': 'Stable tag: 1.0.0' }),
      tree({ 'acme.php': header('1.0.1'), 'readme.txt': 'Stable tag: 1.0.1\n= 1.0.1 =\n* fix' }),
      V,
    )
    assert.equal(signals.version_only, true)
    assert.equal(signals.files_changed, 0)
  })
  it('コメントだけの変更も version_only', () => {
    const { signals } = computeSignals(
      tree({ 'acme.php': "<?php\n// old note\necho 'a';\n" }),
      tree({ 'acme.php': "<?php\n// new note, much longer\necho 'a';\n" }),
      V,
    )
    assert.equal(signals.version_only, true)
  })
  it('CSS の宣言の変更を数える', () => {
    const { signals } = computeSignals(
      tree({ 'a.css': '.a { color: red } .b { margin: 0 }' }),
      tree({ 'a.css': '.a { color: blue } .b { margin: 0 }' }),
      V,
    )
    assert.equal(signals.version_only, false)
    assert.equal(signals.css_decl_changes, 2)
  })
  it('消えたクラス名・ID を出す（別ファイルへ移っただけなら出さない）', () => {
    const { signals } = computeSignals(
      tree({ 'a.css': '.btn { color: red } #hero { margin: 0 } .moved { top: 0 }' }),
      tree({ 'a.css': '#hero { margin: 0 }', 'b.css': '.moved { top: 0 }' }),
      V,
    )
    assert.deepEqual(signals.selectors_removed, ['.btn'])
  })
  it('HTML を出力する PHP の塊だけを Jev 行きにし、コメントは含めない', () => {
    const { signals, hunks } = computeSignals(
      tree({ 'r.php': "<?php\nfunction r() {\n  $x = 1;\n  echo '<a class=\"btn\">';\n}\n" }),
      tree({ 'r.php': "<?php\nfunction r() {\n  $x = 2;\n  // No visual changes in this release\n  echo '<a class=\"btn-new\">';\n}\n" }),
      V,
    )
    assert.equal(signals.php_output_hunks, 1)
    assert.equal(hunks.php.length, 1)
    assert.match(hunks.php[0].text, /btn-new/)
    assert.ok(!hunks.php[0].text.includes('No visual changes'))
  })
  it('出力に関係しない PHP の変更は Jev に送らない', () => {
    const { signals, hunks } = computeSignals(
      tree({ 'l.php': "<?php\n$limit = 10;\n" }),
      tree({ 'l.php': "<?php\n$limit = 20;\n" }),
      V,
    )
    assert.equal(signals.php_output_hunks, 0)
    assert.equal(hunks.php.length, 0)
    assert.equal(signals.version_only, false)
  })
  it('admin 用の JS は数えるが Jev には送らない', () => {
    const { signals, hunks } = computeSignals(
      tree({ 'admin/js/s.js': 'a()', 'js/front.js': 'b()' }),
      tree({ 'admin/js/s.js': 'a(1)', 'js/front.js': 'b(1)' }),
      V,
    )
    assert.deepEqual(signals.js_changed, { front: 1, admin: 1 })
    assert.deepEqual(hunks.js.map((h) => h.path), ['js/front.js'])
  })
  it('.min.js は元のファイルがあれば Jev に送らない', () => {
    const { hunks } = computeSignals(
      tree({ 'js/a.js': 'a()', 'js/a.min.js': 'a()' }),
      tree({ 'js/a.js': 'a(1)', 'js/a.min.js': 'a(1)' }),
      V,
    )
    assert.deepEqual(hunks.js.map((h) => h.path), ['js/a.js'])
  })
  it('block.json の attributes の変更はブロック登録の差として出し、version だけなら出さない', () => {
    const oldJ = JSON.stringify({ name: 'acme/card', version: '1.0.0', attributes: { a: { type: 'string' } } })
    const verJ = JSON.stringify({ name: 'acme/card', version: '1.0.1', attributes: { a: { type: 'string' } } })
    const attrJ = JSON.stringify({ name: 'acme/card', version: '1.0.1', attributes: { a: { type: 'number' } } })
    assert.deepEqual(computeSignals(tree({ 'block.json': oldJ }), tree({ 'block.json': verJ }), V).signals.registrations_diff.blocks_changed, [])
    assert.deepEqual(computeSignals(tree({ 'block.json': oldJ }), tree({ 'block.json': attrJ }), V).signals.registrations_diff.blocks_changed, ['acme/card'])
  })
  it('ショートコードの増減を出す', () => {
    const { signals } = computeSignals(
      tree({ 'a.php': "<?php\nadd_shortcode('old_box', 'f');\n" }),
      tree({ 'a.php': "<?php\nadd_shortcode( \"new_box\", 'f' );\n" }),
      V,
    )
    assert.deepEqual(signals.registrations_diff.shortcodes_added, ['new_box'])
    assert.deepEqual(signals.registrations_diff.shortcodes_removed, ['old_box'])
  })
  it('コメントを取り除けないファイルは unsanitized_files に数える', () => {
    const { signals, hunks } = computeSignals(
      tree({ 'js/a.js': 'a()' }),
      tree({ 'js/a.js': "const s = 'unterminated" }),
      V,
    )
    assert.equal(signals.unsanitized_files, 1)
    assert.equal(hunks.js.length, 0)
  })
  it('画像の変更を数える', () => {
    const { signals } = computeSignals(tree({ 'i/a.png': 'x' }), tree({ 'i/a.png': 'y', 'i/b.svg': '<svg/>' }), V)
    assert.equal(signals.assets_changed, 2)
  })
})
```

- [ ] **Step 3: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/signals/classify.mjs'`）

- [ ] **Step 4: 実装する**

`src/signals/classify.mjs`:

```js
// 表示に効かないファイル（説明・翻訳・ライセンス・ソースマップ）は比較の対象から外す。
// readme.txt は毎回 changelog が更新されるので、ここで外さないと version_only が成り立たない
const IGNORED = [
  /(^|\/)readme\.(txt|md)$/i,
  /(^|\/)changelog(\.[a-z]+)?$/i,
  /(^|\/)license(\.[a-z]+)?$/i,
  /^languages\//,
  /\.(pot|po|mo|map)$/i,
  /\.l10n\.php$/i,
]
const ASSET_RE = /\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot)$/i

export function fileKind(path) {
  if (IGNORED.some((re) => re.test(path))) return 'ignored'
  if (/(^|\/)block\.json$/.test(path)) return 'block_json'
  if (/\.php$/i.test(path)) return 'php'
  if (/\.(m|c)?jsx?$/i.test(path)) return 'js'
  if (/\.css$/i.test(path)) return 'css'
  if (ASSET_RE.test(path)) return 'asset'
  return 'other'
}

export function isAdminPath(path) {
  return /(^|\/)(admin|wp-admin|backend|dashboard)(\/|[-_.])/i.test(path) || /[-_.]admin[-_.]/i.test(path)
}
```

`src/signals/css.mjs`:

```js
import postcss from 'postcss'
import selectorParser from 'postcss-selector-parser'

// names: セレクタに出てくるクラス名と ID（テーマ側の上書き CSS が参照しうるもの）
// decls: 「@規則|セレクタ{プロパティ:値}」の集合。新旧の対称差を「変わった宣言の数」とみなす
export function cssFacts(text) {
  const root = postcss.parse(text)
  const names = new Set()
  const decls = new Set()
  root.walkRules((rule) => {
    try {
      selectorParser((sel) => {
        sel.walkClasses((c) => names.add(`.${c.value}`))
        sel.walkIds((i) => names.add(`#${i.value}`))
      }).processSync(rule.selector)
    } catch {
      // 読めないセレクタは数えない
    }
    const ctx = rule.parent?.type === 'atrule' ? `@${rule.parent.name} ${rule.parent.params}|` : ''
    rule.walkDecls((d) => decls.add(`${ctx}${rule.selector}{${d.prop}:${d.value}${d.important ? '!important' : ''}}`))
  })
  return { names, decls }
}
```

`src/signals/index.mjs`:

```js
import { createHash } from 'node:crypto'
import { structuredPatch } from 'diff'

import { fileKind, isAdminPath } from './classify.mjs'
import { stripPhpComments, stripJsComments, stripCssComments } from './sanitize.mjs'
import { cssFacts } from './css.mjs'

// 変更行にこれが含まれる PHP の塊だけを「HTML 出力に関わるかもしれない」とみなして Jev に送る
const OUTPUT_RE = /\becho\b|\bprint\b|\bprintf\b|\?>|<\/?[a-zA-Z]|\b_e\(|\besc_html_e\(|\besc_attr_e\(/
const SHORTCODE_RE = /add_shortcode\(\s*['"]([^'"]+)['"]/g
// block.json のうち見た目に効く項目。version だけの変更は数えない
const BLOCK_KEYS = ['attributes', 'supports', 'style', 'editorStyle', 'viewStyle', 'render', 'viewScript', 'viewScriptModule']
const HUNK_CONTEXT = 2
const MAX_HUNK_CHARS = 4000

const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const symmetricDiffSize = (a, b) => [...a].filter((x) => !b.has(x)).length + [...b].filter((x) => !a.has(x)).length

function sanitize(kind, text) {
  if (kind === 'php') return stripPhpComments(text)
  if (kind === 'js') return stripJsComments(text)
  if (kind === 'css') return stripCssComments(text)
  return { ok: true, text }
}

// バージョン文字列の違い・行末の空白・空行を消してから比べる
function normalize(text, from, to) {
  return text
    .replace(new RegExp(escapeRe(from), 'g'), to)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
    .join('\n')
}

function changedHunks(path, oldText, newText) {
  const patch = structuredPatch(path, path, oldText, newText, '', '', { context: HUNK_CONTEXT })
  return patch.hunks.map((h) => ({
    path,
    text: h.lines.join('\n'),
    changed: h.lines.filter((l) => l[0] === '+' || l[0] === '-').join('\n'),
  }))
}

function blockDef(buf) {
  try {
    const j = JSON.parse(buf.toString('utf8'))
    const pick = {}
    for (const k of BLOCK_KEYS) if (k in j) pick[k] = j[k]
    return { name: typeof j.name === 'string' ? j.name : null, sig: JSON.stringify(pick) }
  } catch {
    return { name: null, sig: 'unparsable' }
  }
}

function shortcodes(texts) {
  const set = new Set()
  for (const t of texts) for (const m of t.matchAll(SHORTCODE_RE)) set.add(m[1])
  return set
}

function hasUnminifiedSibling(path, t) {
  const m = path.match(/^(.*)\.min\.(js|css)$/)
  return Boolean(m && t.has(`${m[1]}.${m[2]}`))
}

export function computeSignals(oldTree, newTree, { from, to }) {
  const s = {
    version_only: false,
    files_changed: 0,
    css_decl_changes: 0,
    selectors_removed: [],
    assets_changed: 0,
    registrations_diff: { blocks_changed: [], shortcodes_added: [], shortcodes_removed: [] },
    js_changed: { front: 0, admin: 0 },
    php_output_hunks: 0,
    unsanitized_files: 0,
    oversized_hunks: 0,
  }
  const hunks = { php: [], js: [] }
  const oldNames = new Set()
  const newNames = new Set()
  const oldPhp = []
  const newPhp = []
  const pushHunk = (list, h) => {
    if (h.text.length > MAX_HUNK_CHARS) s.oversized_hunks++
    else list.push({ path: h.path, text: h.text })
  }

  const paths = [...new Set([...oldTree.keys(), ...newTree.keys()])].sort()
  for (const path of paths) {
    const kind = fileKind(path)
    if (kind === 'ignored') continue
    const a = oldTree.get(path)
    const b = newTree.get(path)

    if (kind === 'asset' || kind === 'other') {
      if (!a || !b || sha(a) !== sha(b)) {
        s.files_changed++
        if (kind === 'asset') s.assets_changed++
      }
      continue
    }

    if (kind === 'block_json') {
      const da = a ? blockDef(a) : { name: null, sig: null }
      const db = b ? blockDef(b) : { name: null, sig: null }
      if (da.sig !== db.sig) {
        s.files_changed++
        s.registrations_diff.blocks_changed.push(db.name ?? da.name ?? path)
      }
      continue
    }

    const sa = a ? sanitize(kind, a.toString('utf8')) : { ok: true, text: '' }
    const sb = b ? sanitize(kind, b.toString('utf8')) : { ok: true, text: '' }
    if (!sa.ok || !sb.ok) {
      s.unsanitized_files++
      s.files_changed++
      continue
    }

    let facts = null
    if (kind === 'css') {
      try {
        facts = { a: cssFacts(sa.text), b: cssFacts(sb.text) }
        for (const n of facts.a.names) oldNames.add(n)
        for (const n of facts.b.names) newNames.add(n)
      } catch {
        s.unsanitized_files++
        s.files_changed++
        continue
      }
    }
    if (kind === 'php') {
      oldPhp.push(sa.text)
      newPhp.push(sb.text)
    }

    const na = normalize(sa.text, from, to)
    const nb = normalize(sb.text, from, to)
    if (na === nb) continue
    s.files_changed++

    if (kind === 'css') {
      if (!hasUnminifiedSibling(path, newTree)) s.css_decl_changes += symmetricDiffSize(facts.a.decls, facts.b.decls)
      continue
    }
    if (kind === 'js') {
      if (isAdminPath(path)) {
        s.js_changed.admin++
        continue
      }
      if (hasUnminifiedSibling(path, newTree)) continue
      s.js_changed.front++
      for (const h of changedHunks(path, na, nb)) pushHunk(hunks.js, h)
      continue
    }
    // php
    for (const h of changedHunks(path, na, nb)) {
      if (!OUTPUT_RE.test(h.changed)) continue
      s.php_output_hunks++
      pushHunk(hunks.php, h)
    }
  }

  s.selectors_removed = [...oldNames].filter((n) => !newNames.has(n)).sort()
  const oldTags = shortcodes(oldPhp)
  const newTags = shortcodes(newPhp)
  s.registrations_diff.shortcodes_added = [...newTags].filter((t) => !oldTags.has(t)).sort()
  s.registrations_diff.shortcodes_removed = [...oldTags].filter((t) => !newTags.has(t)).sort()
  s.version_only = s.files_changed === 0
  return { signals: s, hunks }
}
```

- [ ] **Step 5: 通ることを確認する**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add package.json package-lock.json src/signals test/signals.test.mjs
git commit -m "feat: 差分から静的な信号と Jev 行きの塊を取り出す"
```

---

### Task 7: Jev クライアントと質問

**Files:**
- Create: `src/jev/client.mjs`, `src/jev/questions.mjs`, `src/jev/run.mjs`
- Test: `test/jev.test.mjs`

**Interfaces:**
- Consumes: `hunks`（Task 6 の `computeSignals` の戻り値）
- Produces: `createJevClient({apiKey, fetchImpl, sleep, maxRetries, timeoutMs}) → { ask(state, questions) → Promise<{model, answers}> }`、`class JevError(status)`（ネットワークは `status: 0`、応答の形が違うときは `-1`）、`QUESTIONS`、`runJev(hunks, client, {maxHunks}) → Promise<jev>`

`jev` の形:

```js
{ emits_markup: number|null, runs_on_front: number|null, mutates_dom: number|null, js_front_dom: number|null,
  model: string|null, hunks_sent: number, error: null|'network'|'bad_response'|'http_<status>', large_diff: boolean }
```

- [ ] **Step 1: 失敗するテストを書く**

`test/jev.test.mjs`:

```js
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createJevClient, JevError } from '../src/jev/client.mjs'
import { runJev } from '../src/jev/run.mjs'

const ok = (answers) => new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: {} }), { status: 200 })
const noSleep = async () => {}

describe('createJevClient', () => {
  it('公式の形でリクエストする', async () => {
    let seen
    const fetchImpl = async (url, init) => { seen = { url, init }; return ok({ q: { type: 'noul', noul: 0.9 } }) }
    const client = createJevClient({ apiKey: 'k', fetchImpl, sleep: noSleep })
    await client.ask({ file: 'a.php', diff: '+x' }, { q: { type: 'noul', instructions: 'i' } })
    assert.equal(seen.url, 'https://api.typesafe.ai/v1/systemone')
    assert.equal(seen.init.headers.Authorization, 'Bearer k')
    const body = JSON.parse(seen.init.body)
    assert.equal(body.model, 'jev-latest')
    assert.deepEqual(body.state, { file: 'a.php', diff: '+x' })
  })
  it('529 は再試行して成功すれば返す', async () => {
    let n = 0
    const fetchImpl = async () => (++n < 3 ? new Response('', { status: 529 }) : ok({}))
    const client = createJevClient({ apiKey: 'k', fetchImpl, sleep: noSleep })
    await client.ask('s', {})
    assert.equal(n, 3)
  })
  it('401 は再試行せずに投げる', async () => {
    let n = 0
    const fetchImpl = async () => { n++; return new Response('', { status: 401 }) }
    const client = createJevClient({ apiKey: 'k', fetchImpl, sleep: noSleep })
    await assert.rejects(client.ask('s', {}), (e) => e instanceof JevError && e.status === 401)
    assert.equal(n, 1)
  })
  it('鍵が無ければ作れない', () => {
    assert.throws(() => createJevClient({ apiKey: '' }))
  })
})

const fakeClient = (fn) => ({ calls: 0, async ask(state, questions) { this.calls++; return fn(state, questions) } })

describe('runJev', () => {
  const hunks = { php: [{ path: 'a.php', text: '+echo 1' }, { path: 'b.php', text: '+echo 2' }], js: [{ path: 'f.js', text: '+x()' }] }

  it('塊ごとの最大値をとり、JS は「公開ページで動く × DOM を変える」も出す', async () => {
    const client = fakeClient((state, q) => {
      if (q.emits_markup) return { model: 'jev-1.13.0', answers: { emits_markup: { noul: state.file === 'a.php' ? 0.2 : 0.8 } } }
      return { model: 'jev-1.13.0', answers: { runs_on_front: { noul: 0.5 }, mutates_dom: { noul: 0.6 } } }
    })
    const r = await runJev(hunks, client, { maxHunks: 40 })
    assert.equal(r.emits_markup, 0.8)
    assert.equal(r.runs_on_front, 0.5)
    assert.equal(r.mutates_dom, 0.6)
    assert.equal(r.js_front_dom, 0.3)
    assert.equal(r.hunks_sent, 3)
    assert.equal(r.model, 'jev-1.13.0')
    assert.equal(r.error, null)
  })
  it('塊が上限を超えたら聞かずに large_diff', async () => {
    const client = fakeClient(() => { throw new Error('呼ばれてはいけない') })
    const r = await runJev(hunks, client, { maxHunks: 2 })
    assert.equal(r.large_diff, true)
    assert.equal(client.calls, 0)
  })
  it('塊が無ければ聞かない', async () => {
    const client = fakeClient(() => { throw new Error('呼ばれてはいけない') })
    const r = await runJev({ php: [], js: [] }, client, { maxHunks: 40 })
    assert.equal(r.emits_markup, null)
    assert.equal(client.calls, 0)
  })
  it('再試行しても 529 なら値は null で error に残す', async () => {
    const client = fakeClient(() => { throw new JevError(529, 'x') })
    const r = await runJev(hunks, client, { maxHunks: 40 })
    assert.equal(r.error, 'http_529')
    assert.equal(r.emits_markup, null)
  })
  it('応答の形が違えば bad_response', async () => {
    const client = fakeClient(() => ({ model: 'm', answers: {} }))
    assert.equal((await runJev(hunks, client, { maxHunks: 40 })).error, 'bad_response')
  })
  it('401 は全体を止めるために投げ直す', async () => {
    const client = fakeClient(() => { throw new JevError(401, 'x') })
    await assert.rejects(runJev(hunks, client, { maxHunks: 40 }), (e) => e.status === 401)
  })
})
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/jev/client.mjs'`）

- [ ] **Step 3: 実装する**

`src/jev/client.mjs`:

```js
// API: https://docs.typesafe.ai/api（2026-09-28 に確認）
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODEL = 'jev-latest'
const RETRY_STATUSES = new Set([429, 529])

export class JevError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'JevError'
    this.status = status
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createJevClient({ apiKey, fetchImpl = fetch, sleep = defaultSleep, maxRetries = 3, timeoutMs = 30_000 }) {
  if (!apiKey) throw new Error('TYPESAFE_API_KEY が未設定')
  return {
    async ask(state, questions) {
      for (let attempt = 0; ; attempt++) {
        let res
        try {
          res = await fetchImpl(JEV_ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ state, model: JEV_MODEL, questions }),
            signal: AbortSignal.timeout(timeoutMs),
          })
        } catch {
          if (attempt >= maxRetries) throw new JevError(0, 'network')
          await sleep(1000 * 2 ** attempt)
          continue
        }
        if (res.ok) return await res.json()
        if (RETRY_STATUSES.has(res.status) && attempt < maxRetries) {
          await sleep(1000 * 2 ** attempt)
          continue
        }
        throw new JevError(res.status, `Jev HTTP ${res.status}`)
      }
    },
  }
}
```

`src/jev/questions.mjs`:

```js
// 質問は「安全か」ではなく「何が起きるか」の形にする。結論はコード側（score）が出す。
// 英語で書く（公式が英語で最高精度と明言している）
export const QUESTIONS = {
  emits_markup: {
    type: 'noul',
    instructions: 'Does this PHP code change alter the HTML markup, element structure, or CSS class/id names that the plugin outputs to public website visitors?',
    criteria: {
      true: 'Visitor-facing HTML, attributes, or class/id names change',
      false: 'Only internal logic, admin-only output, or no change to visitor-facing HTML',
    },
  },
  runs_on_front: {
    type: 'noul',
    instructions: 'Does this JavaScript run on public website pages, not only inside the WordPress admin dashboard or block editor?',
  },
  mutates_dom: {
    type: 'noul',
    instructions: 'Does this JavaScript change add, remove, move, or restyle page elements, inline styles, or CSS class names in the browser?',
  },
}
```

`src/jev/run.mjs`:

```js
import { JevError } from './client.mjs'
import { QUESTIONS } from './questions.mjs'

const max = (a, b) => (a === null ? b : Math.max(a, b))

function noul(res, id) {
  const v = res?.answers?.[id]?.noul
  if (typeof v !== 'number') throw new JevError(-1, 'bad_response')
  return v
}

// 差分の塊1つを1つの state にする（1問で大きく聞くと弱く、小さく分けると強い）
export async function runJev(hunks, client, { maxHunks }) {
  const base = {
    emits_markup: null, runs_on_front: null, mutates_dom: null, js_front_dom: null,
    model: null, hunks_sent: 0, error: null, large_diff: false,
  }
  const total = hunks.php.length + hunks.js.length
  if (total === 0) return base
  // 大きな書き換えは予測が当たりにくく費用も膨らむので、聞かずに VRT へ回す
  if (total > maxHunks) return { ...base, large_diff: true }

  const r = { ...base }
  try {
    for (const h of hunks.php) {
      const res = await client.ask({ file: h.path, diff: h.text }, { emits_markup: QUESTIONS.emits_markup })
      r.emits_markup = max(r.emits_markup, noul(res, 'emits_markup'))
      r.model = res.model ?? r.model
      r.hunks_sent++
    }
    for (const h of hunks.js) {
      const res = await client.ask(
        { file: h.path, diff: h.text },
        { runs_on_front: QUESTIONS.runs_on_front, mutates_dom: QUESTIONS.mutates_dom },
      )
      const front = noul(res, 'runs_on_front')
      const dom = noul(res, 'mutates_dom')
      r.runs_on_front = max(r.runs_on_front, front)
      r.mutates_dom = max(r.mutates_dom, dom)
      r.js_front_dom = max(r.js_front_dom, front * dom)
      r.model = res.model ?? r.model
      r.hunks_sent++
    }
  } catch (err) {
    if (!(err instanceof JevError) || err.status === 401) throw err
    const error = err.status === 0 ? 'network' : err.status === -1 ? 'bad_response' : `http_${err.status}`
    return { ...base, hunks_sent: r.hunks_sent, error }
  }
  return r
}
```

- [ ] **Step 4: 通ることを確認する**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/jev test/jev.test.mjs
git commit -m "feat: Jev に差分の塊ごとに小さな質問を投げる"
```

---

### Task 8: スコアと重み

**Files:**
- Create: `src/score/policy.mjs`, `src/score/score.mjs`
- Test: `test/score.test.mjs`

**Interfaces:**
- Consumes: `signals`（Task 6）、`jev`（Task 7）
- Produces: `policy.mjs` の定数（`POLICY_VERSION`, `THRESHOLD`, `SAMPLE_RATE`, `SAMPLE_RATE_VERSION_ONLY`, `DAILY_VRT_LIMIT`, `MAX_HUNKS`, `MIN_DIFF_RATIO`, `POPULAR_COUNT`, `MAX_ATTEMPTS`, `VERSION_ONLY_SCORE`, `WEIGHTS`, `CSS_SATURATION`, `PHP_SATURATION`）、`scoreStatic(signals) → number`、`scoreWithJev(signals, jev) → number`、`themeOverrideRisk(signals) → {selectors_removed}`、`hasRegistrations(registrations_diff) → boolean`

- [ ] **Step 1: 失敗するテストを書く**

`test/score.test.mjs`:

```js
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { scoreStatic, scoreWithJev, themeOverrideRisk, hasRegistrations } from '../src/score/score.mjs'
import { VERSION_ONLY_SCORE } from '../src/score/policy.mjs'

const empty = () => ({
  version_only: false, files_changed: 1, css_decl_changes: 0, selectors_removed: [], assets_changed: 0,
  registrations_diff: { blocks_changed: [], shortcodes_added: [], shortcodes_removed: [] },
  js_changed: { front: 0, admin: 0 }, php_output_hunks: 0, unsanitized_files: 0, oversized_hunks: 0,
})
const noJev = { emits_markup: null, runs_on_front: null, mutates_dom: null, js_front_dom: null, model: null, hunks_sent: 0, error: null, large_diff: false }

describe('score', () => {
  it('version_only は固定の低い値', () => {
    const s = { ...empty(), version_only: true, files_changed: 0 }
    assert.equal(scoreStatic(s), VERSION_ONLY_SCORE)
    assert.equal(scoreWithJev(s, noJev), VERSION_ONLY_SCORE)
  })
  it('何も効いていなければ 0', () => {
    assert.equal(scoreStatic(empty()), 0)
  })
  it('CSS の宣言が5つ以上変われば css の重みがそのまま出る', () => {
    assert.equal(scoreStatic({ ...empty(), css_decl_changes: 9 }), 0.6)
  })
  it('noisy-OR で合成する（どれか1つ効けば上がる）', () => {
    const s = { ...empty(), css_decl_changes: 5, assets_changed: 1 }
    assert.equal(scoreStatic(s), Math.round((1 - 0.4 * 0.7) * 1000) / 1000)
  })
  it('Jev の値があれば PHP の寄与を置き換える', () => {
    const s = { ...empty(), php_output_hunks: 3 }
    assert.equal(scoreStatic(s), 0.4)
    assert.equal(scoreWithJev(s, { ...noJev, emits_markup: 0.1 }), 0.07)
    assert.equal(scoreWithJev(s, { ...noJev, emits_markup: 1 }), 0.7)
  })
  it('Jev がエラーなら静的な値と同じ', () => {
    const s = { ...empty(), php_output_hunks: 3, js_changed: { front: 1, admin: 0 } }
    assert.equal(scoreWithJev(s, { ...noJev, error: 'http_529' }), scoreStatic(s))
  })
  it('消えたセレクタは合成に混ぜず別に出す', () => {
    const s = { ...empty(), selectors_removed: ['.btn'] }
    assert.equal(scoreStatic(s), 0)
    assert.deepEqual(themeOverrideRisk(s), { selectors_removed: ['.btn'] })
  })
  it('ブロック登録の差の有無', () => {
    assert.equal(hasRegistrations(empty().registrations_diff), false)
    assert.equal(hasRegistrations({ blocks_changed: [], shortcodes_added: ['x'], shortcodes_removed: [] }), true)
  })
})
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/score/score.mjs'`）

- [ ] **Step 3: 実装する**

`src/score/policy.mjs`:

```js
// 判定と選択の数字はここにだけ置く。値を変えたら POLICY_VERSION を上げる
// （結果にどの重みで出したかを残し、較正（spec 2）で版ごとに分けて見られるようにするため）
export const POLICY_VERSION = 1

// 初期はデータを貯めるのが目的なので、わざと低めにして VRT に多く回す
export const THRESHOLD = 0.3
// 閾値未満からの抜き取り。これが無いと見逃し率が測れない（spec §4.5）
export const SAMPLE_RATE = 0.1
export const SAMPLE_RATE_VERSION_ONLY = 0.02
// 実測で1件1分前後（2026-09-28）。公開リポジトリなので Actions の分数は無料
export const DAILY_VRT_LIMIT = 30
export const MAX_ATTEMPTS = 3
export const MAX_HUNKS = 40
// 0.1%。ノイズの床と併用する
export const MIN_DIFF_RATIO = 0.001
export const POPULAR_COUNT = 300

export const VERSION_ONLY_SCORE = 0.02
// 較正前の手置きの重み。spec 2 でデータから決まる値に置き換える
export const WEIGHTS = {
  css: 0.6,
  assets: 0.3,
  registrations: 0.7,
  js_static: 0.3,
  php_static: 0.4,
  php_jev: 0.7,
  js_jev: 0.6,
}
export const CSS_SATURATION = 5
export const PHP_SATURATION = 3
```

`src/score/score.mjs`:

```js
import { WEIGHTS, CSS_SATURATION, PHP_SATURATION, VERSION_ONLY_SCORE } from './policy.mjs'

const clamp01 = (x) => Math.min(1, Math.max(0, x))
const round = (x) => Math.round(x * 1000) / 1000
// どれか1つが効けば上がる合成。parts は [重み, 0〜1 の強さ]
const noisyOr = (parts) => 1 - parts.reduce((acc, [w, x]) => acc * (1 - w * clamp01(x)), 1)

export function hasRegistrations(r) {
  return r.blocks_changed.length + r.shortcodes_added.length + r.shortcodes_removed.length > 0
}

function staticParts(s) {
  return {
    css: [WEIGHTS.css, s.css_decl_changes / CSS_SATURATION],
    assets: [WEIGHTS.assets, s.assets_changed > 0 ? 1 : 0],
    registrations: [WEIGHTS.registrations, hasRegistrations(s.registrations_diff) ? 1 : 0],
    js: [WEIGHTS.js_static, s.js_changed.front > 0 ? 1 : 0],
    php: [WEIGHTS.php_static, s.php_output_hunks / PHP_SATURATION],
  }
}

// 較正前の値は確率ではないので risk_score と呼ぶ（spec §4.4）
export function scoreStatic(s) {
  if (s.version_only) return VERSION_ONLY_SCORE
  return round(noisyOr(Object.values(staticParts(s))))
}

export function scoreWithJev(s, jev) {
  if (s.version_only) return VERSION_ONLY_SCORE
  const parts = staticParts(s)
  if (jev && !jev.error && !jev.large_diff) {
    if (jev.emits_markup !== null) parts.php = [WEIGHTS.php_jev, jev.emits_markup]
    if (jev.js_front_dom !== null) parts.js = [WEIGHTS.js_jev, jev.js_front_dom]
  }
  return round(noisyOr(Object.values(parts)))
}

// 単体 VRT では確かめられないので、VRT の結果に関係なく残る警告として別に出す
export function themeOverrideRisk(s) {
  return { selectors_removed: s.selectors_removed }
}
```

- [ ] **Step 4: 通ることを確認する**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/score test/score.test.mjs
git commit -m "feat: 静的な信号と Jev から risk_score を合成する"
```

---

### Task 9: VRT に回すものの選択とキュー

**Files:**
- Create: `src/select/select.mjs`, `src/state/queue.mjs`
- Test: `test/select.test.mjs`

**Interfaces:**
- Consumes: `sampleUnit`（Task 1）、`hasRegistrations` と policy の定数（Task 8）
- Produces: `stratumOf({signals, jev, risk_score}) → {stratum, rate}`、`isSelected(key, {rate}) → boolean`、`planVrt(entries, limit) → {run, rest}`、`mergeQueue(prev, additions) → queue`、`removeFromQueue(queue, keys) → queue`、`recordAttempt(queue, key) → {queue, exhausted}`

キューの1件の形: `{ key, key_hash, stratum, risk_score, first_queued: 'YYYY-MM-DD', attempts: number }`

- [ ] **Step 1: 失敗するテストを書く**

`test/select.test.mjs`:

```js
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { stratumOf, isSelected, planVrt } from '../src/select/select.mjs'
import { mergeQueue, removeFromQueue, recordAttempt } from '../src/state/queue.mjs'

const sig = (over = {}) => ({
  version_only: false, unsanitized_files: 0,
  registrations_diff: { blocks_changed: [], shortcodes_added: [], shortcodes_removed: [] },
  ...over,
})
const jev = (over = {}) => ({ large_diff: false, error: null, ...over })

describe('stratumOf', () => {
  it('強制・閾値超え・抜き取りを分ける', () => {
    assert.deepEqual(stratumOf({ signals: sig(), jev: jev({ large_diff: true }), risk_score: 0 }), { stratum: 'forced', rate: 1 })
    assert.equal(stratumOf({ signals: sig({ unsanitized_files: 1 }), jev: jev(), risk_score: 0 }).stratum, 'forced')
    assert.equal(stratumOf({ signals: sig({ registrations_diff: { blocks_changed: ['a/b'], shortcodes_added: [], shortcodes_removed: [] } }), jev: jev(), risk_score: 0 }).stratum, 'forced')
    assert.deepEqual(stratumOf({ signals: sig({ version_only: true }), jev: jev(), risk_score: 0.02 }), { stratum: 'sample_version_only', rate: 0.02 })
    assert.deepEqual(stratumOf({ signals: sig(), jev: jev(), risk_score: 0.3 }), { stratum: 'above', rate: 1 })
    assert.deepEqual(stratumOf({ signals: sig(), jev: jev(), risk_score: 0.29 }), { stratum: 'sample', rate: 0.1 })
  })
  it('Jev がエラーでも強制にはしない（止まった日に上限を使い切らないため）', () => {
    assert.equal(stratumOf({ signals: sig(), jev: jev({ error: 'http_529' }), risk_score: 0.1 }).stratum, 'sample')
  })
})

describe('isSelected', () => {
  it('同じキーなら毎回同じ結果', () => {
    assert.equal(isSelected('a@1→2', { rate: 0.1 }), isSelected('a@1→2', { rate: 0.1 }))
  })
  it('抜き取り率はおおむね rate になる', () => {
    let n = 0
    for (let i = 0; i < 10000; i++) if (isSelected(`p${i}@1→2`, { rate: 0.1 })) n++
    assert.ok(n > 800 && n < 1200, `n=${n}`)
  })
  it('rate 1 は必ず選ぶ', () => {
    assert.equal(isSelected('x@1→2', { rate: 1 }), true)
  })
})

describe('planVrt', () => {
  const e = (key_hash, stratum, risk_score, first_queued = '2026-09-29') => ({ key: key_hash, key_hash, stratum, risk_score, first_queued, attempts: 0 })
  it('強制 → 閾値超え（高い順）→ 抜き取り → 小さい抜き取り の順で上限まで', () => {
    const { run, rest } = planVrt([
      e('s', 'sample', 0.1), e('a1', 'above', 0.4), e('v', 'sample_version_only', 0.02), e('f', 'forced', 0), e('a2', 'above', 0.9),
    ], 3)
    assert.deepEqual(run.map((x) => x.key_hash), ['f', 'a2', 'a1'])
    assert.deepEqual(rest.map((x) => x.key_hash), ['s', 'v'])
  })
  it('同じ区分・同じスコアなら古い順', () => {
    const { run } = planVrt([e('new', 'above', 0.5, '2026-09-30'), e('old', 'above', 0.5, '2026-09-28')], 1)
    assert.equal(run[0].key_hash, 'old')
  })
})

describe('queue', () => {
  it('上書きせず足す。既にある件は前回の attempts を残す', () => {
    const prev = [{ key: 'a', attempts: 2 }]
    const q = mergeQueue(prev, [{ key: 'a', attempts: 0 }, { key: 'b', attempts: 0 }])
    assert.deepEqual(q, [{ key: 'a', attempts: 2 }, { key: 'b', attempts: 0 }])
  })
  it('空の追加で前回の分が消えない（同じ日の2回目は新規0件になるため）', () => {
    assert.deepEqual(mergeQueue([{ key: 'a', attempts: 0 }], []), [{ key: 'a', attempts: 0 }])
  })
  it('完了したものを外す', () => {
    assert.deepEqual(removeFromQueue([{ key: 'a' }, { key: 'b' }], ['a']), [{ key: 'b' }])
  })
  it('試行を数え、3回で打ち切る', () => {
    let q = [{ key: 'a', attempts: 1 }]
    let r = recordAttempt(q, 'a')
    assert.equal(r.exhausted, false)
    assert.equal(r.queue[0].attempts, 2)
    r = recordAttempt(r.queue, 'a')
    assert.equal(r.exhausted, true)
  })
})
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/select/select.mjs'`）

- [ ] **Step 3: 実装する**

`src/select/select.mjs`:

```js
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
```

`src/state/queue.mjs`:

```js
import { MAX_ATTEMPTS } from '../score/policy.mjs'

// キューは上書きせず前回の分に足す。
// wp-vuln-hub の X 投稿キューで、同じ日の2回目の実行（新規0件）が1回目の予定を消した事故と同じ構造を避ける
export function mergeQueue(prev, additions) {
  const byKey = new Map(prev.map((e) => [e.key, e]))
  for (const e of additions) if (!byKey.has(e.key)) byKey.set(e.key, e)
  return [...byKey.values()]
}

export function removeFromQueue(queue, keys) {
  const drop = new Set(keys)
  return queue.filter((e) => !drop.has(e.key))
}

export function recordAttempt(queue, key) {
  let exhausted = false
  const next = queue.map((e) => {
    if (e.key !== key) return e
    const attempts = (e.attempts ?? 0) + 1
    if (attempts >= MAX_ATTEMPTS) exhausted = true
    return { ...e, attempts }
  })
  return { queue: next, exhausted }
}
```

- [ ] **Step 4: 通ることを確認する**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/select src/state/queue.mjs test/select.test.mjs
git commit -m "feat: VRT に回す区分・抜き取り・優先順とキューを実装"
```

---

### Task 10: ストア（ローカルと R2）と work ディレクトリ

**Files:**
- Create: `src/state/store.mjs`, `src/lib/work.mjs`
- Test: `test/store.test.mjs`

**Interfaces:**
- Produces: ストアの共通インターフェース `{ getJSON(path, fallback), putJSON(path, obj), putFile(path, buf, contentType) }`、`createFsStore(root)`、`createR2Store({accountId, bucket, accessKeyId, secretAccessKey, client?})`、`storeFromEnv(env)`
- Produces: `readWorkJSON(workDir, rel, fallback?)`、`writeWorkJSON(workDir, rel, obj)`、`writeWorkFile(workDir, rel, buf)`、`readWorkFile(workDir, rel)`、`workExists(workDir, rel)`

- [ ] **Step 1: 依存を入れる**

Run: `npm install @aws-sdk/client-s3@3`

- [ ] **Step 2: 失敗するテストを書く**

`test/store.test.mjs`:

```js
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFsStore, createR2Store, storeFromEnv } from '../src/state/store.mjs'
import { readWorkJSON, writeWorkJSON } from '../src/lib/work.mjs'

describe('createFsStore', () => {
  it('無ければ fallback、書いたら読める', async () => {
    const store = createFsStore(await mkdtemp(join(tmpdir(), 'store-')))
    assert.deepEqual(await store.getJSON('state/queue.json', []), [])
    await store.putJSON('state/queue.json', [{ key: 'a' }])
    assert.deepEqual(await store.getJSON('state/queue.json', []), [{ key: 'a' }])
  })
  it('.. や絶対パスを拒む', async () => {
    const store = createFsStore(await mkdtemp(join(tmpdir(), 'store-')))
    await assert.rejects(store.putJSON('../x.json', {}))
    await assert.rejects(store.putJSON('/x.json', {}))
  })
})

describe('createR2Store', () => {
  it('NoSuchKey は fallback、put は Bucket と Key を渡す', async () => {
    const sent = []
    const client = {
      async send(cmd) {
        sent.push(cmd)
        if (cmd.constructor.name === 'GetObjectCommand') {
          const err = new Error('nf')
          err.name = 'NoSuchKey'
          throw err
        }
        return {}
      },
    }
    const store = createR2Store({ accountId: 'a', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', client })
    assert.deepEqual(await store.getJSON('state/q.json', []), [])
    await store.putJSON('state/q.json', [1])
    assert.equal(sent[1].input.Bucket, 'b')
    assert.equal(sent[1].input.Key, 'state/q.json')
    assert.equal(sent[1].input.ContentType, 'application/json')
  })
})

describe('storeFromEnv', () => {
  it('STORE_DIR があればローカル、R2 の設定が欠けていれば投げる', () => {
    assert.ok(storeFromEnv({ STORE_DIR: '/tmp/x' }))
    assert.throws(() => storeFromEnv({ R2_ACCOUNT_ID: 'a' }))
  })
})

describe('work', () => {
  it('書いたら読め、無ければ fallback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'work-'))
    await writeWorkJSON(dir, 'a/b.json', { x: 1 })
    assert.deepEqual(await readWorkJSON(dir, 'a/b.json'), { x: 1 })
    assert.equal(await readWorkJSON(dir, 'none.json', null), null)
  })
})
```

- [ ] **Step 3: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/state/store.mjs'`）

- [ ] **Step 4: 実装する**

`src/state/store.mjs`:

```js
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'

function safePath(p) {
  if (typeof p !== 'string' || p === '' || p.startsWith('/') || p.split('/').includes('..')) {
    throw new Error('ストアのパスが不正')
  }
  return p
}

// 開発とテスト用。本番は R2
export function createFsStore(root) {
  const full = (p) => join(root, safePath(p))
  const put = async (p, data) => {
    const f = full(p)
    await mkdir(dirname(f), { recursive: true })
    await writeFile(f, data)
  }
  return {
    async getJSON(p, fallback) {
      try {
        return JSON.parse(await readFile(full(p), 'utf8'))
      } catch (err) {
        if (err.code === 'ENOENT') return fallback
        throw err
      }
    },
    putJSON: (p, obj) => put(p, JSON.stringify(obj, null, 2)),
    putFile: (p, buf) => put(p, buf),
  }
}

// 結果は非公開のバケットに置く（公開リポジトリから読めないようにするため。spec §8）
export function createR2Store({ accountId, bucket, accessKeyId, secretAccessKey, client }) {
  const s3 = client ?? new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  })
  const put = (p, Body, ContentType) => s3.send(new PutObjectCommand({ Bucket: bucket, Key: safePath(p), Body, ContentType }))
  return {
    async getJSON(p, fallback) {
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: safePath(p) }))
        return JSON.parse(await res.Body.transformToString())
      } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return fallback
        throw err
      }
    },
    putJSON: (p, obj) => put(p, JSON.stringify(obj), 'application/json'),
    putFile: (p, buf, contentType) => put(p, buf, contentType),
  }
}

export function storeFromEnv(env = process.env) {
  if (env.STORE_DIR) return createFsStore(env.STORE_DIR)
  const need = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']
  const missing = need.filter((k) => !env[k])
  if (missing.length > 0) throw new Error(`ストアの設定が足りない: ${missing.join(', ')}`)
  return createR2Store({
    accountId: env.R2_ACCOUNT_ID,
    bucket: env.R2_BUCKET,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  })
}
```

`src/lib/work.mjs`:

```js
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// ジョブ間はこのディレクトリだけで受け渡す（Actions のアーティファクトになる。保持は1日）
export async function writeWorkFile(workDir, rel, data) {
  const f = join(workDir, rel)
  await mkdir(dirname(f), { recursive: true })
  await writeFile(f, data)
}

export const writeWorkJSON = (workDir, rel, obj) => writeWorkFile(workDir, rel, JSON.stringify(obj, null, 2))

export const readWorkFile = (workDir, rel) => readFile(join(workDir, rel))

export async function workExists(workDir, rel) {
  try {
    await access(join(workDir, rel))
    return true
  } catch {
    return false
  }
}

export async function readWorkJSON(workDir, rel, fallback) {
  try {
    return JSON.parse(await readFile(join(workDir, rel), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT' && arguments.length >= 3) return fallback
    throw err
  }
}
```

- [ ] **Step 5: 通ることを確認する**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add package.json package-lock.json src/state/store.mjs src/lib/work.mjs test/store.test.mjs
git commit -m "feat: ローカルと R2 のストア、ジョブ間の work ディレクトリを追加"
```

---

### Task 11: 画像の比較と VRT の判定

**Files:**
- Create: `src/vrt/compare.mjs`
- Test: `test/compare.test.mjs`

**Interfaces:**
- Consumes: `MIN_DIFF_RATIO`（Task 8）
- Produces: `comparePngs(bufA, bufB) → {ratio, diffPng: Buffer}`、`judge({noiseFloor, pages: [{diff_ratio}], hasSurface}) → {status: 'done'|'flaky'|'no_surface', vrt_changed: boolean|null}`

- [ ] **Step 1: 依存を入れる**

Run: `npm install pixelmatch@7 pngjs@7`

- [ ] **Step 2: 失敗するテストを書く**

`test/compare.test.mjs`:

```js
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PNG } from 'pngjs'

import { comparePngs, judge } from '../src/vrt/compare.mjs'

const png = (w, h, paint = () => [255, 255, 255, 255]) => {
  const p = new PNG({ width: w, height: h })
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4
    const [r, g, b, a] = paint(x, y)
    p.data[i] = r; p.data[i + 1] = g; p.data[i + 2] = b; p.data[i + 3] = a
  }
  return PNG.sync.write(p)
}

describe('comparePngs', () => {
  it('同じ画像なら 0', () => {
    assert.equal(comparePngs(png(10, 10), png(10, 10)).ratio, 0)
  })
  it('違う画素の割合を返す', () => {
    const b = png(10, 10, (x, y) => (x === 0 && y === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]))
    assert.equal(comparePngs(png(10, 10), b).ratio, 0.01)
  })
  it('高さが違えば、はみ出した部分を差分に数える', () => {
    const { ratio, diffPng } = comparePngs(png(10, 10), png(10, 20))
    assert.equal(ratio, 0.5)
    assert.equal(PNG.sync.read(diffPng).height, 20)
  })
})

describe('judge', () => {
  it('ノイズの床と 0.1% の大きいほうを超えたら変化あり', () => {
    assert.deepEqual(judge({ noiseFloor: 0, pages: [{ diff_ratio: 0.002 }], hasSurface: true }), { status: 'done', vrt_changed: true })
    assert.deepEqual(judge({ noiseFloor: 0, pages: [{ diff_ratio: 0.0005 }], hasSurface: true }), { status: 'done', vrt_changed: false })
  })
  it('床そのものが 0.1% を超えたら flaky（正解データにしない）', () => {
    assert.deepEqual(judge({ noiseFloor: 0.01, pages: [{ diff_ratio: 0.5 }], hasSurface: true }), { status: 'flaky', vrt_changed: null })
  })
  it('撮れる面がなく差分も無ければ no_surface', () => {
    assert.deepEqual(judge({ noiseFloor: 0, pages: [{ diff_ratio: 0 }], hasSurface: false }), { status: 'no_surface', vrt_changed: false })
  })
  it('撮れる面がなくても共通ページに差分があれば done', () => {
    assert.deepEqual(judge({ noiseFloor: 0, pages: [{ diff_ratio: 0.05 }], hasSurface: false }), { status: 'done', vrt_changed: true })
  })
})
```

- [ ] **Step 3: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/vrt/compare.mjs'`）

- [ ] **Step 4: 実装する**

`src/vrt/compare.mjs`:

```js
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

import { MIN_DIFF_RATIO } from '../score/policy.mjs'

// 小さいほうを透明の黒で広げる。ページの高さが変わった分は必ず差分に数える
function padTo(img, width, height) {
  if (img.width === width && img.height === height) return img
  const out = new PNG({ width, height })
  out.data.fill(0)
  PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0)
  return out
}

export function comparePngs(bufA, bufB) {
  const a = PNG.sync.read(bufA)
  const b = PNG.sync.read(bufB)
  const width = Math.max(a.width, b.width)
  const height = Math.max(a.height, b.height)
  const diff = new PNG({ width, height })
  const px = pixelmatch(padTo(a, width, height).data, padTo(b, width, height).data, diff.data, width, height, { threshold: 0.1 })
  return { ratio: px / (width * height), diffPng: PNG.sync.write(diff) }
}

// no_surface は正解データの対象から外す（「差分なし」が多すぎて較正が狂うのを防ぐ。spec §4.6）
export function judge({ noiseFloor, pages, hasSurface }) {
  if (noiseFloor > MIN_DIFF_RATIO) return { status: 'flaky', vrt_changed: null }
  const limit = Math.max(noiseFloor, MIN_DIFF_RATIO)
  const vrt_changed = pages.some((p) => p.diff_ratio > limit)
  if (!vrt_changed && !hasSurface) return { status: 'no_surface', vrt_changed: false }
  return { status: 'done', vrt_changed }
}
```

- [ ] **Step 5: 通ることを確認する**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add package.json package-lock.json src/vrt/compare.mjs test/compare.test.mjs
git commit -m "feat: スクリーンショットの差分率とノイズの床で VRT を判定する"
```

---

### Task 12: Playground での単体 VRT

**Files:**
- Create: `src/vrt/playground.mjs`, `src/vrt/pages.mjs`, `src/vrt/capture.mjs`, `src/vrt/run.mjs`
- Modify: `.github/workflows/test.yml`（VRT 結合テストのジョブを足す）
- Test: `test/playground.test.mjs`（単体）、`test-vrt/vrt.test.mjs`（結合）

**Interfaces:**
- Consumes: `comparePngs`, `judge`（Task 11）
- Produces: `parseMarked(text) → any`、`bootSite({port}) → {cli, env: {wp, php, theme}}`、`runPhp(site, body) → Promise<any>`（`body` の最後で `vrt_out($value)` を呼ぶ）、`installPlugin(site, zipBuffer) → Promise<string>`（プラグインファイル）、`coreShortcodes(site) → Promise<string[]>`、`createTestPages(site, browser, {coreTags}) → {pages: [{name, path}], hasSurface}`、`openCapturer(browser, serverUrl) → {shot(path, width) → Buffer, jsErrors: string[], close()}`、`WIDTHS`、`runVrt({oldZip, newZip}, {browser, port}) → Promise<vrtResult>`

`vrtResult` の形（`pages[].images` は Buffer。ファイルへの書き出しは Task 14）:

```js
{ status, reason: null, env, noise_floor, pages: [{ page, width, diff_ratio, images: { old, new, diff } }], errors_new: { php: [], js: [] }, vrt_changed }
```

2026-09-28 の実機確認（WP 7.1.2・PHP 8.2・`@wp-playground/cli` 3.1.56）で分かっている前提:
- `runCLI({ command: 'server', … })` は約7秒で起動し、`cli.playground.run({ code })` / `writeFile` / `mkdir` / `readFileAsText` / `fileExists` が使える
- `Plugin_Upgrader::install($zip, ['overwrite_package' => true])` で同じインスタンスのまま新版に上書きできる
- `login: true` だとエディタ（`/wp-admin/post-new.php`）が開け、`wp.blocks.createBlock` → `serialize` → `wp.apiFetch` で固定ページを保存できる
- `define-bool` / `define` で `WP_DEBUG_LOG` を指定すると PHP の警告がそのファイルに出る
- `pre_http_request` の mu-plugin で外部 HTTP を止められる。Twenty Twenty-Five は同梱されている

- [ ] **Step 1: 依存を入れる**

Run: `npm install @wp-playground/cli@3.1 playwright@1 && npx playwright install chromium`

- [ ] **Step 2: 失敗する単体テストを書く**

`test/playground.test.mjs`:

```js
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseMarked } from '../src/vrt/playground.mjs'

describe('parseMarked', () => {
  it('プラグインが先に何か出力していても、印の後の JSON だけを読む', () => {
    assert.deepEqual(parseMarked('Notice: hello from plugin\n<div>x</div>\n@@VRT@@{"ok":true}'), { ok: true })
  })
  it('印が複数あれば最後のものを使う', () => {
    assert.deepEqual(parseMarked('@@VRT@@{"a":1}\n@@VRT@@{"a":2}'), { a: 2 })
  })
  it('印が無ければ投げる', () => {
    assert.throws(() => parseMarked('Fatal error'))
  })
})
```

- [ ] **Step 3: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/vrt/playground.mjs'`）

- [ ] **Step 4: playground.mjs を実装する**

`src/vrt/playground.mjs`:

```js
import { runCLI } from '@wp-playground/cli'

export const PHP_VERSION = '8.2'
export const THEME = 'twentytwentyfive'
const DEBUG_LOG = '/tmp/wp-debug.log'
const MARK = '@@VRT@@'

// VRT 中は外部への HTTP を止め（再現性と安全のため）、管理バーを消す（訪問者の見た目にそろえる）
const MU_PLUGIN = `<?php
add_filter('pre_http_request', function ($pre, $args, $url) {
    $host = parse_url($url, PHP_URL_HOST);
    if (in_array($host, ['127.0.0.1', 'localhost'], true)) return $pre;
    return new WP_Error('vrt_blocked', 'external HTTP blocked');
}, 10, 3);
add_filter('show_admin_bar', '__return_false');
`

// プラグインが有効化時などに何かを出力しても取り違えないよう、印の後ろだけを読む
export function parseMarked(text) {
  const i = text.lastIndexOf(MARK)
  if (i < 0) throw new Error('PHP の実行結果に印が無い')
  return JSON.parse(text.slice(i + MARK.length))
}

export async function runPhp(site, body) {
  const code = `<?php
require '/wordpress/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/admin.php';
function vrt_out($v) { echo "\\n${MARK}" . json_encode($v); }
${body}`
  const res = await site.cli.playground.run({ code })
  return parseMarked(res.text)
}

export async function bootSite({ port }) {
  const cli = await runCLI({
    command: 'server',
    php: PHP_VERSION,
    wp: 'latest',
    login: true,
    port,
    verbosity: 'quiet',
    'define-bool': { WP_DEBUG: true, WP_DEBUG_DISPLAY: false },
    define: { WP_DEBUG_LOG: DEBUG_LOG },
  })
  const site = { cli, env: null }
  await cli.playground.mkdir('/wordpress/wp-content/mu-plugins')
  await cli.playground.writeFile('/wordpress/wp-content/mu-plugins/vrt-guard.php', MU_PLUGIN)
  site.env = await runPhp(site, `
if (wp_get_theme('${THEME}')->exists()) switch_theme('${THEME}');
vrt_out(['wp' => get_bloginfo('version'), 'php' => '${PHP_VERSION}', 'theme' => get_stylesheet()]);`)
  return site
}

// 旧版の導入と新版への更新は同じ手順。overwrite_package で上書きし、実サイトの更新と同じく更新時の処理も走らせる
export async function installPlugin(site, zipBuffer) {
  await site.cli.playground.writeFile('/tmp/vrt-plugin.zip', new Uint8Array(zipBuffer))
  const out = await runPhp(site, `
require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
$u = new Plugin_Upgrader(new Automatic_Upgrader_Skin());
$ok = $u->install('/tmp/vrt-plugin.zip', ['overwrite_package' => true]);
wp_clean_plugins_cache();
$file = $u->plugin_info();
$act = $file ? activate_plugin($file) : new WP_Error('no_plugin_file', '');
// unexpected_output は「有効化はできたが、その際に何か出力した」。実サイトでも有効なので成功として扱う
$err = is_wp_error($act) && $act->get_error_code() !== 'unexpected_output' ? $act->get_error_code() : null;
vrt_out(['ok' => $ok === true && is_plugin_active($file), 'file' => $file, 'error' => $err]);`)
  if (!out.ok || out.error) throw new Error(`プラグインを有効化できない (${out.error ?? 'install_failed'})`)
  return out.file
}

export async function coreShortcodes(site) {
  return runPhp(site, 'global $shortcode_tags; vrt_out(array_keys($shortcode_tags));')
}

export async function debugLogLength(site) {
  const pg = site.cli.playground
  return (await pg.fileExists(DEBUG_LOG)) ? (await pg.readFileAsText(DEBUG_LOG)).length : 0
}

export async function debugLogSince(site, offset) {
  const pg = site.cli.playground
  if (!(await pg.fileExists(DEBUG_LOG))) return []
  return (await pg.readFileAsText(DEBUG_LOG))
    .slice(offset)
    .split('\n')
    .filter((l) => /PHP (Warning|Fatal error|Parse error|Notice|Deprecated)/.test(l))
    .slice(0, 50)
    .map((l) => l.slice(0, 300))
}
```

- [ ] **Step 5: pages.mjs と capture.mjs を実装する**

`src/vrt/pages.mjs`:

```js
import { runPhp } from './playground.mjs'

// テストページは旧版で作り、新版でもそのまま表示する。
// 実サイトでも既存の記事は古い保存形式のまま残り、新しい CSS とレンダリングだけが効くため（spec §4.6）
export async function createTestPages(site, browser, { coreTags }) {
  const pages = [{ name: 'home', path: '/' }, { name: 'post', path: '/?p=1' }]

  const tags = (await runPhp(site, 'global $shortcode_tags; vrt_out(array_keys($shortcode_tags));'))
    .filter((t) => !coreTags.includes(t))
  if (tags.length > 0) {
    // 中身は PHP の文字列に埋め込まず、ファイル経由で渡す（$ などの展開を避ける）
    await site.cli.playground.writeFile('/tmp/vrt-shortcodes.txt', tags.map((t) => `[${t}]`).join('\n\n'))
    const id = await runPhp(site, `
vrt_out(wp_insert_post(['post_type' => 'page', 'post_status' => 'publish', 'post_title' => 'VRT shortcodes',
  'post_content' => file_get_contents('/tmp/vrt-shortcodes.txt')]));`)
    pages.push({ name: 'shortcodes', path: `/?page_id=${id}` })
  }

  const context = await browser.newContext()
  const page = await context.newPage()
  let made = { count: 0, id: null }
  try {
    await page.goto(`${site.cli.serverUrl}/wp-admin/post-new.php?post_type=page`, { waitUntil: 'load', timeout: 60_000 })
    await page.waitForFunction(() => window.wp?.blocks?.getBlockTypes?.().length > 0, null, { timeout: 60_000 })
    made = await page.evaluate(async () => {
      const blocks = []
      for (const type of window.wp.blocks.getBlockTypes()) {
        if (type.name.startsWith('core/')) continue
        try {
          blocks.push(window.wp.blocks.createBlock(type.name))
        } catch {
          // 既定の attributes で作れないブロックは飛ばす
        }
      }
      if (blocks.length === 0) return { count: 0, id: null }
      const res = await window.wp.apiFetch({
        path: '/wp/v2/pages',
        method: 'POST',
        data: { title: 'VRT blocks', content: window.wp.blocks.serialize(blocks), status: 'publish' },
      })
      return { count: blocks.length, id: res.id }
    })
  } finally {
    await context.close()
  }
  if (made.count > 0) pages.push({ name: 'blocks', path: `/?page_id=${made.id}` })

  return { pages, hasSurface: tags.length > 0 || made.count > 0 }
}
```

`src/vrt/capture.mjs`:

```js
export const WIDTHS = [1280, 375]
const MAX_HEIGHT = 10_000
const FREEZE_CSS = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'

const isLocal = (url) => {
  const { hostname } = new URL(url)
  return hostname === '127.0.0.1' || hostname === 'localhost'
}

export async function openCapturer(browser, serverUrl) {
  const context = await browser.newContext()
  // ブラウザ側でも外部への通信を止める（CDN のフォントや広告で揺れないように）
  await context.route('**/*', (route) => (isLocal(route.request().url()) ? route.continue() : route.abort()))
  const page = await context.newPage()
  const jsErrors = []
  page.on('pageerror', (e) => jsErrors.push(String(e.message).slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error') jsErrors.push(m.text().slice(0, 300))
  })
  return {
    jsErrors,
    async shot(path, width) {
      await page.setViewportSize({ width, height: 800 })
      await page.goto(serverUrl + path, { waitUntil: 'networkidle', timeout: 60_000 })
      await page.addStyleTag({ content: FREEZE_CSS })
      await page.evaluate(() => document.fonts.ready)
      const height = await page.evaluate(() => document.documentElement.scrollHeight)
      // 無限スクロールなどで極端に長いページは上から MAX_HEIGHT までにする
      if (height > MAX_HEIGHT) return page.screenshot({ fullPage: true, clip: { x: 0, y: 0, width, height: MAX_HEIGHT } })
      return page.screenshot({ fullPage: true })
    },
    close: () => context.close(),
  }
}
```

- [ ] **Step 6: run.mjs を実装する**

`src/vrt/run.mjs`:

```js
import { bootSite, installPlugin, coreShortcodes, debugLogLength, debugLogSince } from './playground.mjs'
import { createTestPages } from './pages.mjs'
import { openCapturer, WIDTHS } from './capture.mjs'
import { comparePngs, judge } from './compare.mjs'

const round6 = (x) => Math.round(x * 1e6) / 1e6

// 1つのインスタンスの中で旧版から新版に上げて比べる（spec §4.6）
export async function runVrt({ oldZip, newZip }, { browser, port }) {
  const site = await bootSite({ port })
  try {
    const coreTags = await coreShortcodes(site)
    await installPlugin(site, oldZip)
    const { pages, hasSurface } = await createTestPages(site, browser, { coreTags })
    const cap = await openCapturer(browser, site.cli.serverUrl)
    try {
      const before = new Map()
      const noise = []
      for (const p of pages) {
        for (const w of WIDTHS) {
          const first = await cap.shot(p.path, w)
          const second = await cap.shot(p.path, w)
          noise.push(comparePngs(first, second).ratio)
          before.set(`${p.name}-${w}`, first)
        }
      }
      const logOffset = await debugLogLength(site)
      const jsOffset = cap.jsErrors.length

      await installPlugin(site, newZip)

      const results = []
      for (const p of pages) {
        for (const w of WIDTHS) {
          const oldPng = before.get(`${p.name}-${w}`)
          const newPng = await cap.shot(p.path, w)
          const { ratio, diffPng } = comparePngs(oldPng, newPng)
          results.push({ page: p.name, width: w, diff_ratio: round6(ratio), images: { old: oldPng, new: newPng, diff: diffPng } })
        }
      }
      const noiseFloor = round6(Math.max(0, ...noise))
      const verdict = judge({ noiseFloor, pages: results, hasSurface })
      return {
        status: verdict.status,
        reason: null,
        env: site.env,
        noise_floor: noiseFloor,
        pages: results,
        errors_new: { php: await debugLogSince(site, logOffset), js: cap.jsErrors.slice(jsOffset) },
        vrt_changed: verdict.vrt_changed,
      }
    } finally {
      await cap.close()
    }
  } finally {
    await site.cli[Symbol.asyncDispose]()
  }
}
```

- [ ] **Step 7: 単体テストが通ることを確認する**

Run: `npm test`
Expected: PASS（`parseMarked` の3件）

- [ ] **Step 8: 結合テストを書く**

`test-vrt/vrt.test.mjs`:

```js
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { chromium } from 'playwright'

import { runVrt } from '../src/vrt/run.mjs'
import { makeZip } from '../test/helpers/tree.mjs'

// 色だけ変えたショートコードを出す架空のプラグイン。有効化時に出力する癖も入れておく（Review Focus 1）
const plugin = (version, color) => makeZip('vrt-fixture', {
  'vrt-fixture.php': `<?php
/**
 * Plugin Name: VRT Fixture
 * Version: ${version}
 */
register_activation_hook(__FILE__, function () { echo 'activated!'; });
add_shortcode('vrt_box', fn() => '<div class="vrt-box" style="width:200px;height:100px;background:${color}"></div>');
`,
})

describe('runVrt（Playground＋Chromium）', () => {
  let browser
  before(async () => {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined })
  })
  after(async () => {
    await browser?.close()
  })

  it('色を変えた更新は vrt_changed = true', async () => {
    const r = await runVrt({ oldZip: plugin('1.0.0', 'red'), newZip: plugin('1.1.0', 'blue') }, { browser, port: 9481 })
    assert.equal(r.status, 'done')
    assert.equal(r.vrt_changed, true)
    const sc = r.pages.find((p) => p.page === 'shortcodes' && p.width === 1280)
    assert.ok(sc.diff_ratio > 0.001)
    assert.equal(r.env.theme, 'twentytwentyfive')
  })

  it('中身が同じ更新は vrt_changed = false', async () => {
    const r = await runVrt({ oldZip: plugin('1.0.0', 'red'), newZip: plugin('1.0.1', 'red') }, { browser, port: 9482 })
    assert.equal(r.status, 'done')
    assert.equal(r.vrt_changed, false)
  })
})
```

- [ ] **Step 9: 結合テストを走らせる**

Run: `npm run test:vrt`
Expected: PASS（2件。1件あたり20〜60秒）。Chromium の版が合わずに起動できない場合は `npx playwright install chromium` をやり直すか、手元にある Chromium を `PLAYWRIGHT_CHROMIUM_EXECUTABLE` で指定する

- [ ] **Step 10: CI に結合テストのジョブを足す**

`.github/workflows/test.yml` の `jobs:` に追加する:

```yaml
  vrt:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run test:vrt
```

- [ ] **Step 11: コミット**

```bash
git add package.json package-lock.json src/vrt test/playground.test.mjs test-vrt .github/workflows/test.yml
git commit -m "feat: Playground で旧版→新版の単体 VRT を実行する"
```

---

### Task 13: prepare 段（収集・判定・選択）

**Files:**
- Create: `src/collect/candidates.mjs`, `src/cli/prepare.mjs`
- Test: `test/prepare.test.mjs`

**Interfaces:**
- Consumes: Task 1〜10 のすべて
- Produces: `fetchCandidatesFromManagewp({url, token, fetchImpl}) → Promise<items>`、`readCandidatesFile(path) → Promise<items>`、`runPrepare({store, fetchCandidates, jevClient, fetchImpl, today, workDir, limits}) → Promise<counts>`

`work/` に書くもの（Task 14 が読む）:

| パス | 中身 |
|---|---|
| `jobs.json` | `[{ key_hash }]`（今日 VRT を実行する組） |
| `zips/{key_hash}-old.zip` / `-new.zip` | VRT 用の zip |
| `pending/{key_hash}.json` | `vrt` 以外の項目がそろった結果（今日追加した分と、今日実行する分） |
| `records.json` | 今日確定した結果（未選択・スキップ） |
| `state-next.json` | `{ processed: [key], queue: [entry], additions: [key_hash], popular_versions, input_count }` |

prepare は R2 に書かない（書くのは publish だけ）。途中で落ちても、翌日に同じ組をもう一度処理するだけで済む。

- [ ] **Step 1: 失敗するテストを書く**

`test/prepare.test.mjs`:

```js
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runPrepare } from '../src/cli/prepare.mjs'
import { createFsStore } from '../src/state/store.mjs'
import { readWorkJSON } from '../src/lib/work.mjs'
import { setLogSink } from '../src/lib/log.mjs'
import { GuardError } from '../src/lib/errors.mjs'
import { JevError } from '../src/jev/client.mjs'
import { makeZip } from './helpers/tree.mjs'

const SECRET = 'secret-fixture-plugin'
const zips = {
  [`${SECRET}.9.8.7`]: makeZip(SECRET, { 'p.php': "<?php\necho '<a class=\"x\">';\n", 'a.css': '.x{color:red}' }),
  [`${SECRET}.9.8.8`]: makeZip(SECRET, { 'p.php': "<?php\necho '<a class=\"y\">';\n", 'a.css': '.y{color:blue}' }),
  'broken-plugin.1.0': makeZip('other-folder', { 'p.php': '<?php' }),
  'broken-plugin.1.1': makeZip('other-folder', { 'p.php': '<?php' }),
}

const fakeFetch = (popular = []) => async (url) => {
  if (url.includes('query_plugins')) return new Response(JSON.stringify({ info: { pages: 1 }, plugins: popular }), { status: 200 })
  const m = url.match(/plugin\/(.+)\.zip$/)
  const buf = m && zips[decodeURIComponent(m[1])]
  return buf ? new Response(buf, { status: 200 }) : new Response('nf', { status: 404 })
}
const jevOk = { async ask(state, q) {
  const answers = {}
  for (const id of Object.keys(q)) answers[id] = { type: 'noul', noul: 0.9 }
  return { model: 'jev-1.13.0', answers }
} }
const jevDown = { async ask() { throw new JevError(529, 'x') } }

async function setup() {
  const store = createFsStore(await mkdtemp(join(tmpdir(), 'store-')))
  const workDir = await mkdtemp(join(tmpdir(), 'work-'))
  return { store, workDir }
}

const base = (over) => ({
  fetchImpl: fakeFetch(),
  jevClient: jevOk,
  today: '2026-09-29',
  limits: { popularCount: 10, dailyLimit: 30 },
  ...over,
})

describe('runPrepare', () => {
  it('ログにスラッグもバージョンも出さない（Review Focus 5）', async () => {
    const { store, workDir } = await setup()
    const lines = []
    const prev = setLogSink((l) => lines.push(l))
    try {
      await runPrepare(base({ store, workDir, fetchCandidates: async () => [{ slug: SECRET, from: '9.8.7', to: '9.8.8' }] }))
    } finally {
      setLogSink(prev)
    }
    const all = lines.join('\n')
    assert.ok(lines.length > 0)
    assert.ok(!all.includes(SECRET))
    assert.ok(!all.includes('9.8.7'))
  })

  it('閾値を超えた組は jobs と zip と pending に入る', async () => {
    const { store, workDir } = await setup()
    await runPrepare(base({ store, workDir, fetchCandidates: async () => [{ slug: SECRET, from: '9.8.7', to: '9.8.8' }] }))
    const jobs = await readWorkJSON(workDir, 'jobs.json')
    assert.equal(jobs.length, 1)
    const pending = await readWorkJSON(workDir, `pending/${jobs[0].key_hash}.json`)
    assert.equal(pending.selection.stratum, 'above')
    assert.equal(pending.jev.model, 'jev-1.13.0')
    assert.ok(!('source' in pending))
  })

  it('WordPress.org に無い組は skipped: not_on_wporg として確定する', async () => {
    const { store, workDir } = await setup()
    await runPrepare(base({ store, workDir, fetchCandidates: async () => [{ slug: 'paid-plugin', from: '1.0', to: '1.1' }] }))
    const records = await readWorkJSON(workDir, 'records.json')
    assert.equal(records[0].vrt.status, 'skipped')
    assert.equal(records[0].vrt.reason, 'not_on_wporg')
    const next = await readWorkJSON(workDir, 'state-next.json')
    assert.ok(next.processed.includes('paid-plugin@1.0→1.1'))
  })

  it('zip の構造が違う組は unreadable_zip で確定し、全体は止まらない（Review Focus 2）', async () => {
    const { store, workDir } = await setup()
    await runPrepare(base({ store, workDir, fetchCandidates: async () => [
      { slug: 'broken-plugin', from: '1.0', to: '1.1' },
      { slug: SECRET, from: '9.8.7', to: '9.8.8' },
    ] }))
    const records = await readWorkJSON(workDir, 'records.json')
    assert.equal(records.find((r) => r.slug === 'broken-plugin').vrt.reason, 'unreadable_zip')
    assert.equal((await readWorkJSON(workDir, 'jobs.json')).length, 1)
  })

  it('Jev が止まっていても強制は増えず、静的なスコアで選ぶ（Review Focus 3）', async () => {
    const { store, workDir } = await setup()
    await runPrepare(base({ store, workDir, jevClient: jevDown, fetchCandidates: async () => [{ slug: SECRET, from: '9.8.7', to: '9.8.8' }] }))
    const [job] = await readWorkJSON(workDir, 'jobs.json')
    const pending = await readWorkJSON(workDir, `pending/${job.key_hash}.json`)
    assert.equal(pending.jev.error, 'http_529')
    assert.notEqual(pending.selection.stratum, 'forced')
    assert.equal(pending.risk_score, pending.risk_score_static)
  })

  it('入力が取れなければ止める', async () => {
    const { store, workDir } = await setup()
    await assert.rejects(runPrepare(base({ store, workDir, fetchCandidates: async () => { throw new Error('HTTP 500') } })))
  })

  it('前回5件以上あったのに急に0件なら止める', async () => {
    const { store, workDir } = await setup()
    await store.putJSON('state/last-input-count.json', { count: 12 })
    await assert.rejects(runPrepare(base({ store, workDir, fetchCandidates: async () => [] })), GuardError)
  })

  it('処理済み・キュー済みの組は取り直さない', async () => {
    const { store, workDir } = await setup()
    const key = `${SECRET}@9.8.7→9.8.8`
    await store.putJSON('state/processed.json', [key])
    const counts = await runPrepare(base({ store, workDir, fetchCandidates: async () => [{ slug: SECRET, from: '9.8.7', to: '9.8.8' }] }))
    assert.equal(counts.new, 0)
  })

  it('定点観測の組も同じ規則で処理し、結果には由来を書かない', async () => {
    const { store, workDir } = await setup()
    await store.putJSON('state/popular-versions.json', { [SECRET]: '9.8.7' })
    await runPrepare(base({ store, workDir, fetchImpl: fakeFetch([{ slug: SECRET, version: '9.8.8' }]), fetchCandidates: async () => [] }))
    const next = await readWorkJSON(workDir, 'state-next.json')
    assert.equal(next.popular_versions[SECRET], '9.8.8')
    assert.equal((await readWorkJSON(workDir, 'jobs.json')).length, 1)
  })
})
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/cli/prepare.mjs'`）

- [ ] **Step 3: 入力の取得を実装する**

`src/collect/candidates.mjs`:

```js
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
```

- [ ] **Step 4: prepare を実装する**

`src/cli/prepare.mjs`:

```js
import { pathToFileURL } from 'node:url'

import { makeKey, keyHash } from '../lib/key.mjs'
import { log, reportFatal } from '../lib/log.mjs'
import { GuardError } from '../lib/errors.mjs'
import { todayJst } from '../lib/date.mjs'
import { writeWorkJSON, writeWorkFile } from '../lib/work.mjs'
import { fetchZip, readTree, NotOnWporgError } from '../collect/wporg.mjs'
import { fetchPopular, diffPopular } from '../collect/popular.mjs'
import { fetchCandidatesFromManagewp, readCandidatesFile } from '../collect/candidates.mjs'
import { computeSignals } from '../signals/index.mjs'
import { createJevClient } from '../jev/client.mjs'
import { runJev } from '../jev/run.mjs'
import { scoreStatic, scoreWithJev, themeOverrideRisk } from '../score/score.mjs'
import { POLICY_VERSION, MAX_HUNKS, DAILY_VRT_LIMIT, POPULAR_COUNT } from '../score/policy.mjs'
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

export async function runPrepare({ store, fetchCandidates, jevClient, fetchImpl = fetch, today, workDir, limits = {} }) {
  // 入力が取れない日・急に0件になった日は、空の結果を公開せずに止める
  const maintained = await fetchCandidates()
  const last = await store.getJSON('state/last-input-count.json', { count: 0 })
  if (maintained.length === 0 && last.count >= SUDDEN_EMPTY_MIN) throw new GuardError('input_sudden_empty')

  const popularPrev = await store.getJSON('state/popular-versions.json', {})
  const popularNow = await fetchPopular(limits.popularCount ?? POPULAR_COUNT, { fetchImpl })
  const popular = diffPopular(popularPrev, popularNow)

  const processed = new Set(await store.getJSON('state/processed.json', []))
  let queue = await store.getJSON('state/queue.json', [])
  const queued = new Set(queue.map((e) => e.key))

  // 保守先の組と定点観測の組を区別せず、ハッシュ順に処理する（順番からも見分けられないように）
  const all = uniqueByKey([...maintained, ...popular.items])
    .map((item) => ({ item, key: makeKey(item) }))
    .map((x) => ({ ...x, hash: keyHash(x.key) }))
    .sort((a, b) => a.hash.localeCompare(b.hash))

  const counts = { input: maintained.length, popular: popular.items.length, new: 0, skipped: 0, selected: 0, not_selected: 0, download_error: 0, jev_error: 0 }
  const records = []
  const additions = []
  const zipCache = new Map()

  for (const { item, key, hash } of all) {
    if (processed.has(key) || queued.has(key)) continue
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
    const jev = await runJev(hunks, jevClient, { maxHunks: MAX_HUNKS })
    if (jev.error) counts.jev_error++
    const risk_score_static = scoreStatic(signals)
    const risk_score = scoreWithJev(signals, jev)
    const selection = stratumOf({ signals, jev, risk_score })
    const partial = {
      key, key_hash: hash, slug: item.slug, from: item.from, to: item.to,
      signals, jev, risk_score_static, risk_score, p_visual: null, policy_version: POLICY_VERSION,
      theme_override_risk: themeOverrideRisk(signals), selection,
    }

    if (isSelected(key, selection)) {
      await writeWorkJSON(workDir, `pending/${hash}.json`, partial)
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
  const { run } = planVrt(queue, limits.dailyLimit ?? DAILY_VRT_LIMIT)

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
      await writeWorkJSON(workDir, `pending/${entry.key_hash}.json`, pending)
    }
    await writeWorkFile(workDir, `zips/${entry.key_hash}-old.zip`, zipsFor.oldZip)
    await writeWorkFile(workDir, `zips/${entry.key_hash}-new.zip`, zipsFor.newZip)
    jobs.push({ key_hash: entry.key_hash })
  }

  await writeWorkJSON(workDir, 'jobs.json', jobs)
  await writeWorkJSON(workDir, 'records.json', records)
  await writeWorkJSON(workDir, 'state-next.json', {
    processed: [...processed],
    queue,
    additions: additions.map((a) => a.key_hash),
    popular_versions: popular.next,
    input_count: maintained.length,
  })

  log('prepare_done', { ...counts, jobs: jobs.length, queue: queue.length })
  return counts
}

async function main() {
  const env = process.env
  const fetchCandidates = env.INPUT_FILE
    ? () => readCandidatesFile(env.INPUT_FILE)
    : () => fetchCandidatesFromManagewp({ url: env.MANAGEWP_CANDIDATES_URL, token: env.MANAGEWP_TOKEN })
  await runPrepare({
    store: storeFromEnv(env),
    fetchCandidates,
    jevClient: createJevClient({ apiKey: env.TYPESAFE_API_KEY }),
    today: todayJst(),
    workDir: env.WORK_DIR ?? 'work',
  })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    reportFatal('prepare', err)
    process.exit(1)
  })
}
```

- [ ] **Step 5: 通ることを確認する**

Run: `npm test`
Expected: PASS（prepare の9件を含む全件）

- [ ] **Step 6: コミット**

```bash
git add src/collect/candidates.mjs src/cli/prepare.mjs test/prepare.test.mjs
git commit -m "feat: prepare 段（収集・静的解析・Jev・スコア・選択）を追加"
```

---

### Task 14: vrt 段と publish 段

**Files:**
- Create: `src/cli/vrt.mjs`, `src/cli/publish.mjs`
- Test: `test/publish.test.mjs`, `test/vrt-stage.test.mjs`

**Interfaces:**
- Consumes: `runVrt`（Task 12）、work の形（Task 13）、ストア（Task 10）、契約（Task 2）
- Produces: `runVrtStage({workDir, runOne, portBase}) → Promise<counts>`（`runOne` は既定で Playwright と `runVrt` を使う。テストでは差し替える）、`runPublish({store, workDir, today}) → Promise<counts>`、`mergeRecords(prev, next) → records`

`work/vrt/{key_hash}/` に書くもの: `result.json`（`pages[].images` はストア上のパス `img/{key_hash}/{page}-{width}-{kind}.png`）と、同名の PNG ファイル。VRT が2回とも失敗した組は何も書かない（publish が試行回数を数える）。

- [ ] **Step 1: 失敗するテストを書く**

`test/vrt-stage.test.mjs`:

```js
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runVrtStage } from '../src/cli/vrt.mjs'
import { writeWorkJSON, writeWorkFile, readWorkJSON, workExists } from '../src/lib/work.mjs'

const H = 'abcdef0123456789'

async function setup() {
  const workDir = await mkdtemp(join(tmpdir(), 'work-'))
  await writeWorkJSON(workDir, 'jobs.json', [{ key_hash: H }])
  await writeWorkFile(workDir, `zips/${H}-old.zip`, Buffer.from('o'))
  await writeWorkFile(workDir, `zips/${H}-new.zip`, Buffer.from('n'))
  return workDir
}

describe('runVrtStage', () => {
  it('結果と画像を書き、画像はストア上のパスに置き換える', async () => {
    const workDir = await setup()
    const runOne = async () => ({
      status: 'done', reason: null, env: { wp: '7.1.2', php: '8.2', theme: 'twentytwentyfive' }, noise_floor: 0,
      pages: [{ page: 'home', width: 1280, diff_ratio: 0.1, images: { old: Buffer.from('a'), new: Buffer.from('b'), diff: Buffer.from('c') } }],
      errors_new: { php: [], js: [] }, vrt_changed: true,
    })
    await runVrtStage({ workDir, runOne })
    const r = await readWorkJSON(workDir, `vrt/${H}/result.json`)
    assert.equal(r.pages[0].images.old, `img/${H}/home-1280-old.png`)
    assert.ok(await workExists(workDir, `vrt/${H}/home-1280-diff.png`))
  })
  it('1回失敗しても再試行で成功すれば書く', async () => {
    const workDir = await setup()
    let n = 0
    const runOne = async () => {
      if (++n === 1) throw new Error('boot failed')
      return { status: 'no_surface', reason: null, env: null, noise_floor: 0, pages: [], errors_new: { php: [], js: [] }, vrt_changed: false }
    }
    await runVrtStage({ workDir, runOne })
    assert.equal(n, 2)
    assert.ok(await workExists(workDir, `vrt/${H}/result.json`))
  })
  it('2回とも失敗したら何も書かない', async () => {
    const workDir = await setup()
    const counts = await runVrtStage({ workDir, runOne: async () => { throw new Error('x') } })
    assert.equal(counts.error, 1)
    assert.equal(await workExists(workDir, `vrt/${H}/result.json`), false)
  })
})
```

`test/publish.test.mjs`:

```js
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runPublish, mergeRecords } from '../src/cli/publish.mjs'
import { createFsStore } from '../src/state/store.mjs'
import { writeWorkJSON, writeWorkFile } from '../src/lib/work.mjs'
import { RESULT_FIELDS, vrtPlaceholder } from '../src/contracts/result.mjs'

const H = 'abcdef0123456789'
const KEY = 'acme@1→2'
const partial = () => {
  const p = Object.fromEntries(RESULT_FIELDS.filter((f) => f !== 'vrt').map((f) => [f, null]))
  return { ...p, key: KEY, key_hash: H, slug: 'acme', from: '1', to: '2' }
}

async function setup({ withVrt, attempts = 0, additions = [] }) {
  const root = await mkdtemp(join(tmpdir(), 'store-'))
  const store = createFsStore(root)
  const workDir = await mkdtemp(join(tmpdir(), 'work-'))
  await writeWorkJSON(workDir, 'jobs.json', [{ key_hash: H }])
  await writeWorkJSON(workDir, 'records.json', [])
  await writeWorkJSON(workDir, `pending/${H}.json`, partial())
  await writeWorkJSON(workDir, 'state-next.json', {
    processed: [], queue: [{ key: KEY, key_hash: H, stratum: 'above', risk_score: 0.5, first_queued: '2026-09-29', attempts }],
    additions, popular_versions: { acme: '2' }, input_count: 1,
  })
  if (withVrt) {
    await writeWorkJSON(workDir, `vrt/${H}/result.json`, {
      ...vrtPlaceholder('done', null), pages: [{ page: 'home', width: 1280, diff_ratio: 0.1, images: { old: `img/${H}/home-1280-old.png`, new: `img/${H}/home-1280-new.png`, diff: `img/${H}/home-1280-diff.png` } }], vrt_changed: true,
    })
    for (const k of ['old', 'new', 'diff']) await writeWorkFile(workDir, `vrt/${H}/home-1280-${k}.png`, Buffer.from(k))
  }
  return { store, workDir }
}

describe('runPublish', () => {
  it('VRT の結果を結果ファイルに入れ、キューから外し、処理済みにする', async () => {
    const { store, workDir } = await setup({ withVrt: true })
    await runPublish({ store, workDir, today: '2026-09-29' })
    const file = await store.getJSON('results/2026-09-29.json', null)
    assert.equal(file.schema_version, 1)
    assert.equal(file.records[0].vrt.status, 'done')
    assert.deepEqual(await store.getJSON('state/queue.json', null), [])
    assert.deepEqual(await store.getJSON('state/processed.json', null), [KEY])
    assert.deepEqual(await store.getJSON('results/latest.json', null), { schema_version: 1, date: '2026-09-29', path: 'results/2026-09-29.json' })
    assert.deepEqual(await store.getJSON('state/popular-versions.json', null), { acme: '2' })
  })
  it('VRT の結果が無ければ試行を数えてキューに残す', async () => {
    const { store, workDir } = await setup({ withVrt: false })
    await runPublish({ store, workDir, today: '2026-09-29' })
    const q = await store.getJSON('state/queue.json', null)
    assert.equal(q[0].attempts, 1)
  })
  it('3回目の失敗で failed として確定する', async () => {
    const { store, workDir } = await setup({ withVrt: false, attempts: 2 })
    await runPublish({ store, workDir, today: '2026-09-29' })
    const file = await store.getJSON('results/2026-09-29.json', null)
    assert.equal(file.records[0].vrt.status, 'failed')
    assert.deepEqual(await store.getJSON('state/queue.json', null), [])
  })
  it('今日追加して今日実行しなかった組は queued として出す', async () => {
    const { store, workDir } = await setup({ withVrt: false, additions: ['ffffffffffffffff'] })
    await writeWorkJSON(workDir, 'pending/ffffffffffffffff.json', { ...partial(), key: 'b@1→2', key_hash: 'ffffffffffffffff', slug: 'b' })
    await runPublish({ store, workDir, today: '2026-09-29' })
    const file = await store.getJSON('results/2026-09-29.json', null)
    assert.equal(file.records.find((r) => r.key === 'b@1→2').vrt.status, 'queued')
    assert.ok(await store.getJSON('state/pending/ffffffffffffffff.json', null))
  })
  it('同じ日の2回目は当日の結果ファイルに足す（Review Focus 4）', async () => {
    const { store, workDir } = await setup({ withVrt: true })
    await store.putJSON('results/2026-09-29.json', { schema_version: 1, date: '2026-09-29', records: [{ key: 'earlier@1→2', vrt: { status: 'skipped' } }] })
    await runPublish({ store, workDir, today: '2026-09-29' })
    const file = await store.getJSON('results/2026-09-29.json', null)
    assert.deepEqual(file.records.map((r) => r.key).sort(), ['acme@1→2', 'earlier@1→2'])
  })
})

describe('mergeRecords', () => {
  it('確定した結果を queued で上書きしない', () => {
    const merged = mergeRecords([{ key: 'a', vrt: { status: 'done' } }], [{ key: 'a', vrt: { status: 'queued' } }])
    assert.equal(merged[0].vrt.status, 'done')
  })
  it('queued は確定した結果で置き換える', () => {
    const merged = mergeRecords([{ key: 'a', vrt: { status: 'queued' } }], [{ key: 'a', vrt: { status: 'done' } }])
    assert.equal(merged[0].vrt.status, 'done')
  })
})
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/cli/vrt.mjs'`）

- [ ] **Step 3: vrt 段を実装する**

`src/cli/vrt.mjs`:

```js
import { pathToFileURL } from 'node:url'

import { log, reportFatal } from '../lib/log.mjs'
import { readWorkJSON, readWorkFile, writeWorkJSON, writeWorkFile } from '../lib/work.mjs'

// このジョブには secret を渡さない（他人のプラグインのコードを実行するため。spec §4.6）
async function defaultRunOne() {
  const { chromium } = await import('playwright')
  const { runVrt } = await import('../vrt/run.mjs')
  let browser = null
  return {
    async run(job, port) {
      browser ??= await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined })
      return runVrt(job, { browser, port })
    },
    close: () => browser?.close(),
  }
}

export async function runVrtStage({ workDir, runOne, portBase = 9400 }) {
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
          result = await runner.run(job, portBase + ((i * 2 + attempt) % 100))
        } catch {
          // 1回だけ再試行する。2回とも失敗したら何も書かず、publish が試行回数を数える
        }
      }
      if (!result) {
        counts.error++
        continue
      }
      const pages = []
      for (const p of result.pages) {
        const images = {}
        for (const kind of ['old', 'new', 'diff']) {
          const name = `${p.page}-${p.width}-${kind}.png`
          await writeWorkFile(workDir, `vrt/${key_hash}/${name}`, p.images[kind])
          images[kind] = `img/${key_hash}/${name}`
        }
        pages.push({ ...p, images })
      }
      await writeWorkJSON(workDir, `vrt/${key_hash}/result.json`, { ...result, pages })
      counts[result.status] = (counts[result.status] ?? 0) + 1
    }
  } finally {
    await runner.close()
  }
  log('vrt_done', { jobs: jobs.length, ...counts })
  return counts
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runVrtStage({ workDir: process.env.WORK_DIR ?? 'work' }).catch((err) => {
    reportFatal('vrt', err)
    process.exit(1)
  })
}
```

- [ ] **Step 4: publish 段を実装する**

`src/cli/publish.mjs`:

```js
import { pathToFileURL } from 'node:url'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { log, reportFatal } from '../lib/log.mjs'
import { todayJst } from '../lib/date.mjs'
import { readWorkJSON, readWorkFile, workExists } from '../lib/work.mjs'
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
export async function runPublish({ store, workDir, today }) {
  const next = await readWorkJSON(workDir, 'state-next.json')
  const jobs = await readWorkJSON(workDir, 'jobs.json')
  const records = [...(await readWorkJSON(workDir, 'records.json'))]
  const processed = new Set(next.processed)
  let queue = next.queue
  const counts = { published: 0, attempt_failed: 0, failed: 0, queued: 0 }
  const ran = new Set()

  for (const { key_hash } of jobs) {
    ran.add(key_hash)
    const pending = await readWorkJSON(workDir, `pending/${key_hash}.json`)
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
    const pending = await readWorkJSON(workDir, `pending/${hash}.json`)
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPublish({ store: storeFromEnv(), workDir: process.env.WORK_DIR ?? 'work', today: todayJst() }).catch((err) => {
    reportFatal('publish', err)
    process.exit(1)
  })
}
```

- [ ] **Step 5: 通ることを確認する**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: 手元で3段を通して動かす**

`local-candidates.json`（コミットしない）:

```json
{ "schema_version": 1, "generated_at": "2026-09-29T00:00:00Z", "items": [{ "slug": "contact-form-7", "from": "6.1.6", "to": "6.1.7" }] }
```

Run:

```bash
export STORE_DIR=.local-store WORK_DIR=work INPUT_FILE=local-candidates.json TYPESAFE_API_KEY=<手元のキー>
node src/cli/prepare.mjs && node src/cli/vrt.mjs && node src/cli/publish.mjs
```

Expected: 3段とも `*_done` のログを1行ずつ出して終わる。`.local-store/results/<今日>.json` に contact-form-7 の結果があり、ログにスラッグとバージョンが出ていない。Jev のキーをまだ入れていなければ `TYPESAFE_API_KEY=dummy` にして、401 で prepare が `prepare_failed` を出して止まることを確かめる

- [ ] **Step 7: コミット**

```bash
git add src/cli/vrt.mjs src/cli/publish.mjs test/vrt-stage.test.mjs test/publish.test.mjs
git commit -m "feat: vrt 段と publish 段を追加（R2 へ書くのは publish だけ）"
```

---

### Task 15: 日次ワークフロー・失敗通知・運用の注意書き

**Files:**
- Create: `src/notify/slack.mjs`, `src/cli/notify-failure.mjs`, `.github/workflows/daily.yml`, `CLAUDE.md`
- Modify: `README.md`
- Test: `test/slack.test.mjs`

**Interfaces:**
- Produces: `notifyFailure({webhookUrl, runUrl, fetchImpl}) → Promise<void>`

- [ ] **Step 1: 失敗するテストを書く**

`test/slack.test.mjs`:

```js
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { notifyFailure } from '../src/notify/slack.mjs'

describe('notifyFailure', () => {
  it('実行の URL だけを送る', async () => {
    let body
    const fetchImpl = async (url, init) => { body = JSON.parse(init.body); return new Response('ok', { status: 200 }) }
    await notifyFailure({ webhookUrl: 'https://hooks.slack.test/x', runUrl: 'https://github.com/o/r/actions/runs/1', fetchImpl })
    assert.match(body.text, /actions\/runs\/1/)
  })
  it('Webhook が未設定なら投げる（黙って通知が消えないように）', async () => {
    await assert.rejects(notifyFailure({ webhookUrl: '', runUrl: 'u' }))
  })
  it('Slack がエラーを返したら投げる', async () => {
    const fetchImpl = async () => new Response('no', { status: 404 })
    await assert.rejects(notifyFailure({ webhookUrl: 'https://hooks.slack.test/x', runUrl: 'u', fetchImpl }))
  })
})
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/notify/slack.mjs'`）

- [ ] **Step 3: 実装する**

`src/notify/slack.mjs`:

```js
// 失敗したときだけ送る。成功時の通知は出さない（毎日同じものが届くと読まれなくなるため）
export async function notifyFailure({ webhookUrl, runUrl, fetchImpl = fetch }) {
  if (!webhookUrl) throw new Error('SLACK_WEBHOOK_URL が未設定')
  const res = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `wp-update-vrt の日次処理が失敗しました: ${runUrl}` }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Slack への通知に失敗 (HTTP ${res.status})`)
}
```

`src/cli/notify-failure.mjs`:

```js
import { notifyFailure } from '../notify/slack.mjs'
import { reportFatal } from '../lib/log.mjs'

notifyFailure({ webhookUrl: process.env.SLACK_WEBHOOK_URL, runUrl: process.env.RUN_URL }).catch((err) => {
  reportFatal('notify', err)
  process.exit(1)
})
```

- [ ] **Step 4: 通ることを確認する**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 日次ワークフローを書く**

`.github/workflows/daily.yml`:

```yaml
name: daily
on:
  schedule:
    # JST 04:41。キリの良い分は Actions の schedule が集中して大きく遅れる（wp-vuln-hub Issue #38）
    - cron: '41 19 * * *'
  workflow_dispatch:
concurrency:
  group: daily
  cancel-in-progress: false
permissions:
  contents: read
jobs:
  prepare:
    # managewp のエンドポイントができるまでは手動実行だけにする（Actions variable で切り替える）
    if: github.event_name == 'workflow_dispatch' || vars.ENABLE_SCHEDULE == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: node src/cli/prepare.mjs
        env:
          WORK_DIR: work
          MANAGEWP_CANDIDATES_URL: ${{ secrets.MANAGEWP_CANDIDATES_URL }}
          MANAGEWP_TOKEN: ${{ secrets.MANAGEWP_TOKEN }}
          TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
          R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
          R2_BUCKET: ${{ secrets.R2_BUCKET }}
          # prepare は読むだけ。書き込みのキーは publish にだけ渡す
          R2_ACCESS_KEY_ID: ${{ secrets.R2_READ_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_READ_SECRET_ACCESS_KEY }}
      - uses: actions/upload-artifact@v4
        with:
          name: work-prepare
          path: work
          # 公開リポジトリのアーティファクトは誰でも取得できる。中身は定点観測の組と混ざっているが、残す期間は最短にする
          retention-days: 1

  vrt:
    needs: prepare
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - uses: actions/download-artifact@v4
        with:
          name: work-prepare
          path: work
      # 他人のプラグインのコードを実行するジョブなので、secret を一切渡さない
      - run: node src/cli/vrt.mjs
        env:
          WORK_DIR: work
      - uses: actions/upload-artifact@v4
        with:
          name: work-vrt
          path: work/vrt
          retention-days: 1
          if-no-files-found: ignore

  publish:
    needs: [prepare, vrt]
    # vrt が丸ごと失敗しても、試行回数を数えてキューを進めるために走らせる
    if: ${{ !cancelled() && needs.prepare.result == 'success' }}
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - uses: actions/download-artifact@v4
        with:
          name: work-prepare
          path: work
      - uses: actions/download-artifact@v4
        continue-on-error: true
        with:
          name: work-vrt
          path: work/vrt
      - run: node src/cli/publish.mjs
        env:
          WORK_DIR: work
          R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
          R2_BUCKET: ${{ secrets.R2_BUCKET }}
          R2_ACCESS_KEY_ID: ${{ secrets.R2_WRITE_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_WRITE_SECRET_ACCESS_KEY }}

  notify:
    needs: [prepare, vrt, publish]
    if: ${{ failure() }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: node src/cli/notify-failure.mjs
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
```

- [ ] **Step 6: CLAUDE.md と README を書く**

`CLAUDE.md`:

```markdown
# wp-update-vrt

プラグイン更新の見栄えリスクを判定し、Playground で単体 VRT を実測する。結果は managewp が取り込む。
設計は `docs/superpowers/specs/2026-09-28-plugin-update-visual-risk-design.md`。ここには触る前に知らないと壊すものだけを書く。

## 公開リポジトリなので、ログに組を出さない（最重要）

Actions のログとアーティファクトは誰でも読める。処理する組は「保守先のどこかが古い版を使っている」という情報になる。

- ログは `src/lib/log.mjs` の `log()` / `reportFatal()` だけを使う。`console.log` を直接呼ばない。`err.message` を出さない
- 人気プラグインの定点観測（`src/collect/popular.mjs`）を外さない。保守先の組を優先して並べない（優先すると並び順から保守先の組が推測できるため）
- 結果に「保守先由来か」を書かない。`test/contracts.test.mjs` と `test/prepare.test.mjs` が固定している

## 受け渡しの形式は managewp との契約

`docs/*-format.md` と `src/contracts/`。変えるときは `schema_version` を上げ、このリポジトリを先に出し、managewp を後に出す。

## Jev にはコメントを渡さない

`src/signals/sanitize.mjs` が字句解析でコメントを消してから Jev に渡している（インジェクション対策）。
正規表現での除去に置き換えない。readme / changelog を state に足さない。

## キューと当日の結果は「上書きせず足す」

`mergeQueue` と `mergeRecords`。同じ日の2回目は新規0件になるので、上書きに戻すと1回目の予定と結果が消える。

## 数字は `src/score/policy.mjs` にだけ置く

変えたら `POLICY_VERSION` を上げる。Jev のエラーを強制（forced）に入れない（Jev が止まった日に上限を使い切る）。

## cron の分をキリ番にしない

`daily.yml` は `41 19 * * *`（JST 04:41）。キリの良い分は Actions が大きく遅れる。

## secret の配り方

VRT ジョブには secret を渡さない。R2 に書けるキーは publish にだけ渡す。
```

`README.md` の末尾に追記する:

```markdown
## 動かす

```bash
npm ci
npm test            # 単体
npm run test:vrt    # Playground＋Chromium の結合テスト
```

手元で3段を通す（`local-candidates.json` はコミットしない）:

```bash
export STORE_DIR=.local-store WORK_DIR=work INPUT_FILE=local-candidates.json TYPESAFE_API_KEY=...
node src/cli/prepare.mjs && node src/cli/vrt.mjs && node src/cli/publish.mjs
```

## Actions の設定

secrets: `MANAGEWP_CANDIDATES_URL` `MANAGEWP_TOKEN` `TYPESAFE_API_KEY` `R2_ACCOUNT_ID` `R2_BUCKET`
`R2_READ_ACCESS_KEY_ID` `R2_READ_SECRET_ACCESS_KEY` `R2_WRITE_ACCESS_KEY_ID` `R2_WRITE_SECRET_ACCESS_KEY` `SLACK_WEBHOOK_URL`

variables: `ENABLE_SCHEDULE`（managewp のエンドポイントができたら `true` にする。それまでは手動実行だけ）
```

- [ ] **Step 7: 全体を確認する**

Run: `npm test && npm run test:vrt`
Expected: どちらも PASS

- [ ] **Step 8: コミット**

```bash
git add src/notify src/cli/notify-failure.mjs .github/workflows/daily.yml CLAUDE.md README.md test/slack.test.mjs
git commit -m "feat: 日次ワークフローと失敗時の Slack 通知、運用の注意書きを追加"
```

---

## この計画に含めないもの（spec の範囲外・別リポジトリ）

- managewp 側: 更新待ちの組と正解データのエンドポイント、結果の取り込みとテーブル、画面、Slack 通知（managewp の別 spec）
- GitHub の公開リポジトリの作成と push、R2 バケットとキーの作成、secrets の登録（人が行う。キーの値はチャットに書かない）
- 較正（spec 2）、自動アップデートのゲート（spec 3）
