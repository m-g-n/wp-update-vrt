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
// 1回の試行の上限。ふだんは1件1分前後なので、止まったまま返ってこないプラグインだけを切る
export const VRT_JOB_TIMEOUT_MS = 5 * 60 * 1000
export const MAX_HUNKS = 40
// 1回の prepare で新しく処理する組の上限。溜まった日に1回の実行が終わらなくなるのを防ぐ（残りは翌日以降）
export const MAX_NEW_PER_RUN = 200
// Jev の失敗がこの件数だけ続いたら、その回の残りは聞かない（静的なスコアで選ぶ）
export const JEV_CIRCUIT_THRESHOLD = 5
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
