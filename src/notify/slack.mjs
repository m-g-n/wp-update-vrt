// 失敗したときだけ送る。成功時の通知は出さない（毎日同じものが届くと読まれなくなるため）
export async function notifyFailure({ webhookUrl, runUrl, fetchImpl = fetch }) {
  if (!webhookUrl) throw new Error('SLACK_WEBHOOK_URL が未設定')
  const res = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `wp-update-vrt の日次処理が失敗しました: ${runUrl}` }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Slack への通知に失敗 (HTTP ${res.status})`)
}
