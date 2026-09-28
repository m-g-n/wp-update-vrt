import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { scoreStatic, scoreWithJev, themeOverrideRisk, hasRegistrations } from '../src/score/score.mjs'
import { VERSION_ONLY_SCORE } from '../src/score/policy.mjs'

const empty = () => ({
  version_only: false, files_changed: 1, css_decl_changes: 0, selectors_removed: [], assets_changed: 0,
  registrations_diff: { blocks_changed: [], shortcodes_added: [], shortcodes_removed: [] },
  js_changed: { front: 0, admin: 0 }, php_output_hunks: 0, unsanitized_files: 0, oversized_hunks: 0,
})
const noJev = { emits_markup: null, runs_on_front: null, mutates_dom: null, js_front_dom: null, model: null, hunks_sent: 0, error: null, large_diff: false }

describe('score', () => {
  it('version_only は固定の低い値', () => {
    const s = { ...empty(), version_only: true, files_changed: 0 }
    assert.equal(scoreStatic(s), VERSION_ONLY_SCORE)
    assert.equal(scoreWithJev(s, noJev), VERSION_ONLY_SCORE)
  })
  it('何も効いていなければ 0', () => {
    assert.equal(scoreStatic(empty()), 0)
  })
  it('CSS の宣言が5つ以上変われば css の重みがそのまま出る', () => {
    assert.equal(scoreStatic({ ...empty(), css_decl_changes: 9 }), 0.6)
  })
  it('noisy-OR で合成する（どれか1つ効けば上がる）', () => {
    const s = { ...empty(), css_decl_changes: 5, assets_changed: 1 }
    assert.equal(scoreStatic(s), Math.round((1 - 0.4 * 0.7) * 1000) / 1000)
  })
  it('Jev の値があれば PHP の寄与を置き換える', () => {
    const s = { ...empty(), php_output_hunks: 3 }
    assert.equal(scoreStatic(s), 0.4)
    assert.equal(scoreWithJev(s, { ...noJev, emits_markup: 0.1 }), 0.07)
    assert.equal(scoreWithJev(s, { ...noJev, emits_markup: 1 }), 0.7)
  })
  it('Jev がエラーなら静的な値と同じ', () => {
    const s = { ...empty(), php_output_hunks: 3, js_changed: { front: 1, admin: 0 } }
    assert.equal(scoreWithJev(s, { ...noJev, error: 'http_529' }), scoreStatic(s))
  })
  it('消えたセレクタは合成に混ぜず別に出す', () => {
    const s = { ...empty(), selectors_removed: ['.btn'] }
    assert.equal(scoreStatic(s), 0)
    assert.deepEqual(themeOverrideRisk(s), { selectors_removed: ['.btn'] })
  })
  it('ブロック登録の差の有無', () => {
    assert.equal(hasRegistrations(empty().registrations_diff), false)
    assert.equal(hasRegistrations({ blocks_changed: [], shortcodes_added: ['x'], shortcodes_removed: [] }), true)
  })
})
