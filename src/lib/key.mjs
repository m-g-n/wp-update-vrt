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
