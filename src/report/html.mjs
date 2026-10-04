// 手元で見るレポートの HTML（src/cli/report.mjs が書く）。
// プラグイン名と版が入るので、公開リポジトリにも Actions のログにも出さない（spec §8）。
// 中身にはプラグイン由来の文字列（PHP の警告など）が入るので、すべてエスケープする

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const pct = (r) => (typeof r === 'number' ? `${(r * 100).toFixed(2)}%` : '—')
const score = (s) => (typeof s === 'number' ? s.toFixed(2) : '—')

const RAN = new Set(['done', 'no_surface', 'flaky', 'failed'])
const SKIP_REASON = {
  not_selected: '閾値未満で抜き取りにも当たらず',
  not_on_wporg: 'この版は WordPress.org から取得できず',
  unreadable_zip: 'zip を読めず',
}

function verdict(vrt) {
  if (vrt.status === 'done') return vrt.vrt_changed ? ['変化あり', 'bad'] : ['変化なし', 'ok']
  return {
    no_surface: ['表示部分なし', 'muted'],
    flaky: ['画像が安定せず', 'warn'],
    failed: ['失敗', 'bad'],
    queued: ['順番待ち', 'wait'],
    skipped: ['VRT せず', 'muted'],
  }[vrt.status] ?? [vrt.status, 'muted']
}

const pill = ([label, tone]) => `<span class="pill ${tone}">${esc(label)}</span>`
const maxRatio = (vrt) => Math.max(-1, ...(vrt.pages ?? []).map((p) => p.diff_ratio ?? -1))
const errCount = (vrt) => (vrt.errors_new?.php?.length ?? 0) + (vrt.errors_new?.js?.length ?? 0)
const selCount = (r) => r.theme_override_risk?.selectors_removed?.length ?? 0

function img(src, alt) {
  return src ? `<a href="${esc(src)}"><img src="${esc(src)}" alt="${esc(alt)}" loading="lazy"></a>` : '<div class="noimg">画像なし</div>'
}

function changedSection(r) {
  // 差分の大きいページから並べ、差分の無いページは省く
  const pages = [...(r.vrt.pages ?? [])].filter((p) => p.diff_ratio > 0).sort((a, b) => b.diff_ratio - a.diff_ratio)
  const errors = ['php', 'js'].flatMap((t) => (r.vrt.errors_new?.[t] ?? []).map((l) => `<li><span class="sub">${t.toUpperCase()}</span> ${esc(l)}</li>`))
  const selectors = r.theme_override_risk?.selectors_removed ?? []
  return `<section class="change">
<h3>${esc(r.key)}</h3>
<p class="meta">key_hash ${esc(r.key_hash)} ・ risk_score ${score(r.risk_score)} ・ 区分 ${esc(r.selection?.stratum)} ・ 最大の差分率 ${pct(maxRatio(r.vrt))}</p>
${pages.map((p) => `<div class="triple"><div class="cap">${esc(p.page)} / ${esc(p.width)}px ・ 差分率 ${pct(p.diff_ratio)}</div>
<div class="shots">${['old', 'new', 'diff'].map((k) => `<figure>${img(p.images?.[k], `${p.page} ${k}`)}<figcaption>${{ old: '旧版', new: '新版', diff: '差分' }[k]}</figcaption></figure>`).join('')}</div></div>`).join('\n')}
${errors.length ? `<p class="cap">新しいエラー</p><ul class="errs">${errors.join('')}</ul>` : ''}
${selectors.length ? `<p class="cap">消えたセレクタ</p><p class="sub">${selectors.map(esc).join(' ')}</p>` : ''}
</section>`
}

function ranRow(r) {
  const top = [...(r.vrt.pages ?? [])].sort((a, b) => (b.diff_ratio ?? 0) - (a.diff_ratio ?? 0))[0]
  return `<tr${r.vrt.vrt_changed ? ' class="hl"' : ''}>
<td>${esc(r.key)}<div class="sub">${esc(r.key_hash)}</div></td>
<td>${pill(verdict(r.vrt))}</td>
<td class="n">${score(r.risk_score)}</td><td>${esc(r.selection?.stratum)}</td>
<td class="n">${maxRatio(r.vrt) >= 0 ? pct(maxRatio(r.vrt)) : '—'}</td>
<td class="n">${errCount(r.vrt) || ''}</td><td class="n">${selCount(r) || ''}</td>
<td>${top?.images?.diff ? `<a href="${esc(top.images.diff)}"><img class="thumb" src="${esc(top.images.diff)}" alt="差分" loading="lazy"></a>` : ''}</td>
</tr>`
}

