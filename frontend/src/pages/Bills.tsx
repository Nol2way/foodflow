import { useText } from '../lib/preferences'
import { useCallback, useEffect, useRef, useState } from 'react'
import RequireRole from '../components/RequireRole'
import Receipt from '../components/Receipt'
import OrderEditor from '../components/OrderEditor'
import { supabase } from '../lib/supabase'
import { promotionError } from '../lib/promotions'
import { baht, orderLabel, itemQty } from '../lib/format'
import type { KitchenOrder } from '../lib/types'
import Pagination from '../components/Pagination'
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
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(10)
  const [cursors, setCursors] = useState<(KitchenOrder | undefined)[]>([undefined])
  const request = useRef(0)
  const mutation = useRef(false)
  const reading = useRef(false)
  const [revision, refresh] = useState(0)
  const load = useCallback(async (cursor?: KitchenOrder, targetPage = 0) => {
    if (cursor && reading.current) return
    reading.current = true
    const sequence = ++request.current
    setLoading(true)
    let query = supabase.from('orders').select('*,dining_tables(label),order_items(*,menu_items(name))').eq('restaurant_id', restaurantId).eq('status', status)
    const term = search.trim()
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(term)) query = query.eq('id', term)
    else if (term) query = query.ilike('customer_label', `%${term.replace(/[%_]/g, '')}%`)
    if (cursor) query = query.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`)
    const { data, error } = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(pageSize + 1)
    if (sequence !== request.current) return
    reading.current = false
    setLoading(false)
    if (error) { setMessage(error.message); return }
    const next = (data ?? []) as KitchenOrder[]
    setOrders(next.slice(0, pageSize))
    setPage(targetPage)
    setCursors(previous => [...previous.slice(0, targetPage), cursor])
    setSelected([])
    setMore(next.length > pageSize)
  }, [restaurantId, status, search, pageSize])
  useEffect(() => {
    setOrders([]); setSelected([]); setMore(false); setMessage(''); setPage(0); setCursors([undefined])
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
  return <div className="page"><h1 className="page-title">{translate('ประวัติและจัดการบิล', 'Bill history and management')}</h1><p className="hint">{translate('เลือกบิลเพื่อดูรายการหรือจัดการ แบ่งหน้าประวัติโดยไม่โหลดสะสม', 'Open a bill to view or manage its items. Pages replace the list instead of appending.')}</p>
    <div className="mt-4 grid gap-3 sm:grid-cols-[14rem_minmax(0,1fr)]">
    <label className="label">{translate('สถานะ', 'Status')} <select className="input block w-full" value={status} onChange={(e) => setStatus(e.target.value)}><option value="paid">{translate('ชำระแล้ว / พิมพ์ซ้ำ', 'Paid / reprint')}</option><option value="received">{translate('รอครัว / แก้ไข', 'Received / edit')}</option><option value="served">{translate('เสิร์ฟแล้ว / แยกบิล', 'Served / split')}</option><option value="cancelled">{translate('ยกเลิก', 'Cancel')}</option></select></label>
    <label className="label">{translate('ค้นหาเลขออเดอร์หรือชื่อลูกค้า', 'Search order ID or customer name')}<input className="input w-full" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
    </div>
    {message && <p className="alert-warn" role="status">{message}</p>}
    {status !== 'paid' && status !== 'cancelled' && <div className="toolbar my-3"><label>{translate('ค่าบริการ (บาท)', 'Service charge (baht)')}<input className="input w-28" type="number" min={0} step="0.01" value={service} onChange={(e) => setService(e.target.value)} /></label><label>{translate('ทิป (บาท)', 'Tip (baht)')}<input className="input w-28" type="number" min={0} step="0.01" value={tip} onChange={(e) => setTip(e.target.value)} /></label></div>}
    <Pagination label={translate('แบ่งหน้าบิล', 'Bill pagination')} page={page} pageSize={pageSize} count={orders.length} hasNext={more} loading={loading || busy}
      onPrevious={() => void load(cursors[page - 1], page - 1)} onNext={() => void load(orders.at(-1), page + 1)} onPageSizeChange={setPageSize} />
    <div className="history-scroll list-card" aria-busy={loading}>{orders.map((order) => <article key={order.id}>
      <details className="bill-details">
        <summary className="flex min-h-14 cursor-pointer items-center gap-3 px-4 py-2 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-brand-600">
          <span className="min-w-0 flex-1"><strong className="block truncate">{orderLabel(order)}</strong><span className="hint whitespace-nowrap">{new Date(order.created_at).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' })}<span className="hidden sm:inline"> / {order.id.slice(0, 8)}</span></span></span>
          <span className="hidden text-gray-600 sm:block">{order.order_items.length} {translate('รายการ', 'items')}</span>
          <strong className="min-w-20 text-right tabular-nums">{baht(Number(order.total))}</strong>
          <span className="text-sm text-brand-700">{translate('รายละเอียด', 'Details')}</span>
        </summary>
        <div className="border-t bg-gray-50 p-4">
          <p className="hint mb-3 break-all">{order.id}</p>
          <ul className="space-y-2">{order.order_items.map(it => <li key={it.id}><label className="flex gap-2">{['received', 'served'].includes(status) && <input type="checkbox" checked={selected.includes(it.id)} onChange={e => setSelected(e.target.checked ? [...selected, it.id] : selected.filter(id => id !== it.id))} />}{itemQty(it)} {it.menu_items?.name}{it.options_snapshot?.map(x => x.name).join(', ')}</label></li>)}</ul>
          <div className="toolbar mt-3">
            {status === 'paid' && <button className="btn btn-primary" onClick={() => setReceipt([order.id])}>{translate('พิมพ์ใบเสร็จซ้ำ', 'Reprint receipt')}</button>}
            {status === 'received' && <button disabled={busy} className="btn btn-secondary" onClick={() => setEditing(order)}>{translate('แก้ไขรายการ', 'Edit items')}</button>}
            {['received', 'served'].includes(status) && <>
              <button disabled={busy || !order.order_items.some(it => selected.includes(it.id))} className="btn btn-secondary" onClick={() => void mutate('staff_split_order', { p_order_id: order.id, p_item_ids: order.order_items.filter(it => selected.includes(it.id)).map(it => it.id) })}>{translate('แยกรายการที่เลือกเป็นบิลใหม่', 'Split selected lines')}</button>
              <button disabled={busy || !Number.isFinite(Number(service)) || !Number.isFinite(Number(tip)) || Number(service) < 0 || Number(tip) < 0} className="btn btn-secondary" onClick={() => void mutate('order_set_charges', { p_order_id: order.id, p_service_charge: Number(service), p_tip: Number(tip) })}>{translate('ตั้งค่าบริการ / ทิป', 'Set service charge / tip')}</button>
            </>}
          </div>
        </div>
      </details>
    </article>)}</div>
    {loading && <p role="status">{translate('กำลังโหลด...', 'Loading...')}</p>}
    {!loading && orders.length === 0 && <p>{translate('ไม่พบบิลที่ตรงกับตัวกรอง', 'No bills match these filters.')}</p>}
    {editing && <OrderEditor order={editing} restaurantId={restaurantId} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh((n) => n + 1) }} />}
    {receipt && <Receipt orderIds={receipt} onClose={() => setReceipt(null)} />}
  </div>
}
export default function Bills() { return <RequireRole roles={['owner', 'staff']}>{(ctx) => <Board restaurantId={ctx.restaurantId} />}</RequireRole> }
