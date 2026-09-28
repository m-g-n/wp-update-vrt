import { createHash } from 'node:crypto'
import { structuredPatch } from 'diff'

import { fileKind, isAdminPath } from './classify.mjs'
import { stripPhpComments, stripJsComments, stripCssComments } from './sanitize.mjs'
import { cssFacts } from './css.mjs'

// 変更行にこれが含まれる PHP の塊だけを「HTML 出力に関わるかもしれない」とみなして Jev に送る
const OUTPUT_RE = /\becho\b|\bprint\b|\bprintf\b|\?>|<\/?[a-zA-Z]|\b_e\(|\besc_html_e\(|\besc_attr_e\(/
const SHORTCODE_RE = /add_shortcode\(\s*['"]([^'"]+)['"]/g
// block.json のうち見た目に効く項目。version だけの変更は数えない
const BLOCK_KEYS = ['attributes', 'supports', 'style', 'editorStyle', 'viewStyle', 'render', 'viewScript', 'viewScriptModule']
const HUNK_CONTEXT = 2
const MAX_HUNK_CHARS = 4000

const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const symmetricDiffSize = (a, b) => [...a].filter((x) => !b.has(x)).length + [...b].filter((x) => !a.has(x)).length

function sanitize(kind, text) {
  if (kind === 'php') return stripPhpComments(text)
  if (kind === 'js') return stripJsComments(text)
  if (kind === 'css') return stripCssComments(text)
  return { ok: true, text }
}

// バージョン文字列の違い・行末の空白・空行を消してから比べる。
// 版の番号は前後が英数字でも . でもないところだけ置き換える（11.0 や opacity:1.05 の中の 1.0 を消さない）
function normalize(text, from, to) {
  return text
    .replace(new RegExp(`(?<![\\w.])${escapeRe(from)}(?![\\w.])`, 'g'), to)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
    .join('\n')
}

function changedHunks(path, oldText, newText) {
  const patch = structuredPatch(path, path, oldText, newText, '', '', { context: HUNK_CONTEXT })
  return patch.hunks.map((h) => ({
    path,
    text: h.lines.join('\n'),
    changed: h.lines.filter((l) => l[0] === '+' || l[0] === '-').join('\n'),
  }))
}

function blockDef(buf) {
  try {
    const j = JSON.parse(buf.toString('utf8'))
    const pick = {}
    for (const k of BLOCK_KEYS) if (k in j) pick[k] = j[k]
    return { name: typeof j.name === 'string' ? j.name : null, sig: JSON.stringify(pick) }
  } catch {
    return { name: null, sig: 'unparsable' }
  }
}

function shortcodes(texts) {
  const set = new Set()
  for (const t of texts) for (const m of t.matchAll(SHORTCODE_RE)) set.add(m[1])
  return set
}

function hasUnminifiedSibling(path, t) {
  const m = path.match(/^(.*)\.min\.(js|css)$/)
  return Boolean(m && t.has(`${m[1]}.${m[2]}`))
}

export function computeSignals(oldTree, newTree, { from, to }) {
  const s = {
    version_only: false,
    files_changed: 0,
    css_decl_changes: 0,
    selectors_removed: [],
    assets_changed: 0,
    registrations_diff: { blocks_changed: [], shortcodes_added: [], shortcodes_removed: [] },
    js_changed: { front: 0, admin: 0 },
    php_output_hunks: 0,
    unsanitized_files: 0,
    oversized_hunks: 0,
  }
  const hunks = { php: [], js: [] }
  const oldNames = new Set()
  const newNames = new Set()
  const oldPhp = []
  const newPhp = []
  const pushHunk = (list, h) => {
    if (h.text.length > MAX_HUNK_CHARS) s.oversized_hunks++
    else list.push({ path: h.path, text: h.text })
  }

  const paths = [...new Set([...oldTree.keys(), ...newTree.keys()])].sort()
  for (const path of paths) {
    const kind = fileKind(path)
    if (kind === 'ignored') continue
    const a = oldTree.get(path)
    const b = newTree.get(path)

    if (kind === 'asset' || kind === 'other') {
      if (!a || !b || sha(a) !== sha(b)) {
        s.files_changed++
        if (kind === 'asset') s.assets_changed++
      }
      continue
    }

    if (kind === 'block_json') {
      const da = a ? blockDef(a) : { name: null, sig: null }
      const db = b ? blockDef(b) : { name: null, sig: null }
      if (da.sig !== db.sig) {
        s.files_changed++
        s.registrations_diff.blocks_changed.push(db.name ?? da.name ?? path)
      }
      continue
    }

    const sa = a ? sanitize(kind, a.toString('utf8')) : { ok: true, text: '' }
    const sb = b ? sanitize(kind, b.toString('utf8')) : { ok: true, text: '' }
    if (!sa.ok || !sb.ok) {
      s.unsanitized_files++
      s.files_changed++
      continue
    }

    let facts = null
    if (kind === 'css') {
      try {
        facts = { a: cssFacts(sa.text), b: cssFacts(sb.text) }
        for (const n of facts.a.names) oldNames.add(n)
        for (const n of facts.b.names) newNames.add(n)
      } catch {
        s.unsanitized_files++
        s.files_changed++
        continue
      }
    }
    if (kind === 'php') {
      oldPhp.push(sa.text)
      newPhp.push(sb.text)
    }

    const na = normalize(sa.text, from, to)
    const nb = normalize(sb.text, from, to)
    if (na === nb) continue
    s.files_changed++

    if (kind === 'css') {
      if (!hasUnminifiedSibling(path, newTree)) s.css_decl_changes += symmetricDiffSize(facts.a.decls, facts.b.decls)
      continue
    }
    if (kind === 'js') {
      if (isAdminPath(path)) {
        s.js_changed.admin++
        continue
      }
      if (hasUnminifiedSibling(path, newTree)) continue
      s.js_changed.front++
      for (const h of changedHunks(path, na, nb)) pushHunk(hunks.js, h)
      continue
    }
    // php
    for (const h of changedHunks(path, na, nb)) {
      if (!OUTPUT_RE.test(h.changed)) continue
      s.php_output_hunks++
      pushHunk(hunks.php, h)
    }
  }

  s.selectors_removed = [...oldNames].filter((n) => !newNames.has(n)).sort()
  const oldTags = shortcodes(oldPhp)
  const newTags = shortcodes(newPhp)
  s.registrations_diff.shortcodes_added = [...newTags].filter((t) => !oldTags.has(t)).sort()
  s.registrations_diff.shortcodes_removed = [...oldTags].filter((t) => !newTags.has(t)).sort()
  s.version_only = s.files_changed === 0
  return { signals: s, hunks }
}
