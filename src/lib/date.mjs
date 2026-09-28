// 日次の区切りは日本時間（JST 04:41 に動くので、UTC の日付だと前日になる）
export function todayJst(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10)
}
