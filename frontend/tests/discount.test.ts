// ส่วนลดที่หน้ารับออเดอร์แสดงต้องตรงกับที่ฐานข้อมูลคิด (staff_place_order ใน 0009)
import assert from 'node:assert/strict'
import { bestSelection, computeDiscounts, estimateDiscount, promoConflict } from '../src/lib/discount.ts'

const pct = (value: number, min = 0) => ({ discount_type: 'percent' as const, value, min_subtotal: min })
const amt = (value: number, min = 0) => ({ discount_type: 'amount' as const, value, min_subtotal: min })
const lines = [
  { menuItemId: 'kaprao', amount: 120 },
  { menuItemId: 'tea', amount: 60 },
]
let n = 0
const t = (name: string, fn: () => void) => {
  fn()
  n++
  console.log('ok -', name)
}

t('ลด 10% ทั้งบิล', () => assert.deepEqual(estimateDiscount(pct(10), lines, []), { discount: 18, reason: null }))
t('ลดเฉพาะเมนูที่ร่วมโปร', () => assert.equal(estimateDiscount(pct(50), lines, ['tea']).discount, 30))
t('ลดเป็นบาทไม่เกินยอดที่ร่วมโปร', () => assert.equal(estimateDiscount(amt(500), lines, ['tea']).discount, 60))
t('ยอดไม่ถึงขั้นต่ำ', () => assert.equal(estimateDiscount(pct(10, 500), lines, []).discount, 0))
t('ไม่มีเมนูที่ร่วมโปร', () => assert.match(estimateDiscount(pct(10), lines, ['x']).reason ?? '', /ไม่มีเมนู/))
t('ปัดเศษ 2 ตำแหน่งเหมือนฐานข้อมูล (33.33)', () =>
  assert.equal(estimateDiscount(pct(33.33), [{ menuItemId: 'a', amount: 100 }], []).discount, 33.33))

// หลายโปร (apply_promotions ใน 0012)
const rule = (id: string, type: 'percent' | 'amount', value: number, itemIds: string[] = [], min = 0) => ({
  id,
  discount_type: type,
  value,
  min_subtotal: min,
  itemIds,
})
const tea50 = rule('tea50', 'percent', 50, ['tea'])
const kap10 = rule('kap10', 'amount', 10, ['kaprao'])
const bill10 = rule('bill10', 'percent', 10)
const bill20b = rule('bill20b', 'amount', 20)
t('หลายโปร: รายเมนู + ทั้งบิลคิดจากยอดที่เหลือ', () =>
  assert.deepEqual(computeDiscounts([tea50, kap10, bill10], lines), { byPromo: { tea50: 30, kap10: 10, bill10: 14 }, total: 54 }))
t('หลายโปร: โปรทั้งบิล 2 อันชนกัน', () => assert.match(promoConflict(bill20b, [bill10], lines) ?? '', /ทีละ 1/))
t('หลายโปร: รายเมนูเมนูซ้ำชนกัน', () => assert.match(promoConflict(rule('tea5', 'amount', 5, ['tea']), [tea50], lines) ?? '', /ซ้ำ/))
t('หลายโปร: รายเมนูต่างเมนูใช้ร่วมกันได้', () => assert.equal(promoConflict(kap10, [tea50], lines), null))
t('เลือกอัตโนมัติ: โปรที่ลดมากสุดและไม่ชนกัน', () =>
  assert.deepEqual(bestSelection([bill20b, tea50, bill10, kap10, rule('tea5', 'amount', 5, ['tea'])], lines), ['tea50', 'kap10', 'bill20b']))
t('เลือกอัตโนมัติ: ข้ามโปรที่ยอดไม่ถึงขั้นต่ำ', () => assert.deepEqual(bestSelection([rule('big', 'percent', 50, [], 1000)], lines), []))
console.log(`\nผ่าน ${n} ชุดทดสอบ`)
