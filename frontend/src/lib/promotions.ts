import { baht } from './format'
import { DAY_SHORT } from './analytics'
import type { Promotion } from './types'

// ข้อความสรุปเงื่อนไขโปร
export function describePromotion(p: Promotion): string {
  const parts = [p.discount_type === 'percent' ? `ลด ${Number(p.value)}%` : `ลด ${baht(Number(p.value))}`]
  if (Number(p.min_subtotal) > 0) parts.push(`ซื้อครบ ${baht(Number(p.min_subtotal))}`)
  if (p.days_of_week?.length) parts.push(`วัน${p.days_of_week.map((d) => DAY_SHORT[d]).join(' ')}`)
  if (p.start_time || p.end_time) parts.push(`${p.start_time?.slice(0, 5) ?? '00:00'}–${p.end_time?.slice(0, 5) ?? '24:00'}`)
  if (p.starts_on || p.ends_on) parts.push(`${p.starts_on ?? '...'} ถึง ${p.ends_on ?? '...'}`)
  if (p.max_uses) parts.push(`จำกัด ${p.max_uses.toLocaleString('th-TH')} ครั้ง`)
  return parts.join(' · ')
}

// วันที่วันนี้แบบ YYYY-MM-DD ตามเครื่อง (ใช้เป็นค่าต่ำสุดของช่องวันที่)
export function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ข้อความ error จากฐานข้อมูลเกี่ยวกับโปร เป็นภาษาไทย
export function promotionError(message: string): string {
  if (message.includes('promotion_start_in_past')) return 'วันเริ่มต้องไม่ย้อนหลังกว่าวันนี้'
  if (message.includes('promotion_end_in_past')) return 'วันสิ้นสุดต้องไม่ย้อนหลังกว่าวันนี้'
  if (message.includes('promotion_not_available')) return 'โปรนี้ใช้ไม่ได้ตอนนี้ (หมดเวลา ปิดอยู่ หรือใช้ครบจำนวนครั้งแล้ว)'
  if (message.includes('promotion_min_subtotal')) return 'ยอดยังไม่ถึงขั้นต่ำของโปร'
  if (message.includes('promotion_no_eligible_items')) return 'ไม่มีเมนูที่ร่วมโปรในบิลนี้'
  if (message.includes('bill_not_ready')) return 'บิลนี้ยังเสิร์ฟไม่ครบ หรือถูกรับชำระไปแล้ว'
  if (message.includes('not_enough_points')) return 'แต้มสมาชิกไม่พอ'
  if (message.includes('below_min_redeem')) return 'แลกแต้มน้อยกว่าขั้นต่ำที่ร้านกำหนด'
  if (message.includes('redeem_exceeds_total')) return 'ส่วนลดจากแต้มเกินยอดที่ต้องจ่าย'
  if (message.includes('member_required')) return 'ต้องเลือกสมาชิกก่อนแลกแต้ม'
  if (message.includes('loyalty_disabled')) return 'ร้านปิดระบบสะสมแต้มอยู่'
  if (message.includes('member_not_found')) return 'ไม่พบสมาชิกนี้'
  return message
}

export { estimateDiscount } from './discount'
