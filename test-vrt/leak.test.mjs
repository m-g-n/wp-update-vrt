import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeWorkJSON, writeWorkFile, readWorkJSON } from '../src/lib/work.mjs'
import { makeZip } from '../test/helpers/tree.mjs'

// 公開リポジトリの Actions ログに組が出ないことを、vrt 段を丸ごと子プロセスで動かして確かめる。
// 他人のプラグインは PHP の警告や致命的エラーを出し、それにはファイルのパス（＝スラッグ）が入る
const SLUG = 'leakcheck-zz91q'
const H = '0123456789abcdef'
const ROOT = fileURLToPath(new URL('..', import.meta.url))

const plugin = (version, boom) => makeZip(SLUG, {
  [`${SLUG}.php`]: `<?php
/**
 * Plugin Name: Leak check ${SLUG}
 * Version: ${version}
 */
add_action('init', function () {
  trigger_error('${SLUG} warning', E_USER_WARNING);
  error_log('${SLUG} error_log');
});
add_shortcode('leakcheck_box', function () {
  ${boom ? `leakcheck_zz91q_undefined_function();` : ''}
  return '<div style="width:200px;height:100px;background:red">${SLUG}</div>';
});
`,
})

function runChild(workDir) {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, WORK_DIR: workDir }
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) env.PLAYWRIGHT_CHROMIUM_EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    const child = spawn(process.execPath, ['src/cli/vrt.mjs'], { cwd: ROOT, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('vrt 段の出力（子プロセス）', () => {
  it('プラグインが警告や致命的エラーを出しても、stdout / stderr にスラッグが出ない', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'work-leak-'))
    await writeWorkJSON(workDir, 'jobs.json', [{ key_hash: H }])
    await writeWorkFile(workDir, `zips/${H}-old.zip`, plugin('1.0.0', false))
    await writeWorkFile(workDir, `zips/${H}-new.zip`, plugin('1.1.0', true))

    const { code, stdout, stderr } = await runChild(workDir)
    // 失敗したときに原因が分かるよう、子プロセスの出力の末尾を添える（スラッグは伏せる）
    const tail = (s) => s.slice(-1500).replaceAll(SLUG, '<slug>').replaceAll('zz91q', '<slug>')
    assert.ok(stdout.includes('"event":"vrt_done"'), `vrt_done が無い (code ${code})\nstdout: ${tail(stdout)}\nstderr: ${tail(stderr)}`)
    assert.ok(!stdout.includes(SLUG), 'stdout にスラッグが出ている')
    assert.ok(!stderr.includes(SLUG), 'stderr にスラッグが出ている')
    assert.ok(!stdout.includes('zz91q') && !stderr.includes('zz91q'))
    // プラグインが実際に動き、スラッグ入りのエラーを出していたこと（出ていなければ確かめたことにならない）
    const r = await readWorkJSON(workDir, `vrt/${H}/result.json`)
    assert.ok(r.errors_new.php.some((l) => l.includes('Fatal error') && l.includes(SLUG)), JSON.stringify(r.errors_new.php.length))
  })
})
