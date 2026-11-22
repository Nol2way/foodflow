// รายงานสรุปรายวันทาง LINE Messaging API (LINE Notify ปิดบริการแล้วตั้งแต่ 31 มี.ค. 2025)
// - ส่งทันที: POST /api/reports/daily/send (เจ้าของ, ผู้จัดการ)
// - ส่งอัตโนมัติ: Cron ของ Worker ทุกชั่วโมง ส่งให้ร้านที่ถึงเวลา REPORT_HOUR ตามเขตเวลาของร้าน
import type { Env } from './env.ts'
import { asService } from './supabase.ts'
import { reportText, type DailyReport } from '../../frontend/src/lib/report.ts'
import { dayCloseText, type DayClose } from '../../frontend/src/lib/accounting.ts'

export class LineError extends Error {}

export async function pushLine(token: string, to: string, text: string, retryKey?: string): Promise<void> {
  let res: Response
  try { res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(retryKey ? { 'X-Line-Retry-Key': retryKey } : {}) },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
    signal: AbortSignal.timeout(15_000),
  }) } catch { throw new LineError('line_unavailable') }
  if (res.status === 409 && retryKey && res.headers.has('x-line-accepted-request-id')) return
  if (!res.ok) throw new LineError(`line_${res.status}`)
}

export const reportHour = (env: Env) => {
  const h = Number(env.REPORT_HOUR?.trim() || 22)
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 22
}

// เรียกจาก Cron ทุกชั่วโมง / คืนจำนวนร้านที่ส่งสำเร็จ (ร้านหนึ่งพังไม่กระทบร้านอื่น)
export async function sendDueReports(env: Env, scheduledTime = Date.now()): Promise<{ sent: number; failed: number }> {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return { sent: 0, failed: 0 }
  const db = asService(env)
  const targets = await db.rpc<{ restaurant_id: string; line_to: string; local_date: string; local_hour: number }[]>('daily_report_targets', { p_scheduled_at: new Date(scheduledTime).toISOString() })
  const pending = await db.rpc<{ restaurant_id: string; line_to: string; report_date: string }[]>('report_dispatch_pending', { p_morning: false })
  const due = targets.filter(x => x.local_hour === reportHour(env)).map(t => ({ restaurant_id: t.restaurant_id, line_to: t.line_to, report_date: t.local_hour === 0 ? new Date(Date.parse(t.local_date + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10) : t.local_date }))
  let sent = 0
  let failed = 0
  for (const t of [...due, ...pending]) {
    const date = t.report_date
    const args = { p_restaurant_id: t.restaurant_id, p_report_date: date }
    try {
      const key = await db.rpc<string | null>('report_dispatch_claim', args)
      if (!key) continue
      const report = await db.rpc<DailyReport | null>('daily_report_data', { p_restaurant_id: t.restaurant_id, p_date: date })
      if (!report) throw new LineError('report_unavailable')
      await pushLine(env.LINE_CHANNEL_ACCESS_TOKEN, t.line_to, reportText(report), key)
      await db.rpc('report_dispatch_finish', { ...args, p_success: true })
      sent++
    } catch (e) {
      failed++
      try { await db.rpc('report_dispatch_finish', { ...args, p_success: false }) } catch { /* lease expires for retry */ }
      console.error('daily report failed', t.restaurant_id, e instanceof Error ? e.message : e)
    }
  }
  return { sent, failed }
}

export async function sendMorningDigest(env: Env, scheduledTime = Date.now()): Promise<{ sent: number; failed: number }> {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return { sent: 0, failed: 0 }
  const db = asService(env)
  const targets = await db.rpc<{ restaurant_id: string; line_to: string; report_date: string }[]>('morning_report_targets', { p_scheduled_at: new Date(scheduledTime).toISOString() })
  const pending = await db.rpc<typeof targets>('report_dispatch_pending', { p_morning: true })
  let sent = 0, failed = 0
  for (const target of [...targets, ...pending]) {
    const args = { p_restaurant_id: target.restaurant_id, p_report_date: target.report_date }
    try {
      const key = await db.rpc<string | null>('morning_dispatch_claim', args)
      if (!key) continue
      const report = await db.rpc<DailyReport>('daily_report_data', { p_restaurant_id: target.restaurant_id, p_date: target.report_date })
      const stock = await db.rpc<{ low_stock: { name: string; quantity: number; unit: string; par: number }[]; expiring: { name: string; quantity: number; unit: string; expiry_date: string }[] }>('morning_stock_data', { p_restaurant_id: target.restaurant_id, p_date: target.report_date })
      const text = [reportText(report), '\nสต็อกต่ำกว่า Par', ...stock.low_stock.map(i => `${i.name}: ${i.quantity} ${i.unit} / Par ${i.par}`), '\nล็อตใกล้หมดอายุ', ...stock.expiring.map(i => `${i.name}: ${i.quantity} ${i.unit} (${i.expiry_date})`)].join('\n').slice(0, 4900)
      await pushLine(env.LINE_CHANNEL_ACCESS_TOKEN, target.line_to, text, key)
      await db.rpc('morning_dispatch_finish', { ...args, p_success: true })
      sent++
    } catch {
      failed++
      try { await db.rpc('morning_dispatch_finish', { ...args, p_success: false }) } catch { /* retry after lease */ }
    }
  }
  return { sent, failed }
}

export async function retryDayCloseNotifications(env: Env): Promise<void> {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return
  const db = asService(env)
  const targets = await db.rpc<{ restaurant_id: string; report_date: string; line_to: string; summary: DayClose }[]>('day_close_dispatch_pending', {})
  for (const target of targets) {
    const args = { p_restaurant_id: target.restaurant_id, p_report_date: target.report_date }
    try {
      const key = await db.rpc<string | null>('day_close_dispatch_claim', args)
      if (!key) continue
      await pushLine(env.LINE_CHANNEL_ACCESS_TOKEN, target.line_to, dayCloseText(target.summary), key)
      await db.rpc('day_close_dispatch_finish', { ...args, p_success: true })
    } catch {
      try { await db.rpc('day_close_dispatch_finish', { ...args, p_success: false }) } catch { /* lease expires */ }
    }
  }
}
