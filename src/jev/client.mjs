// API: https://docs.typesafe.ai/api（2026-09-28 に確認）
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODEL = 'jev-latest'
const RETRY_STATUSES = new Set([429, 529])

export class JevError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'JevError'
    this.status = status
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createJevClient({ apiKey, fetchImpl = fetch, sleep = defaultSleep, maxRetries = 3, timeoutMs = 30_000 }) {
  if (!apiKey) throw new Error('TYPESAFE_API_KEY が未設定')
  return {
    async ask(state, questions) {
      for (let attempt = 0; ; attempt++) {
        let res
        try {
          res = await fetchImpl(JEV_ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ state, model: JEV_MODEL, questions }),
            signal: AbortSignal.timeout(timeoutMs),
          })
        } catch {
          if (attempt >= maxRetries) throw new JevError(0, 'network')
          await sleep(1000 * 2 ** attempt)
          continue
        }
        if (res.ok) {
          try {
            return await res.json()
          } catch {
            throw new JevError(-1, 'bad_response')
          }
        }
        if (RETRY_STATUSES.has(res.status) && attempt < maxRetries) {
          await sleep(1000 * 2 ** attempt)
          continue
        }
        throw new JevError(res.status, `Jev HTTP ${res.status}`)
      }
    },
  }
}
