import { translateUi } from "../lib/uiText"
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { baht, kg, orderLabel } from '../lib/format'
import Icon from './Icon'
import type { KitchenOrder } from '../lib/types'

// เลือกยกเลิกเฉพาะบางเมนู/บางจานในออเดอร์ที่ครัวยังไม่เริ่ม (cancel_order_items ใน 0033)
// เลือกครบทุกเมนู = ยกเลิกทั้งออเดอร์ · ทุกการยกเลิกบันทึกเหตุผลและผู้ยกเลิกไว้ตรวจย้อนหลัง
const REASONS = ['ลูกค้าเปลี่ยนใจ', 'สั่งผิด', 'วัตถุดิบหมด', 'รอนานเกินไป']

const ERRORS: Record<string, string> = {
  order_already_started: 'ครัวเริ่มทำออเดอร์นี้แล้ว ยกเลิกจากหน้าร้านไม่ได้',
  forbidden: 'บทบาทของคุณยกเลิกออเดอร์นี้ไม่ได้',
  invalid_item: 'รายการนี้ถูกเปลี่ยนไปแล้ว โหลดหน้าใหม่แล้วลองอีกครั้ง',
}

function cancelError(message: string) {
  if (message.includes('cancel_order_items') && message.includes('function')) {
    return 'ฐานข้อมูลยังไม่รองรับการยกเลิกบางเมนู: รัน migration 0033_cancel_order_items.sql ก่อน'
  }
  const key = Object.keys(ERRORS).find((k) => message.includes(k))
  return key ? ERRORS[key] : message
}

