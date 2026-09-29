import { isValidSlug, isValidVersion } from '../contracts/candidates.mjs'

// 保守先に依存しない基準データを毎日貯める（WordPress.org 全体に広げるフェーズ2の先行分）。
// 処理対象の一覧から個別サイトの利用状況が推測されにくくなる（spec §8 公開リポジトリでの配慮）
const POPULAR_API = 'https://api.wordpress.org/plugins/info/1.2/?action=query_plugins'
  + '&request[browse]=popular'
  + '&request[fields][description]=0&request[fields][sections]=0&request[fields][tags]=0'
  + '&request[fields][ratings]=0&request[fields][icons]=0&request[fields][banners]=0'
const PER_PAGE = 100

export async function fetchPopular(count, { fetchImpl = fetch } = {}) {
  const out = []
  for (let page = 1; out.length < count; page++) {
    const url = `${POPULAR_API}&request[per_page]=${PER_PAGE}&request[page]=${page}`
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`人気プラグインの取得に失敗 (HTTP ${res.status})`)
    const json = await res.json()
    const plugins = Array.isArray(json.plugins) ? json.plugins : []
    // 保守先の組（managewp からの入力）と同じ規則に合わないものは取らない。
    // WordPress.org には「1.0 beta」のような版番号もありうる
    for (const p of plugins) {
      if (isValidSlug(p.slug) && isValidVersion(p.version)) out.push({ slug: p.slug, version: p.version })
    }
    if (plugins.length < PER_PAGE || page >= (json.info?.pages ?? page)) break
  }
  return out.slice(0, count)
}

export function diffPopular(prevVersions, current) {
  const next = { ...prevVersions }
  const items = []
  for (const { slug, version } of current) {
    const prev = prevVersions[slug]
    // 前回の版は、この検査を入れる前に記録したものかもしれないので、組にする前にもう一度確かめる
    if (prev && prev !== version && isValidVersion(prev)) items.push({ slug, from: prev, to: version })
    next[slug] = version
  }
  return { items, next }
}
