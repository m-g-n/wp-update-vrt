import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { notifyFailure } from '../src/notify/slack.mjs'

describe('notifyFailure', () => {
  it('実行の URL だけを送る', async () => {
    let body
    const fetchImpl = async (url, init) => { body = JSON.parse(init.body); return new Response('ok', { status: 200 }) }
    await notifyFailure({ webhookUrl: 'https://hooks.slack.test/x', runUrl: 'https://github.com/o/r/actions/runs/1', fetchImpl })
    assert.match(body.text, /actions\/runs\/1/)
  })
  it('Webhook が未設定なら投げる（黙って通知が消えないように）', async () => {
    await assert.rejects(notifyFailure({ webhookUrl: '', runUrl: 'u' }))
  })
  it('Slack がエラーを返したら投げる', async () => {
    const fetchImpl = async () => new Response('no', { status: 404 })
    await assert.rejects(notifyFailure({ webhookUrl: 'https://hooks.slack.test/x', runUrl: 'u', fetchImpl }))
  })
})
