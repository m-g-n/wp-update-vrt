# wp-update-vrt

WordPress プラグインの更新について、差分の静的解析と Jev で見栄えリスクを判定し、
選んだものを WordPress Playground 上の単体 VRT で実測する。結果は managewp が取り込む。

設計: `docs/superpowers/specs/2026-09-28-plugin-update-visual-risk-design.md`

## 動かす

```bash
npm ci
npm test            # 単体
npm run test:vrt    # Playground＋Chromium の結合テスト
```

手元で3段を通す（`local-candidates.json` はコミットしない）:

```bash
export STORE_DIR=.local-store WORK_DIR=work INPUT_FILE=local-candidates.json TYPESAFE_API_KEY=... WORK_ENCRYPTION_KEY=$(openssl rand -base64 32)
node src/cli/prepare.mjs && node src/cli/vrt.mjs && node src/cli/publish.mjs
```

## Actions の設定

secrets: `MANAGEWP_CANDIDATES_URL` `MANAGEWP_TOKEN` `TYPESAFE_API_KEY` `R2_ACCOUNT_ID` `R2_BUCKET`
`R2_READ_ACCESS_KEY_ID` `R2_READ_SECRET_ACCESS_KEY` `R2_WRITE_ACCESS_KEY_ID` `R2_WRITE_SECRET_ACCESS_KEY` `SLACK_WEBHOOK_URL`
`WORK_ENCRYPTION_KEY`

`WORK_ENCRYPTION_KEY` は32バイトの base64（`openssl rand -base64 32`）。ジョブ間で受け渡す work/ は公開アーティファクトになるので、
組（スラッグ・バージョン）を含む `records.sealed` `state-next.sealed` `pending/*.sealed` をこの鍵で AES-256-GCM の封をする。
prepare と publish にだけ渡し、vrt ジョブには渡さない（他人のプラグインのコードを実行するジョブなので secret を持たせない。
vrt が読むのはハッシュだけの `jobs.json` と `zips/` なので鍵は要らない）。
残る露出はその日の `zips/`（日次 VRT の上限件数以下で、定点観測の組と混ざっている）。

variables: `ENABLE_SCHEDULE`（managewp のエンドポイントができたら `true` にする。それまでは手動実行だけ）
