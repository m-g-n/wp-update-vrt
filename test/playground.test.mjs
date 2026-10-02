import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseMarked, runPhp, installPlugin } from '../src/vrt/playground.mjs'
import { vrtErrorCode } from '../src/vrt/errors.mjs'

describe('parseMarked', () => {
  it('プラグインが先に何か出力していても、印の間の JSON だけを読む', () => {
    assert.deepEqual(parseMarked('Notice: hello from plugin\n<div>x</div>\n@@VRT@@{"ok":true}@@VRT-END@@'), { ok: true })
  })
  it('プラグインが後に何か出力していても（shutdown など）、印の間の JSON だけを読む', () => {
    assert.deepEqual(parseMarked('@@VRT@@{"ok":true}@@VRT-END@@<!-- cache by plugin -->\n'), { ok: true })
  })
  it('印が複数あれば最後のものを使う', () => {
    assert.deepEqual(parseMarked('@@VRT@@{"a":1}@@VRT-END@@\n@@VRT@@{"a":2}@@VRT-END@@'), { a: 2 })
  })
  it('印が無ければ php_no_marker（PHP が途中で止まった）', () => {
    assert.throws(() => parseMarked('Fatal error'), (e) => vrtErrorCode(e) === 'php_no_marker')
  })
  it('印の間が JSON として読めなければ php_bad_output', () => {
    assert.throws(() => parseMarked('@@VRT@@{"a":@@VRT-END@@'), (e) => vrtErrorCode(e) === 'php_bad_output')
  })
})

// Playground の run() は、PHP の終了コードが 0 でなければ出力ごと例外にする（PHPExecutionFailureError）
const failing = (exitCode, text) => Object.assign(new Error(`PHP.run() failed with exit code ${exitCode}`), { response: { exitCode, text } })
const fakeSite = (run) => ({ cli: { playground: { run, writeFile: async () => {} } } })

describe('runPhp', () => {
  it('結果を出したあとで PHP が止まった（shutdown での致命的エラーなど）なら、出ていた結果を使う', async () => {
    const site = fakeSite(async () => { throw failing(255, '@@VRT@@{"a":1}@@VRT-END@@\nPHP Fatal error: x') })
    assert.deepEqual(await runPhp(site, ''), { a: 1 })
  })
  it('結果を出す前に止まったら php_run_failed にし、終了コードだけを数として残す', async () => {
    const site = fakeSite(async () => { throw failing(255, 'PHP Fatal error: secret-plugin') })
    await assert.rejects(runPhp(site, ''), (e) => {
      assert.equal(vrtErrorCode(e), 'php_run_failed')
      assert.deepEqual(e.fields, { exit_code: 255 })
      return true
    })
  })
})

describe('installPlugin の失敗の名前', () => {
  it('印が出ずに終わった（プラグインが exit した）なら <phase>_php_exited', async () => {
    const site = fakeSite(async () => ({ text: 'redirecting' }))
    await assert.rejects(installPlugin(site, Buffer.from('z'), 'old'), (e) => vrtErrorCode(e) === 'old_php_exited')
  })
  it('実行そのものが失敗したなら <phase>_php_run_failed で、終了コードも引き継ぐ', async () => {
    const site = fakeSite(async () => { throw failing(255, '') })
    await assert.rejects(installPlugin(site, Buffer.from('z'), 'new'), (e) => {
      assert.equal(vrtErrorCode(e), 'new_php_run_failed')
      assert.deepEqual(e.fields, { exit_code: 255 })
      return true
    })
  })
})
