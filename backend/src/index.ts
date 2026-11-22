// Plato backend — Cloudflare Worker (Hono)
// scheduled: Cron ทุกชั่วโมง (wrangler.toml) ส่งรายงานรายวันทาง LINE ให้ร้านที่ถึงเวลา
import { createApp } from './app.ts'
import { sendDueReports, sendMorningDigest, retryDayCloseNotifications } from './reports.ts'
import type { Env } from './env.ts'

const app = createApp()

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sendDueReports(env, _event.scheduledTime).then((r) => console.log('daily reports', r)))
    ctx.waitUntil(sendMorningDigest(env, _event.scheduledTime).then((r) => console.log('morning reports', r)))
    ctx.waitUntil(retryDayCloseNotifications(env))
  },
}
