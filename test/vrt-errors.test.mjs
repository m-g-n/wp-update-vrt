import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { VrtError, vrtErrorCode, activationErrorCode, atStage, isTerminalError, isRetryableInRun } from '../src/vrt/errors.mjs'
import { runVrtStage } from '../src/cli/vrt.mjs'
import { writeWorkJSON, writeWorkFile, readWorkJSON, workExists } from '../src/lib/work.mjs'
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

describe('atStage', () => {
  const timeout = () => Object.assign(new Error('Timeout 60000ms exceeded. secret-plugin'), { name: 'TimeoutError' })
  it('時間切れは、どの操作で止まったかを付けたコードにする', async () => {
    await assert.rejects(atStage('editor', async () => { throw timeout() }), (e) => vrtErrorCode(e) === 'browser_timeout_editor')
  })
  it('VrtError はそのまま通す（内側で付けたコードを上書きしない）', async () => {
    await assert.rejects(atStage('editor', async () => { throw new VrtError('editor_redirected') }), (e) => e.code === 'editor_redirected')
  })
  it('それ以外の例外もどの操作かだけを付け、メッセージは使わない', async () => {
    await assert.rejects(atStage('probe', async () => { throw new Error('secret-plugin broke') }), (e) => {
      assert.equal(vrtErrorCode(e), 'unknown_probe')
      assert.ok(!e.message.includes('secret-plugin'))
      return true
    })
  })
  it('成功すればその値を返す', async () => {
    assert.equal(await atStage('shot', async () => 42), 42)
  })
})

describe('isTerminalError / isRetryableInRun', () => {
  it('何度試しても同じ有効化の失敗は、旧版でも新版でも確定させる', () => {
    assert.equal(isTerminalError('old_activate_plugin_missing_dependencies'), true)
    assert.equal(isTerminalError('new_activate_plugin_php_incompatible'), true)
  })
  it('原因の分からない有効化の失敗や、ほかの段の失敗は確定させない（翌日にまた試す）', () => {
    assert.equal(isTerminalError('old_activate_other'), false)
    assert.equal(isTerminalError('old_php_fatal'), false)
    assert.equal(isTerminalError('browser_timeout_editor'), false)
    assert.equal(isTerminalError(undefined), false)
  })
  it('その日のうちに試し直すのは起動の失敗だけ', () => {
    assert.equal(isRetryableInRun('boot_failed'), true)
    assert.equal(isRetryableInRun('browser_timeout_shot'), false)
    assert.equal(isRetryableInRun('unknown'), false)
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

  it('何度試しても同じ失敗は、1回で failed として結果に書く（翌日以降も試し直さない）', async () => {
    const workDir = await setup()
    let n = 0
    const runOne = async () => { n++; throw new VrtError('old_activate_plugin_missing_dependencies') }
    const events = await capture(() => runVrtStage({ workDir, runOne }))
    assert.equal(n, 1)
    const errs = events.filter((e) => e.event === 'vrt_error_old_activate_plugin_missing_dependencies')
    assert.deepEqual(errs.map((e) => [e.key_hash, e.attempt]), [[H, 0]])
    const r = await readWorkJSON(workDir, `vrt/${H}/result.json`)
    assert.equal(r.status, 'failed')
    assert.equal(r.reason, 'vrt_failed')
    assert.equal(r.pages, null)
    assert.equal(events.find((e) => e.event === 'vrt_done').failed, 1)
  })

  it('起動以外の失敗は、その日のうちには試し直さず何も書かない（publish が試行回数を数える）', async () => {
    const workDir = await setup()
    let n = 0
    const runOne = async () => { n++; throw new VrtError('browser_timeout_editor') }
    const events = await capture(() => runVrtStage({ workDir, runOne }))
    assert.equal(n, 1)
    assert.deepEqual(events.filter((e) => e.event === 'vrt_error_browser_timeout_editor').map((e) => e.attempt), [0])
    assert.equal(await workExists(workDir, `vrt/${H}/result.json`), false)
  })

  it('原因の分からないエラーは unknown とし、メッセージは出さない', async () => {
    const workDir = await setup()
    const runOne = async () => { throw new Error('secret-plugin exploded') }
    const events = await capture(() => runVrtStage({ workDir, runOne }))
    assert.ok(events.some((e) => e.event === 'vrt_error_unknown' && e.key_hash === H))
    assert.ok(!JSON.stringify(events).includes('secret-plugin'))
  })
})
