# 結果（wp-update-vrt → managewp、日次）

非公開の R2 バケットに置く。managewp は読み取り専用のキーで取得する。

- `results/latest.json`: `{ "schema_version": 1, "date": "YYYY-MM-DD", "path": "results/YYYY-MM-DD.json" }`
- `results/YYYY-MM-DD.json`: `{ "schema_version": 1, "date": "YYYY-MM-DD", "records": [ ... ] }`
- `img/{key_hash}/{page}-{width}-{old|new|diff}.png`

同じ日に2回実行した場合、当日のファイルは上書きせず `key` 単位で足す。managewp は `key` で upsert する。

`results/latest.json` は最新の1日だけを指す。取り込みを休んだ日がある場合は、`latest.json` だけでなく
その間の `results/YYYY-MM-DD.json` を日付順に読むこと（`latest.json` からは前の日のファイルをたどれない）。

## record

| 項目 | 内容 |
|---|---|
| `key` | `slug@from→to` |
| `key_hash` | `key` の sha256 の先頭16桁 |
| `slug` / `from` / `to` | `docs/update-candidates-format.md` と同じ形（`slug` は `^[a-z0-9][a-z0-9-]*$`、`from` / `to` は `^[0-9A-Za-z][0-9A-Za-z.+-]*$`）。人気プラグインの定点観測の組も同じ規則で絞っている |
| `signals` | 静的な信号 |
| `jev` | `emits_markup` / `runs_on_front` / `mutates_dom` / `js_front_dom`（Noul の値。confidence は無い）、`model`、`hunks_sent`、`error`（`network` / `bad_response` / `http_NNN` / `circuit_open`（その回は失敗が続いたので聞かなかった））、`large_diff` |
| `risk_score_static` / `risk_score` | 0〜1。較正前なので確率ではない |
| `p_visual` | spec 1 では常に `null` |
| `policy_version` | 重みの版 |
| `theme_override_risk` | `{ "selectors_removed": [".btn", "#hero"] }` |
| `selection` | `{ "stratum": "forced|above|sample|sample_version_only", "rate": 0.1 }` |
| `vrt` | 下記 |

`vrt.reason` が `not_on_wporg`（WordPress.org に無い）または `unreadable_zip`（zip を読めない）の組は、中身を見ていないので
`signals` `jev` `risk_score_static` `risk_score` `theme_override_risk` `selection` がすべて `null` になる。

## vrt

| 項目 | 内容 |
|---|---|
| `status` | `done` / `skipped` / `no_surface` / `failed` / `flaky` / `queued` |
| `reason` | `not_selected` / `not_on_wporg` / `unreadable_zip` / `vrt_failed` / `null` |
| `env` | `{ "wp": "7.1.2", "php": "8.2", "theme": "twentytwentyfive" }` |
| `noise_floor` | 旧版を2回撮った差分率の最大値 |
| `pages` | `[{ "page": "home|post|shortcodes|blocks", "width": 1280, "diff_ratio": 0.0123, "images": { "old": "img/…", "new": "img/…", "diff": "img/…" } }]` |
| `errors_new` | `{ "php": ["PHP Warning: …"], "js": ["…"] }`（新版で増えたもの。旧版のときから出ていたものと、VRT が止めた通信によるもの（`net::ERR_FAILED` など）は除く。PHP の行は行頭の日時を外し、同じ行は1つにまとめる。各50件・1件300文字まで） |
| `vrt_changed` | `true` / `false`。`flaky` のときは `null` |

保守先由来か定点観測由来かは書かない。
