import postcss from 'postcss'
import selectorParser from 'postcss-selector-parser'

// names: セレクタに出てくるクラス名と ID（テーマ側の上書き CSS が参照しうるもの）
// decls: 「@規則|セレクタ{プロパティ:値}」の集合。新旧の対称差を「変わった宣言の数」とみなす
export function cssFacts(text) {
  const root = postcss.parse(text)
  const names = new Set()
  const decls = new Set()
  root.walkRules((rule) => {
    try {
      selectorParser((sel) => {
        sel.walkClasses((c) => names.add(`.${c.value}`))
        sel.walkIds((i) => names.add(`#${i.value}`))
      }).processSync(rule.selector)
    } catch {
      // 読めないセレクタは数えない
    }
    const ctx = rule.parent?.type === 'atrule' ? `@${rule.parent.name} ${rule.parent.params}|` : ''
    rule.walkDecls((d) => decls.add(`${ctx}${rule.selector}{${d.prop}:${d.value}${d.important ? '!important' : ''}}`))
  })
  return { names, decls }
}
