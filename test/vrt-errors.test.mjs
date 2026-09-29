import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { VrtError, vrtErrorCode, activationErrorCode } from '../src/vrt/errors.mjs'
import { runVrtStage } from '../src/cli/vrt.mjs'
import { writeWorkJSON, writeWorkFile } from '../src/lib/work.mjs'
import { setLogSink } from '../src/lib/log.mjs'

describe('vrtErrorCode', () => {
  it('VrtError はそのコードを返す', () => {
    assert.equal(vrtErrorCode(new VrtError('boot_failed')), 'boot_failed')
  })
  it('Playwright の TimeoutError は browser_timeout', () => {
    const err = Object.assign(new Error('x'), { name: 'TimeoutError' })
    assert.equal(vrtErrorCode(err), 'browser_timeout')
  })
  it('それ以外は unknown（名前やメッセージは使わない）', () => {
    assert.equal(vrtErrorCode(new Error('secret-plugin broke')), 'unknown')
    assert.equal(vrtErrorCode(null), 'unknown')
  })
})

describe('activationErrorCode', () => {
  it('WordPress の定型コードはそのまま使う', () => {
    assert.equal(activationErrorCode('plugin_php_incompatible'), 'activate_plugin_php_incompatible')
    assert.equal(activationErrorCode('no_plugin_file'), 'activate_no_plugin_file')
  })
  it('定型でないコード（プラグインが自前で返したものなど）は other にまとめる', () => {
    assert.equal(activationErrorCode('secret_plugin_custom_error'), 'activate_other')
    assert.equal(activationErrorCode(null), 'activate_other')
  })
})

describe('runVrtStage のエラーの記録', () => {
  const H = 'abcdef0123456789'
  async function setup() {
    const workDir = await mkdtemp(join(tmpdir(), 'work-'))
    await writeWorkJSON(workDir, 'jobs.json', [{ key_hash: H }])
    await writeWorkFile(workDir, `zips/${H}-old.zip`, Buffer.from('o'))
    await writeWorkFile(workDir, `zips/${H}-new.zip`, Buffer.from('n'))
    return workDir
  }
  const capture = async (fn) => {
    const lines = []
    const prev = setLogSink((l) => lines.push(l))
    try { await fn() } finally { setLogSink(prev) }
    return lines.map((l) => JSON.parse(l))
  }

  it('試行ごとに、キーのハッシュと定型のエラーコードを出す', async () => {
    const workDir = await setup()
    const runOne = async () => { throw new VrtError('new_activate_plugin_php_incompatible') }
    const events = await capture(() => runVrtStage({ workDir, runOne }))
    const errs = events.filter((e) => e.event === 'vrt_error_new_activate_plugin_php_incompatible')
    assert.equal(errs.length, 2)
    assert.deepEqual(errs.map((e) => [e.key_hash, e.attempt]), [[H, 0], [H, 1]])
  })

  it('原因の分からないエラーは unknown とし、メッセージは出さない', async () => {
    const workDir = await setup()
    const runOne = async () => { throw new Error('secret-plugin exploded') }
    const events = await capture(() => runVrtStage({ workDir, runOne }))
    assert.ok(events.some((e) => e.event === 'vrt_error_unknown' && e.key_hash === H))
    assert.ok(!JSON.stringify(events).includes('secret-plugin'))
  })
})
