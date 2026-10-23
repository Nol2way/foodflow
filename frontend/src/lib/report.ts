// ไม่มี import เพื่อให้ทดสอบด้วย node ได้โดยตรง และให้ backend ใช้ร่วมกันได้ (ส่ง LINE อัตโนมัติ)
// ข้อความสรุปรายวันจาก daily_report (0018)

export interface DailyReport {
  restaurant: string
  date: string // YYYY-MM-DD
  orders: number
  revenue: number
  discount: number
  revenue_last_week: number
  cancelled: number
  payments: Record<string, number>
  top_items: { name: string; quantity: number; amount: number }[]
  peak_hour: number | null
  waste: { name: string; quantity: number; unit: string; cost: number }[]
  expenses: number
  new_members: number
  points_earned: number
  points_redeemed: number
}

const PAY_LABEL: Record<string, string> = { cash: 'เงินสด', promptpay: 'พร้อมเพย์', card: 'บัตร', other: 'อื่นๆ', unknown: 'ไม่ระบุ' }
const money = (n: number) => '฿' + Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 })
const int = (n: number) => Number(n).toLocaleString('th-TH')

export function thaiDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const months = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
  return `${d} ${months[m - 1]} ${y + 543}`
}

// เปลี่ยนแปลงเทียบสัปดาห์ก่อน (null = สัปดาห์ก่อนไม่มียอด)
export function changePct(now: number, before: number): number | null {
  if (!before) return null
  return Math.round(((now - before) / before) * 1000) / 10
}

export function reportText(r: DailyReport): string {
  const revenue = Number(r.revenue)
  const lines = [`📊 สรุปยอด ${r.restaurant}`, `วันที่ ${thaiDate(r.date)}`, '']
  lines.push(`💰 ยอดขาย ${money(revenue)} (${int(r.orders)} บิล)`)
  if (r.orders > 0) lines.push(`   เฉลี่ย ${money(Math.round(revenue / r.orders))}/บิล`)
  const ch = changePct(revenue, Number(r.revenue_last_week))
  if (ch !== null) lines.push(`   ${ch >= 0 ? '📈' : '📉'} เทียบวันเดียวกันสัปดาห์ก่อน ${ch >= 0 ? '+' : ''}${ch}%`)
  if (Number(r.discount) > 0) lines.push(`🏷️ ส่วนลดรวม ${money(Number(r.discount))}`)
  const pays = Object.entries(r.payments ?? {}).filter(([, v]) => Number(v) > 0)
  if (pays.length) lines.push(`💳 ${pays.map(([k, v]) => `${PAY_LABEL[k] ?? k} ${money(Number(v))}`).join(' · ')}`)
  if (r.top_items.length) {
    lines.push('', '🔥 ขายดี')
    r.top_items.forEach((t, i) => lines.push(`${i + 1}. ${t.name} ${int(t.quantity)} ที่`))
  }
  if (r.peak_hour !== null && r.peak_hour !== undefined) {
    lines.push('', `⏰ ช่วงคนเยอะสุด ${String(r.peak_hour).padStart(2, '0')}:00–${String((r.peak_hour + 1) % 24).padStart(2, '0')}:00`)
  }
  if (r.waste.length) {
    const total = r.waste.reduce((s, w) => s + Number(w.cost), 0)
    lines.push('', `🗑️ ของเสีย รวม ${money(total)}`)
    for (const w of r.waste.slice(0, 5)) lines.push(`- ${w.name} ${Number(w.quantity).toLocaleString('th-TH')} ${w.unit} (${money(Number(w.cost))})`)
  }
  if (Number(r.expenses) > 0) lines.push('', `🧾 รายจ่ายวันนี้ ${money(Number(r.expenses))}`)
  if (r.new_members || r.points_earned || r.points_redeemed) {
    lines.push('', `⭐ สมาชิกใหม่ ${int(r.new_members)} คน · แจกแต้ม ${int(r.points_earned)} · ถูกแลก ${int(r.points_redeemed)}`)
  }
  if (r.cancelled > 0) lines.push(`❌ ยกเลิก ${int(r.cancelled)} บิล`)
  if (r.orders === 0) lines.push('', 'วันนี้ยังไม่มีบิลที่ชำระแล้ว')
  return lines.join('\n').slice(0, 4900) // LINE รับข้อความได้ไม่เกิน 5,000 ตัวอักษร
}
