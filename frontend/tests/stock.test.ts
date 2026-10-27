// สูตรของโมดูลสต็อก: ส่วนต่าง (AvT) · สี · ติดลบต่อเนื่อง · FEFO / FIFO · yield · par · หน่วย
// ฐานข้อมูลใช้สูตรเดียวกัน (ทดสอบซ้ำที่ database/tests/test_stock.py)
import assert from 'node:assert/strict'
import {
  avt,
  costFifo,
  displayQty,
  expectedQty,
  InsufficientStock,
  negativeStreak,
  orderCycleDays,
  parLevel,
  pickFefo,
  rawQty,
  stockError,
  suggestedOrder,
  varianceColor,
  variancePct,
  yieldAverage,
  yieldUnitCost,
  type Lot,
} from '../src/lib/stockMath.ts'

let n = 0
const t = (name: string, fn: () => void) => {
  fn()
  n++
  console.log('ok -', name)
}

// ---------- ส่วนต่าง Actual vs Theoretical ----------
t('ยอดที่ควรเหลือ = นับรอบก่อน + นำเข้า − ตัดตามสูตร', () => {
  assert.equal(expectedQty(27000, 10000, 3000), 34000)
  assert.equal(expectedQty(0.1, 0.2, 0), 0.3) // ไม่มีเศษทศนิยมลอย
})

t('ส่วนต่าง = นับจริง − ควรเหลือ (ติดลบ = ของหาย) พร้อม % บาท และสี', () => {
  assert.deepEqual(avt({ opening: 27000, received: 10000, deducted: 3000, counted: 30000, unitCost: 0.4 }), {
    expected: 34000, variance: -4000, pct: -11.76, value: -1600, color: 'red',
  })
  assert.deepEqual(avt({ opening: 9500, received: 0, deducted: 1000, counted: 8450 }), {
    expected: 8500, variance: -50, pct: -0.59, value: 0, color: 'green',
  })
})

t('สี: เขียว < 2% · เหลือง 2-5% (รวมขอบ) · แดง > 5% · ทั้งขาดและเกิน', () => {
  assert.equal(varianceColor(100, -1.99), 'green')
  assert.equal(varianceColor(100, -2), 'yellow')
  assert.equal(varianceColor(100, 5), 'yellow')
  assert.equal(varianceColor(100, 5.01), 'red')
  assert.equal(varianceColor(100, 12), 'red') // นับเกินมากก็ผิดปกติ
})

t('สี: ยอดที่ควรเหลือเป็น 0', () => {
  assert.equal(varianceColor(0, 0), 'green')
  assert.equal(varianceColor(0, 3), 'red')
  assert.equal(variancePct(0, 3), null)
})

t('ติดลบต่อเนื่อง: นับจากใบล่าสุดย้อนไป หยุดเมื่อเจอไม่ติดลบ', () => {
  assert.equal(negativeStreak([-50, -50, -40]), 3)
  assert.equal(negativeStreak([-50, -50, 0, -40]), 2)
  assert.equal(negativeStreak([10, -50, -50, -50]), 0)
  assert.equal(negativeStreak([]), 0)
})

// ---------- ล็อต ----------
const lots: Lot[] = [
  { id: 'L1', qty: 1000, unitCost: 0.1, expiry: '2099-12-31', receivedAt: '2026-10-20T08:00:00Z' }, // รับก่อน หมดอายุช้า
  { id: 'L2', qty: 1000, unitCost: 0.2, expiry: '2099-01-01', receivedAt: '2026-10-22T08:00:00Z' }, // รับหลัง หมดอายุก่อน
  { id: 'L3', qty: 500, unitCost: 0.3, expiry: null, receivedAt: '2026-10-19T08:00:00Z' }, // ไม่มีวันหมดอายุ
]

t('FEFO: หยิบล็อตที่หมดอายุก่อน · ไม่มีวันหมดอายุไปท้ายสุด', () => {
  assert.deepEqual(pickFefo(lots, 300), [{ lotId: 'L2', qty: 300 }])
  assert.deepEqual(pickFefo(lots, 2200), [{ lotId: 'L2', qty: 1000 }, { lotId: 'L1', qty: 1000 }, { lotId: 'L3', qty: 200 }])
})

t('FIFO: ต้นทุนจากล็อตที่รับก่อน (คนละลำดับกับ FEFO)', () => {
  assert.deepEqual(costFifo(lots, 300), { cost: 90, allocations: [{ lotId: 'L3', qty: 300 }] })
  // 500 x 0.3 + 1000 x 0.1 + 100 x 0.2
  assert.equal(costFifo(lots, 1600).cost, 270)
})

