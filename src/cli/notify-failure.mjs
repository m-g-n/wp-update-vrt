import { notifyFailure } from '../notify/slack.mjs'
import { reportFatal } from '../lib/log.mjs'

notifyFailure({ webhookUrl: process.env.SLACK_WEBHOOK_URL, runUrl: process.env.RUN_URL }).catch((err) => {
  reportFatal('notify', err)
  process.exit(1)
})
