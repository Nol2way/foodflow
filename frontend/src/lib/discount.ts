// ไม่มี import เพื่อให้ทดสอบด้วย node ได้โดยตรง
// ประมาณส่วนลดเพื่อแสดงในหน้ารับออเดอร์ (ตัวเลขจริงคำนวณในฐานข้อมูลตอนส่งออเดอร์)
export function estimateDiscount(
  p: { discount_type: 'percent' | 'amount'; value: number; min_subtotal: number },
  lines: { menuItemId: string; amount: number }[],
  promoItemIds: string[],
): { discount: number; reason: string | null } {
  const subtotal = lines.reduce((s, l) => s + l.amount, 0)
  if (subtotal < Number(p.min_subtotal)) return { discount: 0, reason: `ต้องซื้อครบ ${Number(p.min_subtotal).toLocaleString('th-TH')} บาท` }
  const eligible = lines
    .filter((l) => promoItemIds.length === 0 || promoItemIds.includes(l.menuItemId))
    .reduce((s, l) => s + l.amount, 0)
  if (eligible === 0) return { discount: 0, reason: 'ไม่มีเมนูที่ร่วมโปรในรายการ' }
  const discount =
    p.discount_type === 'percent' ? Math.round(eligible * Number(p.value)) / 100 : Math.min(Number(p.value), eligible)
  return { discount, reason: null }
}

// ===== หลายโปรพร้อมกัน (ต้องตรงกับ apply_promotions ใน 0012) =====
// โปรรายเมนูรวมกันได้ถ้าเมนูในบิลไม่ซ้ำกัน · โปรทั้งบิลได้ 1 อัน คิดจากยอดที่เหลือหลังหักโปรรายเมนู
export interface PromoRule {
  id: string
  discount_type: 'percent' | 'amount'
  value: number
  min_subtotal: number
  itemIds: string[] // ว่าง = ทั้งบิล
}

export interface PromoLine {
  menuItemId: string
  amount: number
}

const money = (n: number) => Math.round(n * 100) / 100
const off = (p: PromoRule, base: number) =>
  p.discount_type === 'percent' ? Math.round(base * Number(p.value)) / 100 : Math.min(Number(p.value), base)

// โปรนี้เข้าเงื่อนไขบิลนี้หรือไม่ (ไม่ดูโปรอื่น)
export function promoReason(p: PromoRule, lines: PromoLine[]): string | null {
  const subtotal = lines.reduce((s, l) => s + l.amount, 0)
  if (subtotal < Number(p.min_subtotal)) return `ต้องซื้อครบ ${Number(p.min_subtotal).toLocaleString('th-TH')} บาท`
  if (p.itemIds.length > 0 && !lines.some((l) => p.itemIds.includes(l.menuItemId))) return 'ไม่มีเมนูที่ร่วมโปรในรายการ'
  return null
}

// ใช้โปรนี้ร่วมกับชุดที่เลือกอยู่ไม่ได้เพราะอะไร (null = ใช้ร่วมกันได้)
export function promoConflict(p: PromoRule, selected: PromoRule[], lines: PromoLine[]): string | null {
  const others = selected.filter((s) => s.id !== p.id)
  if (p.itemIds.length === 0) {
    const bill = others.find((s) => s.itemIds.length === 0)
    return bill ? 'ใช้โปรทั้งบิลได้ทีละ 1 อัน' : null
  }
  const inBill = new Set(lines.map((l) => l.menuItemId))
  const clash = others.find((s) => s.itemIds.length > 0 && s.itemIds.some((id) => inBill.has(id) && p.itemIds.includes(id)))
  return clash ? 'เมนูซ้ำกับโปรที่เลือกแล้ว' : null
}

// ส่วนลดของชุดโปรที่เลือก (ข้ามโปรที่ไม่เข้าเงื่อนไข)
export function computeDiscounts(selected: PromoRule[], lines: PromoLine[]): { byPromo: Record<string, number>; total: number } {
  const byPromo: Record<string, number> = {}
  const subtotal = lines.reduce((s, l) => s + l.amount, 0)
  const valid = selected.filter((p) => promoReason(p, lines) === null)
  let itemTotal = 0
  for (const p of valid.filter((x) => x.itemIds.length > 0)) {
    const eligible = lines.filter((l) => p.itemIds.includes(l.menuItemId)).reduce((s, l) => s + l.amount, 0)
    byPromo[p.id] = off(p, eligible)
    itemTotal += byPromo[p.id]
  }
  const bill = valid.find((x) => x.itemIds.length === 0)
  if (bill) byPromo[bill.id] = off(bill, money(subtotal - itemTotal))
  return { byPromo, total: money(Object.values(byPromo).reduce((s, n) => s + n, 0)) }
}

// เลือกให้อัตโนมัติ: โปรรายเมนูที่ลดได้มากก่อน (ข้ามที่เมนูซ้ำ) แล้วโปรทั้งบิลที่ลดได้มากที่สุด
export function bestSelection(promos: PromoRule[], lines: PromoLine[]): string[] {
  const ok = promos.filter((p) => promoReason(p, lines) === null)
  const chosen: PromoRule[] = []
  const itemPromos = ok
    .filter((p) => p.itemIds.length > 0)
    .map((p) => ({ p, d: computeDiscounts([p], lines).total }))
    .sort((a, b) => b.d - a.d)
  for (const { p } of itemPromos) if (promoConflict(p, chosen, lines) === null) chosen.push(p)
  let bestBill: PromoRule | null = null
  let bestTotal = computeDiscounts(chosen, lines).total
  for (const p of ok.filter((x) => x.itemIds.length === 0)) {
    const t = computeDiscounts([...chosen, p], lines).total
    if (t > bestTotal) {
      bestTotal = t
      bestBill = p
    }
  }
  return [...chosen, ...(bestBill ? [bestBill] : [])].map((p) => p.id)
}
