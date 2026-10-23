// แต้มที่หน้ารับชำระแสดงต้องตรงกับที่ฐานข้อมูลคิด (counter_pay_bill ใน 0017)
import assert from 'node:assert/strict'
import { maxRedeem, normalizePhone, pointsDiscount, pointsEarned } from '../src/lib/loyalty.ts'

const rule = { loyalty_baht_per_point: 10, loyalty_point_value: 1, loyalty_min_redeem: 10 }
let n = 0
const t = (name: string, fn: () => void) => {
  fn()
  n++
  console.log('ok -', name)
}

t('ได้แต้ม: ทุก 10 บาท = 1 แต้ม ปัดลง', () => {
  assert.equal(pointsEarned(rule, 240), 24)
  assert.equal(pointsEarned(rule, 9.99), 0)
  assert.equal(pointsEarned(rule, 160), 16)
})
t('แลกได้สูงสุด: ไม่เกินแต้มที่มีและไม่เกินยอด', () => {
  assert.equal(maxRedeem(rule, 24, 180), 24)
  assert.equal(maxRedeem(rule, 500, 180), 180)
})
t('แลกได้สูงสุด: ต่ำกว่าขั้นต่ำ = แลกไม่ได้', () => assert.equal(maxRedeem(rule, 5, 180), 0))
t('มูลค่าแต้มไม่ใช่ 1 บาท', () => {
  const r2 = { ...rule, loyalty_point_value: 0.5 }
  assert.equal(pointsDiscount(r2, 21), 10.5)
  assert.equal(maxRedeem(r2, 1000, 50), 100)
})
t('เบอร์โทร', () => {
  assert.equal(normalizePhone('089-999-9999'), '0899999999')
  assert.equal(normalizePhone('02 123 4567'), '021234567')
  assert.equal(normalizePhone('12345'), null)
})
console.log(`\nผ่าน ${n} ชุดทดสอบ`)
