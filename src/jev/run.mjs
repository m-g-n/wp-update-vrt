import { JevError } from './client.mjs'
import { QUESTIONS } from './questions.mjs'

const max = (a, b) => (a === null ? b : Math.max(a, b))

function noul(res, id) {
  const v = res?.answers?.[id]?.noul
  if (typeof v !== 'number') throw new JevError(-1, 'bad_response')
  return v
}

// 差分の塊1つを1つの state にする（1問で大きく聞くと弱く、小さく分けると強い）
// circuitOpen: この回は Jev の失敗が続いたので聞かない（止まっている Jev に待たされ続けないように）
export async function runJev(hunks, client, { maxHunks, circuitOpen = false }) {
  const base = {
    emits_markup: null, runs_on_front: null, mutates_dom: null, js_front_dom: null,
    model: null, hunks_sent: 0, error: null, large_diff: false,
  }
  const total = hunks.php.length + hunks.js.length
  if (total === 0) return base
  // 大きな書き換えは予測が当たりにくく費用も膨らむので、聞かずに VRT へ回す
  if (total > maxHunks) return { ...base, large_diff: true }
  if (circuitOpen) return { ...base, error: 'circuit_open' }

  const r = { ...base }
  try {
    for (const h of hunks.php) {
      const res = await client.ask({ file: h.path, diff: h.text }, { emits_markup: QUESTIONS.emits_markup })
      r.emits_markup = max(r.emits_markup, noul(res, 'emits_markup'))
      r.model = res.model ?? r.model
      r.hunks_sent++
    }
    for (const h of hunks.js) {
      const res = await client.ask(
        { file: h.path, diff: h.text },
        { runs_on_front: QUESTIONS.runs_on_front, mutates_dom: QUESTIONS.mutates_dom },
      )
      const front = noul(res, 'runs_on_front')
      const dom = noul(res, 'mutates_dom')
      r.runs_on_front = max(r.runs_on_front, front)
      r.mutates_dom = max(r.mutates_dom, dom)
      r.js_front_dom = max(r.js_front_dom, front * dom)
      r.model = res.model ?? r.model
      r.hunks_sent++
    }
  } catch (err) {
    if (!(err instanceof JevError) || err.status === 401) throw err
    const error = err.status === 0 ? 'network' : err.status === -1 ? 'bad_response' : `http_${err.status}`
    return { ...base, hunks_sent: r.hunks_sent, error }
  }
  return r
}
