// สูตรคำนวณของโมดูลสต็อกวัตถุดิบ (ใช้ร่วมกัน: หน้าเว็บ · backend · unit test)
// ฐานข้อมูลคำนวณซ้ำด้วยสูตรเดียวกันเสมอ (database/migrations/0027-0029) ตัวเลขในหน้าเว็บมีไว้แสดงผล/ตรวจก่อนส่ง

export type RecipeUnit = 'g' | 'ml' | 'pcs'
export type MovementType = 'receive' | 'recipe_deduct' | 'recipe_return' | 'count_adjust' | 'legacy'
export type VarianceColor = 'green' | 'yellow' | 'red'
export type AbcClass = 'A' | 'B' | 'C'

export const RECIPE_UNITS: { id: RecipeUnit; label: string }[] = [
  { id: 'g', label: 'กรัม (g)' },
  { id: 'ml', label: 'มิลลิลิตร (ml)' },
  { id: 'pcs', label: 'ชิ้น/ฟอง/ตัว (pcs)' },
]

export const MOVEMENT_LABEL: Record<MovementType, string> = {
  receive: 'นำเข้า',
  recipe_deduct: 'ตัดตามสูตร',
  recipe_return: 'คืนจากออเดอร์ยกเลิก',
  count_adjust: 'ปรับจากการนับ',
  legacy: 'ประวัติก่อนใช้ระบบใหม่',
}

export const COUNT_TYPES = { daily: 'รายวัน', weekly: 'รายสัปดาห์', monthly: 'รายเดือน', spot: 'เฉพาะจุด' } as const
export type CountType = keyof typeof COUNT_TYPES

export const round = (n: number, d = 2) => {
  const f = 10 ** d
  return Math.round((n + Number.EPSILON) * f) / f
}

// ===== Actual vs Theoretical =====
// ยอดที่ควรเหลือ = นับรอบก่อน + นำเข้า − ตัดตามสูตร · ส่วนต่าง = นับจริง − ยอดที่ควรเหลือ (ติดลบ = ของหายไม่ทราบสาเหตุ)
export function expectedQty(opening: number, received: number, deducted: number): number {
  return round(opening + received - deducted, 3)
}

export function variancePct(expected: number, variance: number): number | null {
  return expected > 0 ? round((variance / expected) * 100, 2) : null
}

// สี: เขียว |%| < 2 · เหลือง 2-5 · แดง > 5 (ของยอดที่ควรเหลือ) · ควรเหลือ 0 แต่นับได้ไม่ตรง = แดง
export function varianceColor(expected: number, variance: number): VarianceColor {
  if (!(expected > 0)) return variance === 0 ? 'green' : 'red'
  const pct = (Math.abs(variance) / expected) * 100
  if (pct < 2) return 'green'
  if (pct <= 5) return 'yellow'
  return 'red'
}

export interface AvtInput {
  opening: number
  received: number
  deducted: number
  counted: number
  unitCost?: number
}

export function avt(i: AvtInput) {
  const expected = expectedQty(i.opening, i.received, i.deducted)
  const variance = round(i.counted - expected, 3)
  return {
    expected,
    variance,
    pct: variancePct(expected, variance),
    value: round(variance * (i.unitCost ?? 0), 2),
    color: varianceColor(expected, variance),
  }
}

// ติดลบต่อเนื่องกี่รอบ นับจากใบล่าสุดย้อนไป (variances เรียงใหม่ -> เก่า) · >= 3 = สูตรหรือ yield อาจไม่ตรง
export function negativeStreak(variancesNewestFirst: number[]): number {
  let n = 0
  for (const v of variancesNewestFirst) {
    if (v < 0) n++
    else break
  }
  return n
}
export const RECIPE_ALERT_STREAK = 3

// ===== ล็อต: หยิบแบบ FEFO คิดต้นทุนแบบ FIFO =====
export interface Lot {
  id: string
  qty: number // คงเหลือในล็อต
  unitCost: number // ราคาซื้อต่อหน่วยฐาน
  expiry: string | null // YYYY-MM-DD
  receivedAt: string // ISO
}
export interface Allocation {
  lotId: string
  qty: number
}

export class InsufficientStock extends Error {
  short: number
  constructor(short: number) {
    super('insufficient_stock')
    this.short = short
  }
}

function take(lots: Lot[], qty: number): Allocation[] {
  if (!(qty > 0)) return []
  const out: Allocation[] = []
  let need = qty
  for (const l of lots) {
    if (need <= 0) break
    if (l.qty <= 0) continue
    const t = Math.min(need, l.qty)
    out.push({ lotId: l.id, qty: round(t, 3) })
    need = round(need - t, 3)
  }
  if (need > 0) throw new InsufficientStock(need)
  return out
}

