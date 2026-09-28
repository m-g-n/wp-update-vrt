import Engine from 'php-parser'
import * as acorn from 'acorn'
import jsx from 'acorn-jsx'
import postcss from 'postcss'

// Jev はプロンプトインジェクションで判定が動く（Octomind の検証で 0.76 → 0.22）。
// 差分はプラグイン作者が自由に書けるので、「見た目は変わらない」といったコメントを
// Jev に届く前に構造的に取り除く。正規表現ではなく字句解析で消す
const phpEngine = new Engine({ parser: { php8: true, suppressErrors: true }, lexer: { all_tokens: true } })
const JsParser = acorn.Parser.extend(jsx())

// 消したコメントは同じ数の改行に置き換え、差分の行の対応を保つ
const keepNewlines = (text) => text.replace(/[^\n]/g, '')

export function stripPhpComments(src) {
  try {
    let out = ''
    for (const token of phpEngine.tokenGetAll(src)) {
      if (typeof token === 'string') {
        out += token
        continue
      }
      const [name, text] = token
      out += name === 'T_COMMENT' || name === 'T_DOC_COMMENT' ? keepNewlines(text) : text
    }
    return { ok: true, text: out }
  } catch {
    return { ok: false, text: null }
  }
}

export function stripJsComments(src) {
  for (const sourceType of ['module', 'script']) {
    try {
      const comments = []
      const opts = { ecmaVersion: 'latest', sourceType, onComment: comments, allowHashBang: true }
      for (const _ of JsParser.tokenizer(src, opts)) { /* 最後まで読んでコメントを集める */ }
      let out = ''
      let pos = 0
      for (const c of comments) {
        out += src.slice(pos, c.start) + keepNewlines(src.slice(c.start, c.end))
        pos = c.end
      }
      return { ok: true, text: out + src.slice(pos) }
    } catch {
      // module で読めなければ script で試す
    }
  }
  return { ok: false, text: null }
}

export function stripCssComments(src) {
  try {
    const root = postcss.parse(src)
    root.walkComments((c) => c.remove())
    return { ok: true, text: root.toString() }
  } catch {
    return { ok: false, text: null }
  }
}
