import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PNG } from 'pngjs'

import { comparePngs, judge } from '../src/vrt/compare.mjs'

const png = (w, h, paint = () => [255, 255, 255, 255]) => {
  const p = new PNG({ width: w, height: h })
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4
    const [r, g, b, a] = paint(x, y)
    p.data[i] = r; p.data[i + 1] = g; p.data[i + 2] = b; p.data[i + 3] = a
  }
  return PNG.sync.write(p)
}

describe('comparePngs', () => {
  it('同じ画像なら 0', () => {
    assert.equal(comparePngs(png(10, 10), png(10, 10)).ratio, 0)
  })
  it('違う画素の割合を返す', () => {
    const b = png(10, 10, (x, y) => (x === 0 && y === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]))
    assert.equal(comparePngs(png(10, 10), b).ratio, 0.01)
  })
  it('高さが違えば、はみ出した部分を差分に数える', () => {
    const { ratio, diffPng } = comparePngs(png(10, 10), png(10, 20))
    assert.equal(ratio, 0.5)
    assert.equal(PNG.sync.read(diffPng).height, 20)
  })
})

describe('judge', () => {
  it('ノイズの床と 0.1% の大きいほうを超えたら変化あり', () => {
    assert.deepEqual(judge({ noiseFloor: 0, pages: [{ diff_ratio: 0.002 }], hasSurface: true }), { status: 'done', vrt_changed: true })
    assert.deepEqual(judge({ noiseFloor: 0, pages: [{ diff_ratio: 0.0005 }], hasSurface: true }), { status: 'done', vrt_changed: false })
  })
  it('床そのものが 0.1% を超えたら flaky（正解データにしない）', () => {
    assert.deepEqual(judge({ noiseFloor: 0.01, pages: [{ diff_ratio: 0.5 }], hasSurface: true }), { status: 'flaky', vrt_changed: null })
  })
  it('撮れる面がなく差分も無ければ no_surface', () => {
    assert.deepEqual(judge({ noiseFloor: 0, pages: [{ diff_ratio: 0 }], hasSurface: false }), { status: 'no_surface', vrt_changed: false })
  })
  it('撮れる面がなくても共通ページに差分があれば done', () => {
    assert.deepEqual(judge({ noiseFloor: 0, pages: [{ diff_ratio: 0.05 }], hasSurface: false }), { status: 'done', vrt_changed: true })
  })
})
