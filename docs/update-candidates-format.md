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
