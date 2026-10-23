// ไม่มี import เพื่อให้ทดสอบด้วย node ได้โดยตรง และให้ backend ใช้ร่วมกับ AI ได้
// แนะนำโปรจากข้อมูลขาย (promo_insights ใน 0018) ด้วยกติกาที่อธิบายได้ · ไม่ลดจนต่ำกว่าต้นทุน

export interface Insights {
  days: number
  hours: { hour: number; orders_per_day: number; revenue: number }[]
  items: {
    id: string
    name: string
    price: number
    unit_cost: number
    has_recipe: boolean
    quantity: number
    revenue: number
    is_available: boolean
  }[]
  active_promotions: string[]
}

export interface SuggestedPromo {
  name: string
  discount_type: 'percent' | 'amount'
  value: number
  min_subtotal: number
  start_time: string | null // HH:MM
  end_time: string | null
  item_ids: string[]
}

export interface Suggestion {
  key: string
  title: string
  reason: string
  promo: SuggestedPromo
  source: 'rule' | 'ai'
}

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`
const MIN_MARGIN = 1.3 // ราคาหลังลดต้องไม่ต่ำกว่าต้นทุน × 1.3

// ส่วนลด % สูงสุดที่ยังได้กำไร (ไม่มีสูตร = ไม่รู้ต้นทุน ให้ลดได้ไม่เกิน 10%)
export function safePercent(price: number, cost: number, hasRecipe: boolean, cap = 20): number {
  if (!hasRecipe || cost <= 0) return Math.min(cap, 10)
  const pct = Math.floor((1 - (cost * MIN_MARGIN) / price) * 100)
  return Math.max(0, Math.min(cap, pct))
}

// ช่วงเงียบ: 2–3 ชั่วโมงติดกันที่ออเดอร์ต่ำกว่าครึ่งของค่าเฉลี่ยชั่วโมงที่เปิดขาย
export function quietWindow(hours: Insights['hours']): { start: number; end: number; ratio: number } | null {
  const open = hours.filter((h) => h.orders_per_day > 0)
  if (open.length < 4) return null
  const avg = open.reduce((s, h) => s + h.orders_per_day, 0) / open.length
  const first = Math.min(...open.map((h) => h.hour))
  const last = Math.max(...open.map((h) => h.hour))
  const at = (h: number) => hours.find((x) => x.hour === h)?.orders_per_day ?? 0
  let best: { start: number; end: number; ratio: number } | null = null
  for (const len of [3, 2]) {
    for (let s = first + 1; s + len - 1 < last; s++) {
      const mean = Array.from({ length: len }, (_, i) => at(s + i)).reduce((a, b) => a + b, 0) / len
      const ratio = mean / avg
      if (ratio < 0.5 && (!best || ratio < best.ratio)) best = { start: s, end: s + len, ratio }
    }
    if (best) return best
  }
  return best
}

export function ruleSuggestions(ins: Insights): Suggestion[] {
  const out: Suggestion[] = []
  const totalOrders = ins.hours.reduce((s, h) => s + h.orders_per_day, 0) * ins.days
  if (totalOrders < 20) return out // ข้อมูลน้อยเกินไป แนะนำแล้วไม่น่าเชื่อถือ

  // 1) ช่วงเวลาเงียบ → ลดทั้งบิลเฉพาะช่วงนั้น
  const q = quietWindow(ins.hours)
  if (q) {
    out.push({
      key: `quiet-${q.start}`,
      source: 'rule',
      title: `ลด 10% ช่วง ${hh(q.start)}–${hh(q.end)}`,
      reason: `ช่วงนี้ออเดอร์เฉลี่ยแค่ ${Math.round(q.ratio * 100)}% ของชั่วโมงปกติ ดึงลูกค้าเข้าร้านช่วงเงียบ`,
      promo: { name: `ช่วงเงียบลด 10% (${hh(q.start)}–${hh(q.end)})`, discount_type: 'percent', value: 10, min_subtotal: 0, start_time: hh(q.start), end_time: hh(q.end), item_ids: [] },
    })
  }

  // 2) เมนูขายช้าแต่กำไรดี → ลดเฉพาะเมนู
  const sellable = ins.items.filter((i) => i.is_available && Number(i.price) > 0)
  if (sellable.length >= 3) {
    const sorted = [...sellable].sort((a, b) => a.quantity - b.quantity)
    const cutoff = sorted[Math.floor(sorted.length * 0.3)].quantity
    const slow = sorted
      .filter((i) => i.quantity <= cutoff)
      .map((i) => ({ i, pct: safePercent(Number(i.price), Number(i.unit_cost), i.has_recipe, 15) }))
      .filter((x) => x.pct >= 5)
      .slice(0, 2)
    for (const { i, pct } of slow) {
      const margin = i.has_recipe ? Math.round((1 - Number(i.unit_cost) / Number(i.price)) * 100) : null
      out.push({
        key: `slow-${i.id}`,
        source: 'rule',
        title: `${i.name} ลด ${pct}%`,
        reason: `ขายได้ ${i.quantity} ที่ใน ${ins.days} วัน (กลุ่มขายช้า)${margin !== null ? ` กำไรต่อจาน ${margin}% ลดแล้วยังได้กำไร` : ' (ยังไม่มีสูตร ไม่รู้ต้นทุน จึงลดไม่เกิน 10%)'}`,
        promo: { name: `${i.name} ลด ${pct}%`.slice(0, 80), discount_type: 'percent', value: pct, min_subtotal: 0, start_time: null, end_time: null, item_ids: [i.id] },
      })
    }
  }

  // 3) เพิ่มยอดต่อบิล → ซื้อครบลด
  const revenue = ins.hours.reduce((s, h) => s + Number(h.revenue), 0)
  if (revenue > 0 && totalOrders > 0) {
    const avg = revenue / totalOrders
    const threshold = Math.max(100, Math.ceil((avg * 1.3) / 50) * 50)
    const off = Math.max(5, Math.round((threshold * 0.05) / 5) * 5)
    out.push({
      key: `basket-${threshold}`,
      source: 'rule',
      title: `ซื้อครบ ฿${threshold} ลด ฿${off}`,
      reason: `บิลเฉลี่ยประมาณ ฿${Math.round(avg)} ตั้งเป้าให้สั่งเพิ่มอีกนิด (+30%) โดยลดแค่ ${Math.round((off / threshold) * 100)}%`,
      promo: { name: `ซื้อครบ ${threshold} ลด ${off} บาท`, discount_type: 'amount', value: off, min_subtotal: threshold, start_time: null, end_time: null, item_ids: [] },
    })
  }
  return out
}

// ตรวจโปรที่ AI เสนอ: ตัดของที่ไม่ปลอดภัย/ผิดรูปแบบทิ้ง (AI ห้ามสร้างอะไรที่ระบบรับไม่ได้)
export function validateSuggested(p: unknown, ins: Insights): SuggestedPromo | null {
  if (!p || typeof p !== 'object') return null
  const r = p as Record<string, unknown>
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 80) : ''
  const type = r.discount_type === 'percent' || r.discount_type === 'amount' ? r.discount_type : null
  const value = Number(r.value)
  const min = Number(r.min_subtotal ?? 0)
  const time = (v: unknown) => (typeof v === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(v) ? v : null)
  const ids = Array.isArray(r.item_ids) ? r.item_ids.filter((x): x is string => typeof x === 'string') : []
  if (!name || !type || !Number.isFinite(value) || value <= 0 || !Number.isFinite(min) || min < 0 || min > 100000) return null
  if (type === 'percent' && value > 30) return null // AI ห้ามเสนอลดแรงเกิน 30%
  if (type === 'amount' && value > 500) return null
  if (ids.some((id) => !ins.items.some((i) => i.id === id))) return null
  // โปรรายเมนู: ส่วนลดต้องไม่ทำให้ขาดทุน
  for (const id of ids) {
    const i = ins.items.find((x) => x.id === id)!
    const pct = type === 'percent' ? value : (value / Number(i.price)) * 100
    if (pct > safePercent(Number(i.price), Number(i.unit_cost), i.has_recipe, 30)) return null
  }
  const start = time(r.start_time)
  const end = time(r.end_time)
  if ((start && !end) || (!start && end) || (start && end && end <= start)) return null
  return { name, discount_type: type, value: Math.round(value * 100) / 100, min_subtotal: Math.round(min), start_time: start, end_time: end, item_ids: [...new Set(ids)] }
}
