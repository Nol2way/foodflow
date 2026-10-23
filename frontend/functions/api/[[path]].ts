// Cloudflare Pages Functions: ทุก request ที่ /api/* ใช้ backend ชุดเดียวกับ Worker
// ตั้งตัวแปรใน Pages > Settings > Variables and Secrets (ชื่อเดียวกับ backend/wrangler.toml)
// ต้องติดตั้งแพ็กเกจของ backend ก่อน build: Pages ใช้คำสั่ง `npm run build:pages` (ดู docs/SETUP.md)
import { createApp } from '../../../backend/src/app.ts'
import type { Env } from '../../../backend/src/env.ts'

const app = createApp()

export const onRequest: PagesFunction<Env> = (ctx) =>
  app.fetch(ctx.request, ctx.env, ctx as unknown as ExecutionContext)
