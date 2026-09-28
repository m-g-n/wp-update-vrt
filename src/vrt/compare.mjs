import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

import { MIN_DIFF_RATIO } from '../score/policy.mjs'

// 小さいほうを透明の黒で広げる。ページの高さが変わった分は必ず差分に数える
function padTo(img, width, height) {
  if (img.width === width && img.height === height) return img
  const out = new PNG({ width, height })
  out.data.fill(0)
  PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0)
  return out
}

export function comparePngs(bufA, bufB) {
  const a = PNG.sync.read(bufA)
  const b = PNG.sync.read(bufB)
  const width = Math.max(a.width, b.width)
  const height = Math.max(a.height, b.height)
  const diff = new PNG({ width, height })
  const px = pixelmatch(padTo(a, width, height).data, padTo(b, width, height).data, diff.data, width, height, { threshold: 0.1 })
  return { ratio: px / (width * height), diffPng: PNG.sync.write(diff) }
}

// no_surface は正解データの対象から外す（「差分なし」が多すぎて較正が狂うのを防ぐ。spec §4.6）
export function judge({ noiseFloor, pages, hasSurface }) {
  if (noiseFloor > MIN_DIFF_RATIO) return { status: 'flaky', vrt_changed: null }
  const limit = Math.max(noiseFloor, MIN_DIFF_RATIO)
  const vrt_changed = pages.some((p) => p.diff_ratio > limit)
  if (!vrt_changed && !hasSurface) return { status: 'no_surface', vrt_changed: false }
  return { status: 'done', vrt_changed }
}