export function buildReportHtml({ date, records, queue = [] }) {
  const ran = records.filter((r) => RAN.has(r.vrt?.status))
  const changed = ran.filter((r) => r.vrt.vrt_changed === true).sort((a, b) => maxRatio(b.vrt) - maxRatio(a.vrt))
  const skipped = records.filter((r) => !RAN.has(r.vrt?.status))
  const count = (f) => ran.filter(f).length
  const cards = [
    ['判定した組', records.length],
    ['VRT した組', ran.length],
    ['変化あり', changed.length],
    ['変化なし', count((r) => r.vrt.status === 'done' && !r.vrt.vrt_changed)],
    ['表示部分なし', count((r) => r.vrt.status === 'no_surface')],
    ['失敗', count((r) => r.vrt.status === 'failed' || r.vrt.status === 'flaky')],
    ['VRT せず', skipped.filter((r) => r.vrt?.status === 'skipped').length],
    ['その日は順番待ち', skipped.filter((r) => r.vrt?.status === 'queued').length],
    ['いまの順番待ち・再試行中', queue.length],
  ]
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>見栄えリスク判定 ${esc(date)}</title>
<style>
:root{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--line:#e2e1dc;--card:#fff;--hl:#fff6e0;--ok:#1f7a4d;--warn:#a86200;--bad:#b3261e;--wait:#3b5bdb}
@media (prefers-color-scheme: dark){:root{--bg:#161615;--fg:#ecebe6;--muted:#9c9b94;--line:#33322f;--card:#1f1f1d;--hl:#3a2f12;--ok:#5fcf97;--warn:#f0a44b;--bad:#ff8a80;--wait:#8ea6ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Hiragino Sans",sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 80px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:40px 0 12px;padding-top:12px;border-top:1px solid var(--line)}h3{font-size:16px;margin:0 0 4px;overflow-wrap:anywhere}
.lead{color:var(--muted);margin:0 0 20px}.warn-box{background:var(--hl);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin:0 0 20px;font-size:14px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.card .v{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums}.card .l{color:var(--muted);font-size:13px}
.change{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:0 0 16px}
.meta{color:var(--muted);font-size:13px;margin:0 0 12px;overflow-wrap:anywhere}
.triple{margin:12px 0}.cap{font-size:13px;font-weight:600;margin:8px 0 6px}
.shots{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}figure{margin:0}figcaption{font-size:12px;color:var(--muted)}
.shots img{width:100%;max-height:520px;object-fit:cover;object-position:top;border:1px solid var(--line);border-radius:6px;background:#fff}
.noimg{border:1px dashed var(--line);border-radius:6px;padding:40px 0;text-align:center;color:var(--muted);font-size:12px}
.errs{margin:0;padding-left:18px;font-size:12px;overflow-wrap:anywhere}
.tablewrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:760px;font-size:13px}th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{background:var(--card);font-weight:600;color:var(--muted)}td.n{font-variant-numeric:tabular-nums;white-space:nowrap}
tr.hl td{background:var(--hl)}.sub{color:var(--muted);font-size:12px}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;border:1px solid currentColor;font-size:12px;white-space:nowrap}
.pill.ok{color:var(--ok)}.pill.warn{color:var(--warn)}.pill.bad{color:var(--bad)}.pill.wait{color:var(--wait)}.pill.muted{color:var(--muted)}
.thumb{width:96px;height:64px;object-fit:cover;object-position:top;border:1px solid var(--line);border-radius:4px;background:#fff}
@media (max-width:640px){.shots{grid-template-columns:1fr}}
</style></head><body><main>
<h1>見栄えリスク判定 ${esc(date)}</h1>
<p class="lead">wp-update-vrt の結果（非公開の R2）から手元で作ったレポート。</p>
<div class="warn-box">社外秘。プラグイン名と版が入るので、公開リポジトリやチャットに貼らないこと。ログの key_hash から組を引くときは、この表のハッシュと照らし合わせる。</div>
<div class="cards">${cards.map(([l, v]) => `<div class="card"><div class="v">${v}</div><div class="l">${esc(l)}</div></div>`).join('')}</div>

<h2>変化ありの組（${changed.length}）</h2>
${changed.length ? changed.map(changedSection).join('\n') : '<p class="sub">なし</p>'}

<h2>VRT した組（${ran.length}）</h2>
<div class="tablewrap"><table><thead><tr><th>組 / key_hash</th><th>結果</th><th>risk_score</th><th>区分</th><th>最大の差分率</th><th>新しいエラー</th><th>消えたセレクタ</th><th>差分</th></tr></thead>
<tbody>${ran.sort((a, b) => maxRatio(b.vrt) - maxRatio(a.vrt)).map(ranRow).join('\n')}</tbody></table></div>

<h2>いまの順番待ち・再試行中（${queue.length}）</h2>
<p class="sub">レポートを作った時点の状態。ログの vrt_error_* に出た、まだ確定していない組はここで引ける。</p>
${queue.length ? `<div class="tablewrap"><table><thead><tr><th>組 / key_hash</th><th>区分</th><th>risk_score</th><th>キューに入った日</th><th>失敗した回数</th></tr></thead>
<tbody>${queue.map((q) => `<tr><td>${esc(q.key)}<div class="sub">${esc(q.key_hash)}</div></td><td>${esc(q.stratum)}</td><td class="n">${score(q.risk_score)}</td><td class="n">${esc(q.first_queued)}</td><td class="n">${esc(q.attempts ?? 0)}</td></tr>`).join('\n')}</tbody></table></div>` : '<p class="sub">なし</p>'}

<h2>VRT しなかった組・その日は順番待ちだった組（${skipped.length}）</h2>
<div class="tablewrap"><table><thead><tr><th>組 / key_hash</th><th>結果</th><th>理由</th><th>risk_score</th><th>区分</th></tr></thead>
<tbody>${skipped.map((r) => `<tr><td>${esc(r.key)}<div class="sub">${esc(r.key_hash)}</div></td><td>${pill(verdict(r.vrt ?? {}))}</td><td>${esc(SKIP_REASON[r.vrt?.reason] ?? r.vrt?.reason ?? '')}</td><td class="n">${score(r.risk_score)}</td><td>${esc(r.selection?.stratum ?? '')}</td></tr>`).join('\n')}</tbody></table></div>
</main></body></html>
`
}
