// ไม่มี import เพื่อให้ทดสอบด้วย node ได้โดยตรง
// คำนวณแต้มให้ตรงกับ counter_pay_bill (0017): แลกแต้มหลังหักโปร แล้วได้แต้มจากยอดที่จ่ายจริง

export interface LoyaltyRule {
  loyalty_baht_per_point: number
  loyalty_point_value: number
  loyalty_min_redeem: number
}

// แลกได้มากสุดกี่แต้ม (ไม่เกินแต้มที่มี และส่วนลดไม่เกินยอด) · ต่ำกว่าขั้นต่ำ = 0
export function maxRedeem(rule: LoyaltyRule, points: number, total: number): number {
  const byTotal = Math.floor((total + 1e-9) / Number(rule.loyalty_point_value))
  const max = Math.max(0, Math.min(points, byTotal))
  return max >= rule.loyalty_min_redeem ? max : 0
}

export function pointsDiscount(rule: LoyaltyRule, redeem: number): number {
  return Math.round(redeem * Number(rule.loyalty_point_value) * 100) / 100
}

export function pointsEarned(rule: LoyaltyRule, paid: number): number {
  return Math.floor((paid + 1e-9) / rule.loyalty_baht_per_point)
}

// เบอร์มือถือ/บ้านไทย: 0 + 8–9 หลัก (ตัดขีด/ช่องว่างออก)
export function normalizePhone(text: string): string | null {
  const d = text.replace(/\D/g, '')
  return /^0[0-9]{8,9}$/.test(d) ? d : null
}
