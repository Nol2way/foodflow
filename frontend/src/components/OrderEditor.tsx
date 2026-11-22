import { translateUi } from "../lib/uiText"
import { useText } from '../lib/preferences'
import { promotionError } from '../lib/promotions'
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { KitchenOrder, MenuItem } from '../lib/types'
import Modal from './Modal'
export default function OrderEditor({ order, restaurantId, onClose, onSaved }: { order: KitchenOrder; restaurantId: string; onClose: () => void; onSaved: () => void }) {
  const translate = useText()
  const [menu, setMenu] = useState<MenuItem[]>([])
  const [lines, setLines] = useState(order.order_items.map((it) => ({ menu_item_id: it.menu_item_id, quantity: it.quantity, weight_g: it.weight_g ?? null, note: it.note ?? '', selected_option_ids: it.options_snapshot?.map((o) => o.id) ?? [] })))
  const [note, setNote] = useState(order.note ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  useEffect(() => { let alive = true; void supabase.from('menu_items').select('id,name,price,sold_by_weight,option_choices,is_available').eq('restaurant_id', restaurantId).then(({ data, error }) => { if (alive) { if (error) setError(error.message); else setMenu(data as MenuItem[]) } }); return () => { alive = false } }, [restaurantId])
  async function save() {
    if (lock.current || !lines.length || lines.length > 50) return
    lock.current = true; setBusy(true)
    const { error } = await supabase.rpc('staff_edit_order', { p_order_id: order.id, p_note: note, p_items: lines })
    lock.current = false; setBusy(false)
    if (error) setError(promotionError(error.message))
    else onSaved()
  }
  return <Modal label={translateUi("แก้ไขออเดอร์ก่อนครัวรับ")} onClose={() => { if (!busy) onClose() }}><h2 className="section-title">{translate('แก้ไขออเดอร์ก่อนครัวรับ', 'Edit order before preparation')}</h2>{error && <p role="alert" className="alert-error">{error}</p>}<fieldset disabled={busy} className="space-y-3">{lines.map((line, index) => {
    const item = menu.find((m) => m.id === line.menu_item_id)
    return <div className="rounded border p-2" key={index}><b>{item?.name ?? order.order_items[index]?.menu_items?.name}</b><label className="label">{line.weight_g !== null ? 'น้ำหนัก (กรัม)' : 'จำนวน'}<input className="input w-full" type="number" min="1" max={line.weight_g !== null ? 100000 : 50} value={line.weight_g ?? line.quantity} onChange={(e) => setLines(lines.map((l, i) => i !== index ? l : { ...l, ...(l.weight_g !== null ? { weight_g: Number(e.target.value) } : { quantity: Number(e.target.value) }) }))} /></label><input aria-label={translateUi("หมายเหตุรายการ")} className="input w-full" value={line.note} onChange={(e) => setLines(lines.map((l, i) => i !== index ? l : { ...l, note: e.target.value }))} />{item?.option_choices?.map((option) => <label key={option.id} className="flex gap-2"><input type="checkbox" checked={line.selected_option_ids.includes(option.id)} onChange={(e) => setLines(lines.map((l, i) => i !== index ? l : { ...l, selected_option_ids: e.target.checked ? [...l.selected_option_ids, option.id] : l.selected_option_ids.filter((id) => id !== option.id) }))} />{option.name} +{option.price}</label>)}<button type="button" className="link-danger" onClick={() => setLines(lines.filter((_, i) => i !== index))}>{translate('เอาออก', 'Remove')}</button></div>
  })}<label className="label">{translate('เพิ่มเมนู', 'Add item')}<select className="input w-full" value="" disabled={lines.length >= 50} onChange={(e) => { const m = menu.find((m) => m.id === e.target.value); if (m) setLines([...lines, { menu_item_id: m.id, quantity: 1, weight_g: m.sold_by_weight ? 1000 : null, note: '', selected_option_ids: [] }]) }}><option value="">{translate('เลือกเมนู', 'Choose item')}</option>{menu.filter((m) => m.is_available).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label className="label">{translate('หมายเหตุทั้งออเดอร์', 'Order note')}<input className="input w-full" value={note} onChange={(e) => setNote(e.target.value)} /></label><button className="btn btn-primary" disabled={!lines.length} onClick={() => void save()}>{translate('บันทึกออเดอร์', 'Save order')}</button><button className="btn btn-secondary" onClick={onClose}>{translate('ยกเลิก', 'Cancel')}</button></fieldset></Modal>
}