t('FEFO: วันหมดอายุเท่ากัน ใช้ล็อตที่รับก่อน', () => {
  const same: Lot[] = [
    { id: 'B', qty: 10, unitCost: 1, expiry: '2026-11-01', receivedAt: '2026-10-25T00:00:00Z' },
    { id: 'A', qty: 10, unitCost: 1, expiry: '2026-11-01', receivedAt: '2026-10-24T00:00:00Z' },
  ]
  assert.deepEqual(pickFefo(same, 5), [{ lotId: 'A', qty: 5 }])
})

t('สต็อกติดลบไม่ได้: ของไม่พอโยน InsufficientStock พร้อมจำนวนที่ขาด', () => {
  assert.throws(() => pickFefo(lots, 2600), (e: unknown) => e instanceof InsufficientStock && e.short === 100)
  assert.throws(() => costFifo(lots, 2501), InsufficientStock)
  assert.deepEqual(pickFefo(lots, 0), [])
})

t('ล็อตที่หมดแล้ว (qty 0) ถูกข้าม', () => {
  assert.deepEqual(pickFefo([{ ...lots[1], qty: 0 }, lots[0]], 100), [{ lotId: 'L1', qty: 100 }])
})

// ---------- Yield ----------
t('yield test: ค่าเฉลี่ยของ (หลัง ÷ ก่อน) 3 ครั้ง', () => {
  const r = yieldAverage([{ before: 500, after: 350 }, { before: 400, after: 300 }, { before: 1000, after: 800 }], 'trim')
  assert.deepEqual(r, { avg: 75, each: [70, 75, 80] })
})

t('yield test: ต้อง 3 ครั้ง · ตัดแต่งแล้วหนักขึ้นไม่ได้ · หุงสุกเกิน 100% ได้', () => {
  assert.throws(() => yieldAverage([{ before: 1, after: 1 }], 'trim'), /three_trials_required/)
  assert.throws(() => yieldAverage([{ before: 100, after: 120 }, { before: 1, after: 1 }, { before: 1, after: 1 }], 'trim'), /invalid_trial/)
  assert.throws(() => yieldAverage([{ before: 0, after: 1 }, { before: 1, after: 1 }, { before: 1, after: 1 }], 'cook'), /invalid_trial/)
  assert.equal(yieldAverage([{ before: 1000, after: 2500 }, { before: 1000, after: 2400 }, { before: 1000, after: 2600 }], 'cook').avg, 250)
})

t('ต้นทุนต่อหน่วย = ราคาซื้อ ÷ (trim × cook) · ดิบ = สุทธิ ÷ (trim × cook)', () => {
  assert.equal(yieldUnitCost(0.4, 60, 100).toFixed(4), '0.6667')
  assert.equal(yieldUnitCost(0.04, 100, 250), 0.016) // ข้าวสารต่อกรัมข้าวสุก
  assert.equal(rawQty(150, 60), 250)
  assert.equal(rawQty(250, 100, 250), 100)
  assert.equal(rawQty(12, 80) * 0.15, 2.25) // ใบกะเพราในสูตรเมนูตัวอย่าง
})

// ---------- Par ----------
t('par = ใช้ต่อวัน × (lead time + รอบสั่ง) + safety stock', () => {
  assert.equal(orderCycleDays([1, 4]), 3.5)
  assert.equal(orderCycleDays([0, 1, 2, 3, 4, 5, 6]), 1)
  assert.equal(orderCycleDays([]), 7)
  assert.equal(parLevel(100, 2, 3.5, 200), 750)
})

t('แนะนำสั่ง = par − คงเหลือ (ไม่ติดลบ) ปัดขึ้นเป็นหน่วยซื้อ', () => {
  assert.deepEqual(suggestedOrder(750, 200, 1000), { qty: 550, packs: 1 })
  assert.deepEqual(suggestedOrder(750, 2000, 1000), { qty: 0, packs: 0 })
  assert.deepEqual(suggestedOrder(2001, 0, 1000), { qty: 2001, packs: 3 })
})

// ---------- หน่วย / ข้อความ ----------
t('แสดงเป็นหน่วยครัว: 1250 g, 1 ถุง = 500 g -> 2 ถุง + 250 g', () => {
  assert.equal(displayQty(1250, 'g', 'ถุง', 500), '2 ถุง + 250 g')
  assert.equal(displayQty(1000, 'g', 'ถุง', 500), '2 ถุง')
  assert.equal(displayQty(300, 'g', 'ถุง', 500), '300 g')
  assert.equal(displayQty(30, 'pcs', 'ฟอง', 1), '30 ฟอง')
  assert.equal(displayQty(-750, 'g', 'ถุง', 500), '−1 ถุง + 250 g')
})

t('ข้อผิดพลาดจากฐานข้อมูลเป็นข้อความไทย พร้อมชื่อวัตถุดิบ', () => {
  assert.match(stockError('insufficient_stock: กุ้ง'), /^วัตถุดิบไม่พอ.*: กุ้ง$/)
  assert.equal(stockError('something_else'), 'something_else')
})

console.log(`\n${n} tests passed`)
