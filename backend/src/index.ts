// FoodFlow backend — Cloudflare Worker (Hono)
// scheduled: Cron ทุกชั่วโมง (wrangler.toml) ส่งรายงานรายวันทาง LINE ให้ร้านที่ถึงเวลา
import { createApp } from './app.ts'
import { sendDueReports } from './reports.ts'
import type { Env } from './env.ts'

const app = createApp()

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sendDueReports(env).then((r) => console.log('daily reports', r)))
  },
}
