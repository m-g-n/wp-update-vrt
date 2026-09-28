import AdmZip from 'adm-zip'

export function tree(files) {
  return new Map(Object.entries(files).map(([p, c]) => [p, Buffer.from(c)]))
}

// WordPress.org の配布 zip と同じく、先頭に `slug/` を付けて固める
export function makeZip(slug, files) {
  const zip = new AdmZip()
  for (const [p, c] of Object.entries(files)) zip.addFile(`${slug}/${p}`, Buffer.from(c))
  return zip.toBuffer()
}