// FEFO: หมดอายุก่อนออกก่อน (ไม่มีวันหมดอายุไปท้าย) แล้วรับก่อนออกก่อน
export function pickFefo(lots: Lot[], qty: number): Allocation[] {
  const sorted = [...lots].sort(
    (a, b) =>
      (a.expiry ?? '9999-12-31').localeCompare(b.expiry ?? '9999-12-31') ||
      a.receivedAt.localeCompare(b.receivedAt) ||
      a.id.localeCompare(b.id),
  )
  return take(sorted, qty)
}

// FIFO: ต้นทุนคิดจากล็อตที่รับก่อน
export function costFifo(lots: Lot[], qty: number): { cost: number; allocations: Allocation[] } {
  const sorted = [...lots].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id))
  const allocations = take(sorted, qty)
  const byId = new Map(lots.map((l) => [l.id, l]))
  const cost = allocations.reduce((s, a) => s + a.qty * byId.get(a.lotId)!.unitCost, 0)
  return { cost: round(cost, 2), allocations }
}

// ===== Yield =====
// ดิบที่ต้องใช้ = สุทธิ ÷ (trim x cook) · ต้นทุนต่อหน่วยที่ใช้ได้ = ราคาซื้อ ÷ (trim x cook)
export function rawQty(net: number, trimPct = 100, cookPct = 100): number {
  return (net * 10000) / ((trimPct || 100) * (cookPct || 100))
}
export function yieldUnitCost(purchaseCost: number, trimPct = 100, cookPct = 100): number {
  return (purchaseCost * 10000) / ((trimPct || 100) * (cookPct || 100))
}

export interface YieldTrial {
  before: number
  after: number
}
export type YieldKind = 'trim' | 'cook'

// ชั่งก่อน-หลัง 3 ครั้ง · ค่าเฉลี่ย = เฉลี่ยของ (หลัง ÷ ก่อน x 100) · ตัดแต่งแล้วต้องไม่หนักขึ้น · หุงสุกได้ไม่เกิน 4 เท่า
export function yieldAverage(trials: YieldTrial[], kind: YieldKind): { avg: number; each: number[] } {
  if (trials.length !== 3) throw new Error('three_trials_required')
  for (const t of trials) {
    if (!(t.before > 0) || !(t.after > 0) || t.after > t.before * 4 || (kind === 'trim' && t.after > t.before)) {
      throw new Error('invalid_trial')
    }
  }
  const each = trials.map((t) => (t.after / t.before) * 100)
  return { avg: round(each.reduce((s, x) => s + x, 0) / each.length, 2), each: each.map((x) => round(x, 2)) }
}

// ===== Par และจำนวนแนะนำสั่ง =====
// รอบสั่ง = 7 ÷ จำนวนวันที่ผู้ขายมาส่งต่อสัปดาห์ · Par = ใช้ต่อวัน x (lead time + รอบสั่ง) + safety stock
export function orderCycleDays(deliveryDays: number[] | null | undefined): number {
  return deliveryDays && deliveryDays.length ? round(7 / deliveryDays.length, 2) : 7
}
export function parLevel(dailyUsage: number, leadTimeDays: number, cycleDays: number, safetyStock: number): number {
  return round(dailyUsage * (leadTimeDays + cycleDays) + safetyStock, 3)
}
// แนะนำสั่ง = par − คงเหลือ (ไม่ติดลบ) · ปัดขึ้นเป็นหน่วยซื้อ
export function suggestedOrder(par: number, onHand: number, conversionFactor = 1): { qty: number; packs: number } {
  const qty = Math.max(round(par - onHand, 3), 0)
  return { qty, packs: Math.ceil(qty / (conversionFactor || 1)) }
}

// ===== หน่วย =====
export const toBase = (qty: number, factor: number) => round(qty * (factor || 1), 3)
export const fmtNum = (n: number, digits = 3) => Number(n).toLocaleString('th-TH', { maximumFractionDigits: digits })

// แสดงเป็นหน่วยที่ครัวพูด เช่น 1250 g, 1 ถุง = 500 g -> "2 ถุง + 250 g"
export function displayQty(base: number, unit: string, displayUnit?: string | null, displayFactor?: number | null): string {
  const f = Number(displayFactor) || 1
  if (!displayUnit || f === 1 || displayUnit === unit) return `${fmtNum(base)} ${displayUnit && f === 1 ? displayUnit : unit}`
  const sign = base < 0 ? '−' : ''
  const abs = Math.abs(base)
  const whole = Math.floor(round(abs / f, 6))
  const rest = round(abs - whole * f, 3)
  if (whole === 0) return `${sign}${fmtNum(rest)} ${unit}`
  return `${sign}${fmtNum(whole)} ${displayUnit}${rest ? ` + ${fmtNum(rest)} ${unit}` : ''}`
}