export default function CancelOrderDialog({
  order,
  onClose,
  onDone,
}: {
  order: KitchenOrder
  onClose: () => void
  onDone: (message: string) => void
}) {
  // จำนวนที่จะยกเลิกต่อบรรทัด (0 = ไม่ยกเลิก)
  const [pick, setPick] = useState<Record<string, number>>({})
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !saving && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const items = order.order_items
  const totalUnits = items.reduce((s, it) => s + it.quantity, 0)
  const pickedUnits = items.reduce((s, it) => s + (pick[it.id] ?? 0), 0)
  const all = pickedUnits === totalUnits
  const refund = useMemo(
    () => items.reduce((s, it) => s + (pick[it.id] ?? 0) * Number(it.unit_price), 0),
    [items, pick],
  )

  const set = (id: string, n: number) => setPick((p) => ({ ...p, [id]: n }))
  const toggleAll = () => setPick(all ? {} : Object.fromEntries(items.map((it) => [it.id, it.quantity])))

  async function submit() {
    const chosen = items.filter((it) => (pick[it.id] ?? 0) > 0).map((it) => ({ id: it.id, quantity: pick[it.id] }))
    if (chosen.length === 0) return
    setSaving(true)
    setError(null)
    const { data, error: err } = await supabase.rpc('cancel_order_items', {
      p_order_id: order.id,
      p_items: chosen,
      p_reason: reason.trim() || null,
    })
    setSaving(false)
    if (err) return setError(cancelError(err.message))
    onDone(data ? `ยกเลิกออเดอร์ ${orderLabel(order)} ทั้งใบแล้ว` : `ยกเลิก ${pickedUnits} รายการแล้ว · คืนยอด ${baht(refund)}`)
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="cancel-title" onClick={() => !saving && onClose()}>
      <div className="modal max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
          <div>
            <h2 id="cancel-title" className="text-lg strong-text">{"" + translateUi("เลือกรายการที่จะยกเลิก") + " "}</h2>
            <p className="mt-0.5 text-sm text-gray-500">
              {orderLabel(order)}{" " + translateUi("· สั่งเมื่อ") + ""}{' '}
              {new Date(order.created_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}
            </p>
          </div>
          <button className="btn btn-ghost -mr-2 p-2" onClick={onClose} disabled={saving} aria-label={translateUi("ปิด")}>
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          <button type="button" className="link mb-3" onClick={toggleAll}>
            {all ? 'ไม่เลือกเลย' : 'เลือกทั้งหมด (ยกเลิกทั้งออเดอร์)'}
          </button>

          <ul className="space-y-2">
            {items.map((it) => {
              const n = pick[it.id] ?? 0
              const on = n > 0
              const name = it.menu_items?.name ?? '-'
              return (
                <li
                  key={it.id}
                  className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition ${
                    on ? 'border-red-300 bg-red-50/60' : 'bg-white hover:bg-gray-50'
                  }`}
                >
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                    <input type="checkbox" checked={on} onChange={() => set(it.id, on ? 0 : it.quantity)} />
                    <span className="min-w-0">
                      <span className={`block truncate font-medium ${on ? 'text-red-700' : 'text-gray-900'}`}>{name}</span>
                      <span className="block hint">
                        {it.weight_g ? kg(Number(it.weight_g)) : `${it.quantity} × ${baht(Number(it.unit_price))}`}
                        {it.note && <span className="ml-1 text-amber-700">· {it.note}</span>}
                      </span>
                    </span>
                  </label>

                  {/* สั่งหลายจาน: เลือกได้ว่าจะยกเลิกกี่จาน */}
                  {it.quantity > 1 && !it.weight_g ? (
                    <div className="flex items-center rounded-lg border bg-white" aria-label={`จำนวนที่ยกเลิก ${name}`}>
                      <button
                        type="button"
                        className="grid h-8 w-8 place-items-center text-lg text-gray-600 hover:bg-gray-100 disabled:opacity-30"
                        disabled={n === 0}
                        onClick={() => set(it.id, n - 1)}
                        aria-label={translateUi("ลด")}
                      >
                        −
                      </button>
                      <span className="w-12 text-center text-sm tabular-nums">
                        {n}/{it.quantity}
                      </span>
                      <button
                        type="button"
                        className="grid h-8 w-8 place-items-center text-lg text-gray-600 hover:bg-gray-100 disabled:opacity-30"
                        disabled={n === it.quantity}
                        onClick={() => set(it.id, n + 1)}
                        aria-label={translateUi("เพิ่ม")}
                      >
                        +
                      </button>
                    </div>
                  ) : (
                    <span className="text-sm tabular-nums text-gray-500">{baht(it.quantity * Number(it.unit_price))}</span>
                  )}
                </li>
              )
            })}
          </ul>

          <div className="mt-5">
            <span className="label">{translateUi("เหตุผล (ไม่บังคับ)")}</span>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setReason(reason === r ? '' : r)}
                  className={`chip ${reason === r ? 'chip-on' : ''}`}
                >
                  {r}
                </button>
              ))}
            </div>
            <input
              className="input w-full"
              placeholder={translateUi("หรือพิมพ์เหตุผลเอง")}
              maxLength={200}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>

          {error && <p className="alert-error mt-4 mb-0">{error}</p>}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-gray-50/80 px-5 py-4">
          <div className="text-sm">
            {pickedUnits > 0 ? (
              <>
                <span className="text-gray-500">{"" + translateUi("ยกเลิก") + " "}{pickedUnits}{" " + translateUi("รายการ ·") + " "}</span>
                <span className="font-semibold text-red-700 tabular-nums">−{baht(refund)}</span>
              </>
            ) : (
              <span className="text-gray-400">{translateUi("ยังไม่ได้เลือกรายการ")}</span>
            )}
          </div>
          <div className="flex gap-2">
            <button className="btn btn-secondary" onClick={onClose} disabled={saving}>{"" + translateUi("ไม่ยกเลิก") + " "}</button>
            <button className="btn btn-danger" disabled={pickedUnits === 0 || saving} onClick={() => void submit()}>
              {saving ? 'กำลังยกเลิก...' : all ? 'ยกเลิกทั้งออเดอร์' : 'ยืนยันยกเลิก'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
