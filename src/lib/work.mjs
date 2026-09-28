import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { safePath } from './safe-path.mjs'
import { seal, unseal } from './seal.mjs'

// ジョブ間はこのディレクトリだけで受け渡す（Actions のアーティファクトになる。保持は1日）
export async function writeWorkFile(workDir, rel, data) {
  const f = join(workDir, safePath(rel))
  await mkdir(dirname(f), { recursive: true })
  await writeFile(f, data)
}

export const writeWorkJSON = (workDir, rel, obj) => writeWorkFile(workDir, rel, JSON.stringify(obj, null, 2))

export const readWorkFile = (workDir, rel) => readFile(join(workDir, safePath(rel)))

// 組（スラッグ・バージョン）を含むものはこちらで置く。平文で置いてよいのは jobs.json（ハッシュだけ）と zips/ だけ
export const writeWorkSealed = (workDir, rel, obj, key) => writeWorkFile(workDir, rel, seal(obj, key))

export const readWorkSealed = async (workDir, rel, key) => unseal(await readWorkFile(workDir, rel), key)

export async function workExists(workDir, rel) {
  try {
    await access(join(workDir, safePath(rel)))
    return true
  } catch {
    return false
  }
}

export async function readWorkJSON(workDir, rel, fallback) {
  try {
    return JSON.parse(await readFile(join(workDir, safePath(rel)), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT' && arguments.length >= 3) return fallback
    throw err
  }
}
