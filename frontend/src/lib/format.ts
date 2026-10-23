export const baht = (n: number) =>
  '฿' + n.toLocaleString('th-TH', { maximumFractionDigits: 2 })

// ชื่อที่แสดงของออเดอร์: โต๊ะ หรือ กลับบ้าน (+ ชื่อลูกค้า)
export function orderLabel(o: {
  order_type: 'dine_in' | 'takeaway'
  customer_label: string | null
  dining_tables: { label: string } | null
}): string {
  if (o.order_type === 'takeaway') return o.customer_label ? `กลับบ้าน · ${o.customer_label}` : 'กลับบ้าน'
  return o.dining_tables?.label ?? 'ไม่ระบุโต๊ะ'
}
