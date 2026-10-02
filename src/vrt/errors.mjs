// VRT の1件が失敗した理由を、公開ログに出してよい形（決まった語だけ）で表す。
// code はログのイベント名になるので、英小文字・数字・_ だけにする。プラグイン由来の文字列は入れない
// fields は数だけ（PHP の終了コードなど）。ログに一緒に出す
export class VrtError extends Error {
  constructor(code, { fields, ...options } = {}) {
    super(code, options)
    this.name = 'VrtError'
    this.code = code
    this.fields = fields ?? options.cause?.fields
  }
}

// どの段で起きたかが名前に入っていない PHP の失敗。atStage が段の名前を前に付ける
const GENERIC_PHP_CODES = new Set(['php_no_marker', 'php_run_failed', 'php_bad_output'])

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

// 処理を段ごとに包み、失敗したときにどの段で止まったかをコードに残す。
// stage は決まった語（install_old / install_new / shortcodes / editor / blocks / probe / capturer / shot / log / compare）
// だけを渡す。元の例外のメッセージは使わない
export async function atStage(stage, fn) {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof VrtError) {
      if (GENERIC_PHP_CODES.has(err.code)) throw new VrtError(`${stage}_${err.code}`, { cause: err })
      throw err
    }
    if (err?.name === 'TimeoutError') throw new VrtError(`browser_timeout_${stage}`, { cause: err })
    throw new VrtError(`unknown_${stage}`, { cause: err })
  }
}

// 何度試しても同じ結果になる有効化の失敗。その場で failed として確定し、翌日以降も試し直さない。
// 例: 別のプラグインが要る（Requires Plugins）、PHP や WordPress の版が合わない。
// 検証環境は毎回同じ（PHP 8.2・最新の WordPress・依存プラグインなし）なので、結果は変わらない
const TERMINAL_ACTIVATION = new Set([
  'no_plugin_file',
  'no_plugin_header',
  'invalid_plugin',
  'plugin_not_found',
  'plugin_php_incompatible',
  'plugin_wp_incompatible',
  'plugin_wp_php_incompatible',
  'plugin_missing_dependencies',
])

export function isTerminalError(code) {
  const m = /^(old|new)_activate_(.+)$/.exec(code ?? '')
  return Boolean(m) && TERMINAL_ACTIVATION.has(m[2])
}

// その日のうちに試し直す価値があるのは、Playground の起動の失敗だけ。
// 2026-09-29・30 の実行では、それ以外の失敗は13組すべてが2回とも同じ理由で失敗した
export function isRetryableInRun(code) {
  return code === 'boot_failed'
}

export function vrtErrorCode(err) {
  if (err instanceof VrtError) return err.code
  if (err?.name === 'TimeoutError') return 'browser_timeout'
  return 'unknown'
}
