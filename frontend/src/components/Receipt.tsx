import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { baht } from '../lib/format'
import Icon from './Icon'

// ใบเสร็จของบิล (bill_receipt ใน 0017) · กดพิมพ์ได้ทั้งเครื่องพิมพ์ทั่วไปและเครื่องพิมพ์ใบเสร็จ 80 มม.

interface ReceiptData {
  restaurant: string
  header: string | null
  footer: string | null
  paid_at: string | null
  payment_method: string | null
  table: string | null
  bill_no: string
  items: { name: string; quantity: number; unit_price: number; amount: number }[]
  promotions: { name: string; discount: number }[]
  subtotal: number
  points_discount: number
  total: number
  member: { phone: string; points: number; earned: number; redeemed: number } | null
}

const METHOD: Record<string, string> = { cash: 'เงินสด', promptpay: 'พร้อมเพย์', card: 'บัตร', other: 'อื่นๆ' }

export default function Receipt({ orderIds, onClose }: { orderIds: string[]; onClose: () => void }) {
  const [data, setData] = useState<ReceiptData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void supabase.rpc('bill_receipt', { p_order_ids: orderIds }).then(({ data: d, error: e }) => {
      if (e) setError('เปิดใบเสร็จไม่ได้ (ต้องรัน migration 0017 ก่อน)')
      else setData(d as ReceiptData)
    })
  }, [orderIds])

  const row = (label: string, value: string, strong = false) => (
    <div className={`flex justify-between gap-2 ${strong ? 'text-base font-bold' : ''}`}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )

  return (
    <div className="no-print-backdrop fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="ใบเสร็จ">
      <div className="mx-auto max-w-sm">
        <div className="no-print mb-3 flex gap-2">
          <button className="btn btn-primary flex-1" onClick={() => window.print()} disabled={!data}>
            <Icon name="print" className="h-4 w-4" />
            พิมพ์ใบเสร็จ
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            ปิด
          </button>
        </div>
        {error && <p className="alert-error">{error}</p>}
        {!data && !error && <p className="rounded-xl bg-white p-6 text-center text-gray-500">กำลังโหลด...</p>}
        {data && (
          <div className="print-area rounded-xl bg-white p-5 font-mono text-[13px] leading-relaxed text-gray-900 shadow-xl">
            <div className="text-center">
              <div className="text-base font-bold">{data.restaurant}</div>
              {data.header && <div className="whitespace-pre-line text-xs">{data.header}</div>}
              <div className="mt-1 text-xs">ใบเสร็จรับเงิน</div>
            </div>
            <div className="my-2 border-t border-dashed border-gray-400" />
            {row('เลขที่', data.bill_no)}
            {row('วันที่', data.paid_at ? new Date(data.paid_at).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) : '-')}
            {data.table && row('โต๊ะ', data.table)}
            <div className="my-2 border-t border-dashed border-gray-400" />
            {data.items.map((it, i) => (
              <div key={i}>
                <div>{it.name}</div>
                {row(`  ${it.quantity} × ${baht(Number(it.unit_price))}`, baht(Number(it.amount)))}
              </div>
            ))}
            <div className="my-2 border-t border-dashed border-gray-400" />
            {row('รวม', baht(Number(data.subtotal)))}
            {data.promotions.map((p) => row(`ส่วนลด ${p.name}`, `−${baht(Number(p.discount))}`))}
            {Number(data.points_discount) > 0 && row('ส่วนลดจากแต้ม', `−${baht(Number(data.points_discount))}`)}
            {row('ยอดสุทธิ', baht(Number(data.total)), true)}
            {row('ชำระโดย', METHOD[data.payment_method ?? ''] ?? '-')}
            {data.member && (
              <>
                <div className="my-2 border-t border-dashed border-gray-400" />
                {row('สมาชิก', data.member.phone)}
                {Number(data.member.redeemed) > 0 && row('ใช้แต้ม', `${data.member.redeemed}`)}
                {row('ได้แต้ม', `+${data.member.earned ?? 0}`)}
                {row('แต้มคงเหลือ', `${data.member.points}`)}
              </>
            )}
            <div className="my-2 border-t border-dashed border-gray-400" />
            <div className="text-center text-xs whitespace-pre-line">{data.footer || 'ขอบคุณที่ใช้บริการ'}</div>
          </div>
        )}
      </div>
    </div>
  )
}
