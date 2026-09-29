// VRT の1件が失敗した理由を、公開ログに出してよい形（決まった語だけ）で表す。
// code はログのイベント名になるので、英小文字・数字・_ だけにする。プラグイン由来の文字列は入れない
export class VrtError extends Error {
  constructor(code, options) {
    super(code, options)
    this.name = 'VrtError'
    this.code = code
  }
}

// WordPress の Plugin_Upgrader / activate_plugin が返す定型のエラーコード。
// プラグインが自前で返したコードはここに無いので other にまとめる
const WP_ACTIVATION_CODES = new Set([
  'install_failed',
  'no_plugin_file',
  'plugin_not_found',
  'no_plugin_header',
  'invalid_plugin',
  'plugin_php_incompatible',
  'plugin_wp_incompatible',
  'plugin_wp_php_incompatible',
  'plugin_missing_dependencies',
])

export function activationErrorCode(wpCode) {
  return WP_ACTIVATION_CODES.has(wpCode) ? `activate_${wpCode}` : 'activate_other'
}

export function vrtErrorCode(err) {
  if (err instanceof VrtError) return err.code
  if (err?.name === 'TimeoutError') return 'browser_timeout'
  return 'unknown'
}
