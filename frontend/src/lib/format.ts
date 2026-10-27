export const baht = (n: number) =>
  '฿' + n.toLocaleString('th-TH', { maximumFractionDigits: 2 })

// น้ำหนักกรัม -> "1.25 กก." (ของขายตามน้ำหนัก 0023)
export const kg = (grams: number) =>
  (grams / 1000).toLocaleString('th-TH', { maximumFractionDigits: 3 }) + ' กก.'

// จำนวนของรายการในออเดอร์: ของชั่งขายแสดงน้ำหนัก ของปกติแสดง "2 ×"
export const itemQty = (it: { quantity: number; weight_g?: number | null }) =>
  it.weight_g ? `${kg(Number(it.weight_g))} ·` : `${it.quantity} ×`

// ชื่อที่แสดงของออเดอร์: โต๊ะ หรือ กลับบ้าน (+ ชื่อลูกค้า)
export function orderLabel(o: {
  order_type: 'dine_in' | 'takeaway'
  customer_label: string | null
  dining_tables: { label: string } | null
}): string {
  if (o.order_type === 'takeaway') return o.customer_label ? `กลับบ้าน · ${o.customer_label}` : 'กลับบ้าน'
  return o.dining_tables?.label ?? 'ไม่ระบุโต๊ะ'
}
