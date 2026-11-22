import { baht } from './format'
import { DAY_SHORT } from './analytics'
import type { Promotion } from './types'
import { getLanguage } from './preferences'

// ข้อความสรุปเงื่อนไขโปร
export function describePromotion(p: Promotion): string {
  const en = getLanguage() === 'en'
  const parts = [p.discount_type === 'percent' ? `${en ? 'Discount' : 'ลด'} ${Number(p.value)}%` : `${en ? 'Discount' : 'ลด'} ${baht(Number(p.value))}`]
  if (Number(p.min_subtotal) > 0) parts.push(`${en ? 'Minimum spend' : 'ซื้อครบ'} ${baht(Number(p.min_subtotal))}`)
  if (p.days_of_week?.length) parts.push(`${en ? '' : 'วัน'}${p.days_of_week.map((d) => en ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d] : DAY_SHORT[d]).join(' ')}`)
  if (p.start_time || p.end_time) parts.push(`${p.start_time?.slice(0, 5) ?? '00:00'}–${p.end_time?.slice(0, 5) ?? '24:00'}`)
  if (p.starts_on || p.ends_on) parts.push(`${p.starts_on ?? '...'} ${en ? 'to' : 'ถึง'} ${p.ends_on ?? '...'}`)
  if (p.max_uses) parts.push(en ? `Limited to ${p.max_uses} uses` : `จำกัด ${p.max_uses.toLocaleString('th-TH')} ครั้ง`)
  return parts.join(' · ')
}

// วันที่วันนี้แบบ YYYY-MM-DD ตามเครื่อง (ใช้เป็นค่าต่ำสุดของช่องวันที่)
export function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ข้อความ error จากฐานข้อมูลเกี่ยวกับโปร เป็นภาษาไทย
export function promotionError(message: string): string {
  if (message.includes('split_promotion_locked')) return getLanguage() === 'en' ? 'Allocated split-bill discounts are locked. Cancel and recreate the bill to change items or promotions.' : 'ส่วนลดที่แบ่งให้บิลแยกถูกล็อกแล้ว หากต้องการเปลี่ยนรายการหรือโปรโมชัน ให้ยกเลิกและสร้างบิลใหม่'
  if (message.includes('quote_changed')) return getLanguage() === 'en' ? 'The bill changed. Review the amount and create a new QR or payment confirmation.' : 'ยอดบิลเปลี่ยนแล้ว กรุณาตรวจยอดและเปิด QR หรือยืนยันชำระใหม่'
  if (message.includes('quote_required')) return getLanguage() === 'en' ? 'Reopen checkout to confirm the bill amount.' : 'กรุณาเปิดหน้ารับชำระใหม่เพื่อยืนยันยอดบิล'
  if (message.includes('promotion_start_in_past')) return getLanguage() === 'en' ? 'The start date cannot be in the past.' : 'วันเริ่มต้องไม่ย้อนหลังกว่าวันนี้'
  if (message.includes('promotion_end_in_past')) return getLanguage() === 'en' ? 'The end date cannot be in the past.' : 'วันสิ้นสุดต้องไม่ย้อนหลังกว่าวันนี้'
  if (message.includes('promotion_not_available')) return getLanguage() === 'en' ? 'This promotion has expired, is disabled or has reached its usage limit.' : 'โปรนี้ใช้ไม่ได้ตอนนี้ (หมดเวลา ปิดอยู่ หรือใช้ครบจำนวนครั้งแล้ว)'
  if (message.includes('promotion_min_subtotal')) return getLanguage() === 'en' ? 'The bill has not reached the promotion minimum.' : 'ยอดยังไม่ถึงขั้นต่ำของโปร'
  if (message.includes('promotion_no_eligible_items')) return getLanguage() === 'en' ? 'This bill has no items eligible for the promotion.' : 'ไม่มีเมนูที่ร่วมโปรในบิลนี้'
  if (message.includes('bill_not_ready')) return getLanguage() === 'en' ? 'The bill is not fully served or has already been paid.' : 'บิลนี้ยังเสิร์ฟไม่ครบ หรือถูกรับชำระไปแล้ว'
  if (message.includes('not_enough_points')) return getLanguage() === 'en' ? 'The member does not have enough points.' : 'แต้มสมาชิกไม่พอ'
  if (message.includes('below_min_redeem')) return getLanguage() === 'en' ? 'The points redemption is below the shop minimum.' : 'แลกแต้มน้อยกว่าขั้นต่ำที่ร้านกำหนด'
  if (message.includes('redeem_exceeds_total')) return getLanguage() === 'en' ? 'The points discount exceeds the amount due.' : 'ส่วนลดจากแต้มเกินยอดที่ต้องจ่าย'
  if (message.includes('member_required')) return getLanguage() === 'en' ? 'Select a member before redeeming points.' : 'ต้องเลือกสมาชิกก่อนแลกแต้ม'
  if (message.includes('loyalty_disabled')) return getLanguage() === 'en' ? 'Loyalty points are disabled for this shop.' : 'ร้านปิดระบบสะสมแต้มอยู่'
  if (message.includes('member_not_found')) return getLanguage() === 'en' ? 'Member not found.' : 'ไม่พบสมาชิกนี้'
  return message
}

export { estimateDiscount } from './discount'
