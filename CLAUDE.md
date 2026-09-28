# wp-update-vrt

プラグイン更新の見栄えリスクを判定し、Playground で単体 VRT を実測する。結果は managewp が取り込む。
設計は `docs/superpowers/specs/2026-09-28-plugin-update-visual-risk-design.md`。ここには触る前に知らないと壊すものだけを書く。

## 公開リポジトリなので、ログに組を出さない（最重要）

Actions のログとアーティファクトは誰でも読める。処理する組は「保守先のどこかが古い版を使っている」という情報になる。

- ログは `src/lib/log.mjs` の `log()` / `reportFatal()` だけを使う。`console.log` を直接呼ばない。`err.message` を出さない
- 人気プラグインの定点観測（`src/collect/popular.mjs`）を外さない。保守先の組を優先して並べない（優先すると並び順から保守先の組が推測できるため）
- WordPress.org の人気プラグイン API（`fetchPopular`）の失敗は致命的なままにする。握りつぶして続けると、その日は定点観測が0件になり、保守先の組だけを公開することになる（初回の慣らし運転も同じ理由）
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

`WORK_ENCRYPTION_KEY` は prepare と publish にだけ渡す。work/ は公開アーティファクトなので、組を含む
`records` `state-next` `pending/*` は `src/lib/seal.mjs` で封をして置く（`writeWorkSealed` / `readWorkSealed`）。
平文で置いてよいのはハッシュだけの `jobs.json` と `zips/` だけ。vrt はこの2つしか読まないので鍵を渡さない
（他人のコードを実行するジョブに鍵を持たせると、封の意味がなくなる）。組を含むファイルを work/ に足すときは封をすること。
残る露出はその日の `zips/`（日次 VRT の上限以下、定点観測の組と混ざっている）。
