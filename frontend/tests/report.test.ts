// ข้อความรายงานรายวัน (ส่ง LINE) และกติกาแนะนำโปร
import assert from 'node:assert/strict'
import { changePct, reportText, thaiDate } from '../src/lib/report.ts'
import { quietWindow, ruleSuggestions, safePercent, validateSuggested, type Insights } from '../src/lib/promoSuggest.ts'

let n = 0
const t = (name: string, fn: () => void) => {
  fn()
  n++
  console.log('ok -', name)
}

const report = {
  restaurant: 'ร้านทดสอบ',
  date: '2026-10-23',
  orders: 4,
  revenue: 1000,
  discount: 50,
  revenue_last_week: 800,
  cancelled: 1,
  payments: { cash: 600, promptpay: 400 },
  top_items: [{ name: 'กะเพรา', quantity: 7, amount: 420 }],
  peak_hour: 12,
  waste: [{ name: 'ใบกะเพรา', quantity: 200, unit: 'g', cost: 30 }],
  expenses: 250,
  new_members: 2,
  points_earned: 100,
  points_redeemed: 20,
}

t('วันที่แบบไทย (พ.ศ.)', () => assert.equal(thaiDate('2026-10-23'), '23 ต.ค. 2569'))
t('เปลี่ยนแปลงเทียบสัปดาห์ก่อน', () => {
  assert.equal(changePct(1000, 800), 25)
  assert.equal(changePct(1000, 0), null)
})
t('ข้อความรายงานครบทุกส่วน', () => {
  const s = reportText(report)
  for (const part of ['ร้านทดสอบ', '23 ต.ค. 2569', '฿1,000 (4 บิล)', 'เฉลี่ย ฿250/บิล', '+25%', 'เงินสด ฿600', 'พร้อมเพย์ ฿400', '1. กะเพรา 7 ที่', '12:00–13:00', 'ใบกะเพรา 200 g (฿30)', 'รายจ่ายวันนี้ ฿250', 'สมาชิกใหม่ 2 คน', 'ยกเลิก 1 บิล'])
    assert.ok(s.includes(part), part)
})
t('วันที่ไม่มีบิล', () => {
  const s = reportText({ ...report, orders: 0, revenue: 0, revenue_last_week: 0, top_items: [], waste: [], payments: {}, peak_hour: null, cancelled: 0, expenses: 0, new_members: 0, points_earned: 0, points_redeemed: 0, discount: 0 })
  assert.ok(s.includes('ยังไม่มีบิลที่ชำระแล้ว'))
  assert.ok(!s.includes('เฉลี่ย'))
})

// วันละ: เช้า 10-11 เงียบ, เที่ยงพีค, บ่าย 14-17 เงียบ, เย็นพีค
const hours = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((h) => ({
  hour: h,
  orders_per_day: [12, 13, 18, 19, 20].includes(h) ? 10 : [14, 15, 16].includes(h) ? 1 : 5,
  revenue: 0,
}))
hours.forEach((h) => (h.revenue = h.orders_per_day * 28 * 100)) // บิลละ 100
const ins: Insights = {
  days: 28,
  hours,
  items: [
    { id: 'a', name: 'กะเพรา', price: 60, unit_cost: 20, has_recipe: true, quantity: 300, revenue: 18000, is_available: true },
    { id: 'b', name: 'ข้าวผัด', price: 70, unit_cost: 25, has_recipe: true, quantity: 200, revenue: 14000, is_available: true },
    { id: 'c', name: 'ต้มยำ', price: 120, unit_cost: 50, has_recipe: true, quantity: 10, revenue: 1200, is_available: true },
    { id: 'd', name: 'ข้าวไข่เจียว', price: 40, unit_cost: 35, has_recipe: true, quantity: 5, revenue: 200, is_available: true },
  ],
  active_promotions: [],
}

t('ช่วงเงียบ: หาช่วงบ่ายที่ออเดอร์น้อย', () => assert.deepEqual(quietWindow(hours)?.start, 14))
t('ลดได้ไม่ต่ำกว่าต้นทุน × 1.3', () => {
  assert.equal(safePercent(120, 50, true), 20) // 1 - 65/120 = 45% → เพดาน 20
  assert.equal(safePercent(40, 35, true), 0) // ลดไม่ได้เลย
  assert.equal(safePercent(100, 0, false), 10) // ไม่รู้ต้นทุน
})
t('แนะนำ: ช่วงเงียบ + เมนูขายช้าที่ยังลดได้ + ซื้อครบลด', () => {
  const s = ruleSuggestions(ins)
  assert.deepEqual(
    s.map((x) => x.key),
    ['quiet-14', 'slow-c', 'basket-150'],
  )
  assert.ok(!s.some((x) => x.promo.item_ids.includes('d')), 'ข้าวไข่เจียวกำไรน้อย ห้ามแนะนำลด')
})
t('ข้อมูลน้อยเกินไป ไม่แนะนำ', () => assert.deepEqual(ruleSuggestions({ ...ins, days: 1, hours: hours.map((h) => ({ ...h, orders_per_day: 0.5 })) }), []))
t('ตรวจโปรจาก AI: ผ่าน', () =>
  assert.deepEqual(validateSuggested({ name: 'ต้มยำลด 15%', discount_type: 'percent', value: 15, item_ids: ['c'] }, ins), {
    name: 'ต้มยำลด 15%',
    discount_type: 'percent',
    value: 15,
    min_subtotal: 0,
    start_time: null,
    end_time: null,
    item_ids: ['c'],
  }))
t('ตรวจโปรจาก AI: ตัดทิ้งถ้าขาดทุน/ลดแรงเกิน/เมนูไม่มีจริง/เวลาผิด', () => {
  assert.equal(validateSuggested({ name: 'x', discount_type: 'percent', value: 20, item_ids: ['d'] }, ins), null)
  assert.equal(validateSuggested({ name: 'x', discount_type: 'percent', value: 50 }, ins), null)
  assert.equal(validateSuggested({ name: 'x', discount_type: 'percent', value: 10, item_ids: ['zzz'] }, ins), null)
  assert.equal(validateSuggested({ name: 'x', discount_type: 'percent', value: 10, start_time: '17:00', end_time: '14:00' }, ins), null)
  assert.equal(validateSuggested({ name: '', discount_type: 'percent', value: 10 }, ins), null)
})
console.log(`\nผ่าน ${n} ชุดทดสอบ`)
