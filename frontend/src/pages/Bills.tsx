import { useText } from '../lib/preferences'
import { useCallback, useEffect, useRef, useState } from 'react'
import RequireRole from '../components/RequireRole'
import Receipt from '../components/Receipt'
import OrderEditor from '../components/OrderEditor'
import { supabase } from '../lib/supabase'
import { promotionError } from '../lib/promotions'
import { baht, orderLabel, itemQty } from '../lib/format'
import type { KitchenOrder } from '../lib/types'
function Board({ restaurantId }: { restaurantId: string }) {
  const translate = useText()
  const [editing, setEditing] = useState<KitchenOrder | null>(null)
  const [orders, setOrders] = useState<KitchenOrder[]>([])
  const [receipt, setReceipt] = useState<string[] | null>(null)
  const [message, setMessage] = useState('')
  const [status, setStatus] = useState('paid')
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [service, setService] = useState('0')
  const [tip, setTip] = useState('0')
  const [search, setSearch] = useState('')
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const request = useRef(0)
  const mutation = useRef(false)
  const reading = useRef(false)
  const [revision, refresh] = useState(0)
  const load = useCallback(async (cursor?: KitchenOrder) => {
    if (cursor && reading.current) return
    reading.current = true
    const sequence = ++request.current
    setLoading(true)
    let query = supabase.from('orders').select('*,dining_tables(label),order_items(*,menu_items(name))').eq('restaurant_id', restaurantId).eq('status', status)
    const term = search.trim()
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(term)) query = query.eq('id', term)
    else if (term) query = query.ilike('customer_label', `%${term.replace(/[%_]/g, '')}%`)
    if (cursor) query = query.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`)
    const { data, error } = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(100)
    if (sequence !== request.current) return
    reading.current = false
    setLoading(false)
    if (error) { setMessage(error.message); return }
    const next = (data ?? []) as KitchenOrder[]
    setOrders((previous) => cursor ? [...previous, ...next.filter((row) => !previous.some((old) => old.id === row.id))] : next)
    setMore(next.length === 100)
  }, [restaurantId, status, search])
  useEffect(() => {
    setOrders([]); setSelected([]); setMore(false); setMessage('')
    void load()
    return () => { request.current++; reading.current = false }
  }, [load, revision])
  async function mutate(name: string, args: Record<string, unknown>) {
    if (mutation.current) return
    mutation.current = true
    setBusy(true)
    const { error } = await supabase.rpc(name, args)
    setMessage(error ? promotionError(error.message) : translate('บันทึกแล้ว', 'Saved'))
    mutation.current = false
    setBusy(false)
    if (!error) refresh((n) => n + 1)
  }
  return <div className="page-narrow"><h1 className="page-title">{translate('ประวัติและจัดการบิล', 'Bill history and management')}</h1><p className="hint">{translate('แสดงครั้งละ 100 ออเดอร์ · โหลดประวัติย้อนหลังเพิ่มได้ · ส่วนลดและค่าบริการแบ่งตามสัดส่วนเมื่อแยกบิล', '100 orders per page. Load older history below. Splitting allocates discounts and charges proportionally.')}</p>
    <label className="label">{translate('สถานะ', 'Status')} <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="paid">{translate('ชำระแล้ว / พิมพ์ซ้ำ', 'Paid / reprint')}</option><option value="received">{translate('รอครัว / แก้ไข', 'Received / edit')}</option><option value="served">{translate('เสิร์ฟแล้ว / แยกบิล', 'Served / split')}</option><option value="cancelled">{translate('ยกเลิก', 'Cancel')}</option></select></label>
    <label className="label">{translate('ค้นหาเลขออเดอร์หรือชื่อลูกค้า', 'Search order ID or customer name')}<input className="input w-full" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
    {message && <p className="alert-warn" role="status">{message}</p>}
    {status !== 'paid' && status !== 'cancelled' && <div className="toolbar my-3"><label>{translate('ค่าบริการ (บาท)', 'Service charge (baht)')}<input className="input w-28" type="number" min={0} step="0.01" value={service} onChange={(e) => setService(e.target.value)} /></label><label>{translate('ทิป (บาท)', 'Tip (baht)')}<input className="input w-28" type="number" min={0} step="0.01" value={tip} onChange={(e) => setTip(e.target.value)} /></label></div>}
    <div className="space-y-3">{orders.map((order) => <article className="card" key={order.id}><h2 className="section-title">{orderLabel(order)} · {baht(Number(order.total))}</h2><p className="hint">{new Date(order.created_at).toLocaleString('th-TH')} · {order.id}</p><ul>{order.order_items.map((it) => <li key={it.id}><label className="flex gap-2">{['received', 'served'].includes(status) && <input type="checkbox" checked={selected.includes(it.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, it.id] : selected.filter((id) => id !== it.id))} />}{itemQty(it)} {it.menu_items?.name}{it.options_snapshot?.map((x) => x.name).join(', ')}</label></li>)}</ul><div className="toolbar mt-3">{status === 'paid' && <button className="btn btn-primary" onClick={() => setReceipt([order.id])}>{translate('พิมพ์ใบเสร็จซ้ำ', 'Reprint receipt')}</button>}{status === 'received' && <button disabled={busy} className="btn btn-secondary" onClick={() => setEditing(order)}>{translate('แก้ไขรายการ', 'Edit items')}</button>}{['received', 'served'].includes(status) && <button disabled={busy || !order.order_items.some((it) => selected.includes(it.id))} className="btn btn-secondary" onClick={() => void mutate('staff_split_order', { p_order_id: order.id, p_item_ids: order.order_items.filter((it) => selected.includes(it.id)).map((it) => it.id) })}>{translate('แยกรายการที่เลือกเป็นบิลใหม่', 'Split selected lines')}</button>}{['received', 'served'].includes(status) && <button disabled={busy || !Number.isFinite(Number(service)) || !Number.isFinite(Number(tip)) || Number(service) < 0 || Number(tip) < 0} className="btn btn-secondary" onClick={() => void mutate('order_set_charges', { p_order_id: order.id, p_service_charge: Number(service), p_tip: Number(tip) })}>{translate('ตั้งค่าบริการ / ทิป', 'Set service charge / tip')}</button>}</div></article>)}</div>
    {loading && <p role="status">{translate('กำลังโหลด...', 'Loading...')}</p>}
    {more && orders.length > 0 && <button className="btn btn-secondary mt-4" disabled={loading} onClick={() => void load(orders.at(-1))}>{translate('โหลดบิลเก่ากว่านี้', 'Load older bills')}</button>}
    {!loading && orders.length === 0 && <p>{translate('ไม่พบบิลที่ตรงกับตัวกรอง', 'No bills match these filters.')}</p>}
    {editing && <OrderEditor order={editing} restaurantId={restaurantId} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh((n) => n + 1) }} />}
    {receipt && <Receipt orderIds={receipt} onClose={() => setReceipt(null)} />}
  </div>
}
export default function Bills() { return <RequireRole roles={['owner', 'staff']}>{(ctx) => <Board restaurantId={ctx.restaurantId} />}</RequireRole> }
