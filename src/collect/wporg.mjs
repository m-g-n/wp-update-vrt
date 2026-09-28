import AdmZip from 'adm-zip'

export class NotOnWporgError extends Error {
  constructor() {
    super('not_on_wporg')
    this.name = 'NotOnWporgError'
  }
}

const MAX_ZIP_BYTES = 50 * 1024 * 1024
const MAX_TREE_BYTES = 200 * 1024 * 1024

export function zipUrl(slug, version) {
  return `https://downloads.wordpress.org/plugin/${encodeURIComponent(slug)}.${encodeURIComponent(version)}.zip`
}

// 存在しない版・有料版は 404 になる（2026-09-28 に実測）
export async function fetchZip(slug, version, { fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  const res = await fetchImpl(zipUrl(slug, version), { signal: AbortSignal.timeout(timeoutMs) })
  if (res.status === 404) throw new NotOnWporgError()
  if (!res.ok) throw new Error(`zip の取得に失敗 (HTTP ${res.status})`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_ZIP_BYTES) throw new Error('zip が大きすぎる')
  return buf
}

// zip を Map<プラグイン内の相対パス, Buffer> にする。展開前に宣言サイズで上限を見る（zip 爆弾対策）
export function readTree(zipBuffer, slug) {
  const zip = new AdmZip(zipBuffer)
  const prefix = `${slug}/`
  const out = new Map()
  let total = 0
  let actualTotal = 0
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const name = entry.entryName.replace(/\\/g, '/')
    if (name.startsWith('/') || name.split('/').includes('..')) throw new Error('zip に不正なパスがある')
    if (!name.startsWith(prefix)) continue
    total += entry.header.size
    if (total > MAX_TREE_BYTES) throw new Error('展開後のサイズが大きすぎる')
    const data = entry.getData()
    // 宣言サイズが間違っている zip に対する多層防御
    actualTotal += data.length
    if (actualTotal > MAX_TREE_BYTES) throw new Error('展開後のサイズが大きすぎる')
    out.set(name.slice(prefix.length), data)
  }
  if (out.size === 0) throw new Error('zip にプラグインのファイルが無い')
  return out
}
