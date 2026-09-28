import { WEIGHTS, CSS_SATURATION, PHP_SATURATION, VERSION_ONLY_SCORE } from './policy.mjs'

const clamp01 = (x) => Math.min(1, Math.max(0, x))
const round = (x) => Math.round(x * 1000) / 1000
// どれか1つが効けば上がる合成。parts は [重み, 0〜1 の強さ]
const noisyOr = (parts) => 1 - parts.reduce((acc, [w, x]) => acc * (1 - w * clamp01(x)), 1)

export function hasRegistrations(r) {
  return r.blocks_changed.length + r.shortcodes_added.length + r.shortcodes_removed.length > 0
}

function staticParts(s) {
  return {
    css: [WEIGHTS.css, s.css_decl_changes / CSS_SATURATION],
    assets: [WEIGHTS.assets, s.assets_changed > 0 ? 1 : 0],
    registrations: [WEIGHTS.registrations, hasRegistrations(s.registrations_diff) ? 1 : 0],
    js: [WEIGHTS.js_static, s.js_changed.front > 0 ? 1 : 0],
    php: [WEIGHTS.php_static, s.php_output_hunks / PHP_SATURATION],
  }
}

// 較正前の値は確率ではないので risk_score と呼ぶ（spec §4.4）
export function scoreStatic(s) {
  if (s.version_only) return VERSION_ONLY_SCORE
  return round(noisyOr(Object.values(staticParts(s))))
}

export function scoreWithJev(s, jev) {
  if (s.version_only) return VERSION_ONLY_SCORE
  const parts = staticParts(s)
  if (jev && !jev.error && !jev.large_diff) {
    if (jev.emits_markup !== null) parts.php = [WEIGHTS.php_jev, jev.emits_markup]
    if (jev.js_front_dom !== null) parts.js = [WEIGHTS.js_jev, jev.js_front_dom]
  }
  return round(noisyOr(Object.values(parts)))
}

// 単体 VRT では確かめられないので、VRT の結果に関係なく残る警告として別に出す
export function themeOverrideRisk(s) {
  return { selectors_removed: s.selectors_removed }
}
