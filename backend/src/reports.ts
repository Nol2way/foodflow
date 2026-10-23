// รายงานสรุปรายวันทาง LINE Messaging API (LINE Notify ปิดบริการแล้วตั้งแต่ 31 มี.ค. 2025)
// - ส่งทันที: POST /api/reports/daily/send (เจ้าของ, ผู้จัดการ)
// - ส่งอัตโนมัติ: Cron ของ Worker ทุกชั่วโมง ส่งให้ร้านที่ถึงเวลา REPORT_HOUR ตามเขตเวลาของร้าน
import type { Env } from './env.ts'
import { asService } from './supabase.ts'
import { reportText, type DailyReport } from '../../frontend/src/lib/report.ts'

export class LineError extends Error {}

export async function pushLine(token: string, to: string, text: string): Promise<void> {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  })
  if (!res.ok) throw new LineError(`line_${res.status}`)
}

export const reportHour = (env: Env) => {
  const h = Number(env.REPORT_HOUR ?? 22)
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 22
}

// เรียกจาก Cron ทุกชั่วโมง · คืนจำนวนร้านที่ส่งสำเร็จ (ร้านหนึ่งพังไม่กระทบร้านอื่น)
export async function sendDueReports(env: Env): Promise<{ sent: number; failed: number }> {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return { sent: 0, failed: 0 }
  const db = asService(env)
  const targets = await db.rpc<{ restaurant_id: string; line_to: string; local_date: string; local_hour: number }[]>('daily_report_targets', {})
  let sent = 0
  let failed = 0
  for (const t of targets.filter((x) => x.local_hour === reportHour(env))) {
    try {
      const report = await db.rpc<DailyReport | null>('daily_report_data', { p_restaurant_id: t.restaurant_id, p_date: t.local_date })
      if (!report) continue
      await pushLine(env.LINE_CHANNEL_ACCESS_TOKEN, t.line_to, reportText(report))
      sent++
    } catch (e) {
      failed++
      console.error('daily report failed', t.restaurant_id, e instanceof Error ? e.message : e)
    }
  }
  return { sent, failed }
}
