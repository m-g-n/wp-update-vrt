export function safePath(p) {
  if (typeof p !== 'string' || p === '' || p.startsWith('/') || p.split('/').includes('..')) {
    throw new Error('パスが不正')
  }
  return p
}
