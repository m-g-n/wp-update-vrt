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