// ===== ข้อผิดพลาดจากฐานข้อมูล -> ข้อความไทย =====
export const STOCK_ERRORS: Record<string, string> = {
  insufficient_stock: 'วัตถุดิบไม่พอ (สต็อกติดลบไม่ได้) รับของเข้าหรือนับสต็อกก่อน',
  lot_already_used: 'ของจากล็อตนี้ถูกใช้ไปแล้ว กลับรายการไม่ได้ ให้แก้ด้วยการนับสต็อก',
  already_reversed: 'รายการนี้ถูกกลับรายการไปแล้ว',
  reverse_not_allowed: 'กลับรายการได้เฉพาะ "นำเข้า" และ "ปรับจากการนับ" (ตัดตามสูตรใช้ยกเลิกออเดอร์)',
  reason_required: 'ต้องใส่เหตุผล',
  invalid_reversal: 'กลับรายการไม่ได้',
  stock_balance_is_ledger: 'ยอดคงเหลือ/ต้นทุนแก้ตรงไม่ได้ ใช้รับเข้าหรือนับสต็อก',
  stock_ledger_append_only: 'ประวัติสต็อกแก้ไขไม่ได้ ใช้กลับรายการ',
  ingredient_has_history: 'วัตถุดิบนี้มีประวัติแล้ว ลบไม่ได้ ให้ปิดใช้งานแทน',
  recipe_unit_locked: 'วัตถุดิบมีประวัติแล้ว เปลี่ยนหน่วยฐานไม่ได้',
  movement_type_not_allowed: 'ประเภทรายการนี้ใช้ไม่ได้ (ไม่มีการบันทึกของเสียแยก)',
  recipe_cycle: 'สูตรย่อยวนกลับมาที่สูตรนี้ไม่ได้',
  invalid_sub_recipe: 'สูตรย่อยต้องเป็นสูตรของร้านนี้ที่ไม่ได้ผูกกับเมนู',
  sub_recipe_in_use: 'สูตรนี้ถูกใช้เป็นสูตรย่อยอยู่ ผูกกับเมนูไม่ได้',
  invalid_lines: 'บรรทัดสูตรไม่ถูกต้อง (แต่ละบรรทัดเลือกวัตถุดิบหรือสูตรย่อย และปริมาณมากกว่า 0)',
  invalid_ingredient: 'วัตถุดิบไม่ถูกต้อง',
  invalid_supplier: 'ผู้ขายไม่ถูกต้อง',
  invalid_menu_item: 'เมนูไม่ถูกต้อง',
  invalid_quantity: 'จำนวนไม่ถูกต้อง',
  invalid_cost: 'ราคาไม่ถูกต้อง',
  invalid_pack_size: 'ขนาดบรรจุไม่ถูกต้อง',
  invalid_expiry: 'วันหมดอายุต้องไม่ก่อนวันรับ',
  invalid_date: 'วันที่ไม่ถูกต้อง',
  invalid_yield: 'Yield ต้องมากกว่า 0 และไม่เกิน 100% (ตัดแต่ง)',
  duplicate_ingredient: 'มีวัตถุดิบซ้ำในเอกสารเดียวกัน',
  no_lines: 'ยังไม่มีรายการ',
  too_many_lines: 'รายการมากเกินไป',
  invalid_count_type: 'ประเภทการนับไม่ถูกต้อง',
  invalid_count: 'ไม่พบใบนับ',
  already_verified: 'ใบนับนี้รับรองแล้ว',
  cannot_verify_own_count: 'ผู้นับรับรองใบของตัวเองไม่ได้ ให้ผู้จัดการคนอื่นหรือเจ้าของรับรอง',
  three_trials_required: 'Yield test ต้องชั่ง 3 ครั้ง',
  invalid_trial: 'น้ำหนักไม่ถูกต้อง (ต้องมากกว่า 0 และตัดแต่งแล้วต้องไม่หนักขึ้น)',
  invalid_kind: 'ประเภท yield ต้องเป็น trim หรือ cook',
  prep_production_removed: 'ไม่มีการผลิตของเตรียมแยกแล้ว ใช้สูตรย่อยแทน',
  lots_out_of_sync: 'ล็อตไม่ตรงกับยอดคงเหลือ แจ้งผู้ดูแลระบบ',
  not_found: 'ไม่พบข้อมูล',
}
// สถานะชนกัน (ตอบ 409)
export const STOCK_CONFLICTS = new Set([
  'insufficient_stock', 'lot_already_used', 'already_reversed', 'already_verified', 'ingredient_has_history', 'recipe_unit_locked',
  'sub_recipe_in_use',
])

export function stockErrorCode(message: string): string | null {
  const code = message.split(':')[0].trim()
  return code in STOCK_ERRORS ? code : null
}

// ข้อความไทย + ชื่อวัตถุดิบ (ถ้ามี เช่น "insufficient_stock: กุ้ง")
export function stockError(message: string): string {
  const code = stockErrorCode(message)
  if (!code) return message
  const detail = message.slice(code.length + 1).trim()
  return detail ? `${STOCK_ERRORS[code]}: ${detail}` : STOCK_ERRORS[code]
}
