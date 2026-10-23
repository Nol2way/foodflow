// ไม่มี import เพื่อให้ทดสอบด้วย node ได้โดยตรง
// สร้างข้อความ QR พร้อมเพย์ (มาตรฐาน EMVCo / Thai QR Payment) ใส่ยอดเงินให้ลูกค้าสแกนจ่ายได้ทันที

export type PromptPayKind = 'phone' | 'national_id' | 'ewallet'

// เบอร์มือถือ 10 หลัก / เลขบัตรประชาชนหรือเลขผู้เสียภาษี 13 หลัก / e-Wallet 15 หลัก
export function promptPayKind(id: string): PromptPayKind | null {
  const d = id.replace(/\D/g, '')
  if (/^0[0-9]{9}$/.test(d)) return 'phone'
  if (/^[0-9]{13}$/.test(d)) return 'national_id'
  if (/^[0-9]{15}$/.test(d)) return 'ewallet'
  return null
}

const field = (tag: string, value: string) => tag + String(value.length).padStart(2, '0') + value

// CRC-16/CCITT-FALSE (poly 0x1021, เริ่ม 0xFFFF) ตามมาตรฐาน EMVCo
export function crc16(text: string): string {
  let crc = 0xffff
  for (let i = 0; i < text.length; i++) {
    crc ^= text.charCodeAt(i) << 8
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

export function promptPayPayload(id: string, amount?: number): string {
  const kind = promptPayKind(id)
  if (!kind) throw new Error('invalid_promptpay_id')
  const d = id.replace(/\D/g, '')
  const target =
    kind === 'phone' ? field('01', ('0000000000000' + '66' + d.slice(1)).slice(-13)) : field(kind === 'national_id' ? '02' : '03', d)
  const hasAmount = amount !== undefined && amount > 0
  const body =
    field('00', '01') +
    field('01', hasAmount ? '12' : '11') + // 12 = ใช้ครั้งเดียว (มียอด) · 11 = ใช้ซ้ำได้
    field('29', field('00', 'A000000677010111') + target) +
    field('58', 'TH') +
    field('53', '764') + // บาท
    (hasAmount ? field('54', amount.toFixed(2)) : '') +
    '6304'
  return body + crc16(body)
}

// แสดงเลขพร้อมเพย์แบบปิดบางส่วน เช่น 081-xxx-5678
export function maskPromptPay(id: string): string {
  const d = id.replace(/\D/g, '')
  if (d.length === 10) return `${d.slice(0, 3)}-xxx-${d.slice(6)}`
  return `${d.slice(0, 1)}-xxxx-xxxxx-${d.slice(-3)}`
}
