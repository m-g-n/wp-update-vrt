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
