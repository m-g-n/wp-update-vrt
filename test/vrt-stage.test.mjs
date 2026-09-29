import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runVrtStage, vrtAllFailed } from '../src/cli/vrt.mjs'
import { writeWorkJSON, writeWorkFile, readWorkJSON, workExists } from '../src/lib/work.mjs'
import { setLogSink } from '../src/lib/log.mjs'

const H = 'abcdef0123456789'

async function setup() {
  const workDir = await mkdtemp(join(tmpdir(), 'work-'))
  await writeWorkJSON(workDir, 'jobs.json', [{ key_hash: H }])
  await writeWorkFile(workDir, `zips/${H}-old.zip`, Buffer.from('o'))
  await writeWorkFile(workDir, `zips/${H}-new.zip`, Buffer.from('n'))
  return workDir
}

describe('runVrtStage', () => {
  it('結果と画像を書き、画像はストア上のパスに置き換える', async () => {
    const workDir = await setup()
    const runOne = async () => ({
      status: 'done', reason: null, env: { wp: '7.1.2', php: '8.2', theme: 'twentytwentyfive' }, noise_floor: 0,
      pages: [{ page: 'home', width: 1280, diff_ratio: 0.1, images: { old: Buffer.from('a'), new: Buffer.from('b'), diff: Buffer.from('c') } }],
      errors_new: { php: [], js: [] }, vrt_changed: true,
    })
    await runVrtStage({ workDir, runOne })
    const r = await readWorkJSON(workDir, `vrt/${H}/result.json`)
    assert.equal(r.pages[0].images.old, `img/${H}/home-1280-old.png`)
    assert.ok(await workExists(workDir, `vrt/${H}/home-1280-diff.png`))
  })
  it('1回失敗しても再試行で成功すれば書く', async () => {
    const workDir = await setup()
    let n = 0
    const runOne = async () => {
      if (++n === 1) throw new Error('boot failed')
      return { status: 'no_surface', reason: null, env: null, noise_floor: 0, pages: [], errors_new: { php: [], js: [] }, vrt_changed: false }
    }
    await runVrtStage({ workDir, runOne })
    assert.equal(n, 2)
    assert.ok(await workExists(workDir, `vrt/${H}/result.json`))
  })
  it('2回とも失敗したら何も書かない', async () => {
    const workDir = await setup()
    const counts = await runVrtStage({ workDir, runOne: async () => { throw new Error('x') } })
    assert.equal(counts.error, 1)
    assert.equal(await workExists(workDir, `vrt/${H}/result.json`), false)
  })
  it('返ってこない実行は時間切れで失敗として数え、止める合図を渡す（1件で1日を潰さない）', async () => {
    const workDir = await setup()
    const signals = []
    const runOne = (job, port, signal) => {
      signals.push(signal)
      return new Promise(() => {})
    }
    const counts = await runVrtStage({ workDir, runOne, timeoutMs: 20 })
    assert.equal(counts.error, 1)
    assert.equal(signals.length, 2)
    assert.ok(signals.every((s) => s.aborted))
    assert.equal(await workExists(workDir, `vrt/${H}/result.json`), false)
  })
  it('時間内に終われば止める合図は出さない', async () => {
    const workDir = await setup()
    let signal
    const runOne = async (job, port, s) => {
      signal = s
      return { status: 'no_surface', reason: null, env: null, noise_floor: 0, pages: [], errors_new: { php: [], js: [] }, vrt_changed: false }
    }
    await runVrtStage({ workDir, runOne, timeoutMs: 1000 })
    assert.equal(signal.aborted, false)
  })
  it('ブロックの数はログにだけ出し、結果には書かない（結果の形を変えないため）', async () => {
    const workDir = await setup()
    const runOne = async () => ({
      status: 'no_surface', reason: null, env: null, noise_floor: 0, pages: [], errors_new: { php: [], js: [] }, vrt_changed: false,
      probe: { made: 3, from_example: 1, visible: 0 },
    })
    const lines = []
    const prev = setLogSink((l) => lines.push(JSON.parse(l)))
    try {
      await runVrtStage({ workDir, runOne })
    } finally {
      setLogSink(prev)
    }
    assert.deepEqual(lines.find((l) => l.event === 'vrt_blocks'), { event: 'vrt_blocks', key_hash: H, made: 3, from_example: 1, visible: 0 })
    const r = await readWorkJSON(workDir, `vrt/${H}/result.json`)
    assert.equal('probe' in r, false)
  })
})

describe('vrtAllFailed', () => {
  it('全件が失敗した日だけ true（黙って全滅しないように）', () => {
    assert.equal(vrtAllFailed(3, { done: 0, no_surface: 0, flaky: 0, error: 3 }), true)
    assert.equal(vrtAllFailed(3, { done: 1, no_surface: 0, flaky: 0, error: 2 }), false)
    assert.equal(vrtAllFailed(0, { done: 0, no_surface: 0, flaky: 0, error: 0 }), false)
  })
})
