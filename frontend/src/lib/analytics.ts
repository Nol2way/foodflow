// ฟังก์ชันคำนวณวิเคราะห์ช่วงพีค/ออฟพีค และคาดการณ์รายชั่วโมง
// ใช้สถิติแบบตรงไปตรงมา ตรวจสอบย้อนกลับได้ ไม่ใช่โมเดลเรียนรู้ของเครื่อง

export interface HourRow {
  day_of_week: number // 0 = อาทิตย์
  hour_of_day: number // 0-23 ตามเขตเวลาของร้าน
  order_count: number
  revenue_total: number
}

export type Level = 'peak' | 'normal' | 'off' | 'none'

// เกณฑ์เทียบกับค่าเฉลี่ยของ "ชั่วโมงที่มีออเดอร์"
export const PEAK_RATIO = 1.25 // ตั้งแต่ 125% ของค่าเฉลี่ยขึ้นไป = พีค
export const OFF_RATIO = 0.5 // ไม่เกิน 50% ของค่าเฉลี่ย = ออฟพีค

export const DAY_NAMES = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์']
export const DAY_SHORT = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส']

export function hourTotals(rows: HourRow[]): number[] {
  const totals = Array<number>(24).fill(0)
  for (const r of rows) totals[r.hour_of_day] += Number(r.order_count)
  return totals
}

export function dayTotals(rows: HourRow[]): number[] {
  const totals = Array<number>(7).fill(0)
  for (const r of rows) totals[r.day_of_week] += Number(r.order_count)
  return totals
}

export function classifyHours(totals: number[]): Level[] {
  const active = totals.filter((t) => t > 0)
  if (active.length === 0) return totals.map(() => 'none' as Level)
  const mean = active.reduce((s, t) => s + t, 0) / active.length
  return totals.map((t): Level => {
    if (t <= 0) return 'none'
    if (t >= mean * PEAK_RATIO) return 'peak'
    if (t <= mean * OFF_RATIO) return 'off'
    return 'normal'
  })
}

const pad = (h: number) => String(h).padStart(2, '0')

// รวมชั่วโมงติดกันเป็นช่วง เช่น [11,12,13,18] -> ['11:00–14:00', '18:00–19:00']
export function toRanges(hours: number[]): string[] {
  const sorted = [...hours].sort((a, b) => a - b)
  const out: string[] = []
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    out.push(`${pad(sorted[i])}:00–${pad(sorted[j] + 1)}:00`)
    i = j + 1
  }
  return out
}

// จำนวนครั้งที่แต่ละวันในสัปดาห์ปรากฏในช่วง days วันล่าสุด (นับรวมวันนี้)
export function weekdayCounts(days: number, today: Date = new Date()): number[] {
  const counts = Array<number>(7).fill(0)
  for (let i = 0; i < days; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    counts[d.getDay()]++
  }
  return counts
}

export interface Forecast {
  hours: number[] // ออเดอร์ที่คาดว่าจะเข้าในแต่ละชั่วโมง
  enough: boolean // มีวันเดียวกันย้อนหลังอย่างน้อย 2 ครั้งหรือไม่
  samples: number
}

// คาดการณ์ = ค่าเฉลี่ยของ "วันเดียวกันในสัปดาห์" ย้อนหลังในช่วง days วัน
export function forecastForDay(rows: HourRow[], dow: number, days: number, today: Date = new Date()): Forecast {
  const samples = weekdayCounts(days, today)[dow]
  const hours = Array<number>(24).fill(0)
  if (samples > 0) {
    for (const r of rows) {
      if (r.day_of_week === dow) hours[r.hour_of_day] += Number(r.order_count) / samples
    }
  }
  return { hours, enough: samples >= 2, samples }
}

export interface InsightInput {
  rows: HourRow[]
}

// สรุปข้อสังเกตเป็นภาษาไทยจากกฎที่ตายตัว (ไม่ใช้ AI เดาตัวเลข)
export function buildInsights({ rows }: InsightInput): string[] {
  const hours = hourTotals(rows)
  const total = hours.reduce((s, t) => s + t, 0)
  if (total === 0) return []
  const levels = classifyHours(hours)
  const insights: string[] = []

  const peakHours = levels.flatMap((l, h) => (l === 'peak' ? [h] : []))
  if (peakHours.length > 0) {
    const share = peakHours.reduce((s, h) => s + hours[h], 0) / total
    insights.push(`ช่วงพีค ${toRanges(peakHours).join(', ')} มีออเดอร์ ${(share * 100).toFixed(0)}% ของทั้งหมด ควรเตรียมของและคนให้พร้อม`)
  }

  // ออฟพีคนับเฉพาะช่วงที่ร้านเปิดจริง (ระหว่างชั่วโมงแรกถึงชั่วโมงสุดท้ายที่มีออเดอร์)
  const activeHours = hours.flatMap((t, h) => (t > 0 ? [h] : []))
  const first = activeHours[0]
  const last = activeHours[activeHours.length - 1]
  const offHours = levels.flatMap((l, h) => (l === 'off' && h >= first && h <= last ? [h] : []))
  if (offHours.length > 0) {
    insights.push(`ช่วงเงียบ ${toRanges(offHours).join(', ')} เหมาะกับการเตรียมของ พักพนักงาน หรือทำโปรโมชันดึงลูกค้า`)
  }

  const days = dayTotals(rows)
  const busyDays = days.flatMap((t, d) => (t > 0 ? [d] : []))
  if (busyDays.length >= 2) {
    const max = busyDays.reduce((a, b) => (days[b] > days[a] ? b : a))
    const min = busyDays.reduce((a, b) => (days[b] < days[a] ? b : a))
    insights.push(`วันที่ออเดอร์มากที่สุดคือวัน${DAY_NAMES[max]} และน้อยที่สุดคือวัน${DAY_NAMES[min]}`)
  }
  return insights
}
