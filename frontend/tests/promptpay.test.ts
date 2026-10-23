// QR พร้อมเพย์ต้องถูกต้องตามมาตรฐาน ไม่งั้นแอปธนาคารสแกนไม่ได้
import assert from 'node:assert/strict'
import { crc16, maskPromptPay, promptPayKind, promptPayPayload } from '../src/lib/promptpay.ts'

let n = 0
const t = (name: string, fn: () => void) => {
  fn()
  n++
  console.log('ok -', name)
}

t('CRC-16/CCITT-FALSE ตรงค่ามาตรฐาน ("123456789" = 29B1)', () => assert.equal(crc16('123456789'), '29B1'))
t('ชนิดเลขพร้อมเพย์', () => {
  assert.equal(promptPayKind('081-234-5678'), 'phone')
  assert.equal(promptPayKind('1234567890123'), 'national_id')
  assert.equal(promptPayKind('123456789012345'), 'ewallet')
  assert.equal(promptPayKind('12345'), null)
})
// ค่าคาดหวังเทียบกับไลบรารี promptpay-qr 0.5.0 (ที่ใช้กันแพร่หลาย) แล้วตรงกันทุกตัว
t('ตรงกับไลบรารีอ้างอิง: เบอร์มือถือ ไม่ระบุยอด', () =>
  assert.equal(promptPayPayload('0812345678'), '00020101021129370016A000000677010111011300668123456785802TH530376463045D82'))
t('ตรงกับไลบรารีอ้างอิง: เบอร์มือถือ + ยอด 4.22', () =>
  assert.equal(promptPayPayload('0812345678', 4.22), '00020101021229370016A000000677010111011300668123456785802TH530376454044.2263045D49'))
t('ตรงกับไลบรารีอ้างอิง: เลขผู้เสียภาษี + ยอด', () =>
  assert.equal(
    promptPayPayload('0105561234567', 162.5),
    '00020101021229370016A000000677010111021301055612345675802TH53037645406162.5063043951',
  ))
t('ตรงกับไลบรารีอ้างอิง: e-Wallet', () =>
  assert.equal(promptPayPayload('123456789012345', 99), '00020101021229390016A00000067701011103151234567890123455802TH5303764540599.0063045D25'))
t('ใส่ยอดเงิน: QR ใช้ครั้งเดียว (12) และมียอด 2 ตำแหน่ง', () => {
  const p = promptPayPayload('0812345678', 162.5)
  assert.ok(p.startsWith('000201010212'))
  assert.ok(p.includes('5406162.50'))
  assert.equal(p.slice(-4), crc16(p.slice(0, -4)))
})
t('เลขผู้เสียภาษี 13 หลักใช้แท็ก 02', () => assert.ok(promptPayPayload('0105561234567').includes('02130105561234567')))
t('เลขผิดรูปแบบ ไม่สร้าง QR', () => assert.throws(() => promptPayPayload('123')))
t('ปิดบังเลข', () => assert.equal(maskPromptPay('0812345678'), '081-xxx-5678'))
console.log(`\nผ่าน ${n} ชุดทดสอบ`)
