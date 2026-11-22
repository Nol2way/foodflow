import { useText } from '../lib/preferences'
import { useEffect, useRef, useState } from 'react'
import RequireRole from '../components/RequireRole'
import { supabase } from '../lib/supabase'
import { useOrders } from '../lib/useOrders'
import { baht } from '../lib/format'
type Table = { id: string; label: string; floor_x: number; floor_y: number; zone: string; seats: number }
function Board({ restaurantId, canEdit }: { restaurantId: string; canEdit: boolean }) {
  const translate = useText()
  const [tables, setTables] = useState<Table[]>([])
  const [zone, setZone] = useState('')
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [message, setMessage] = useState('')
  const [now, setNow] = useState(Date.now())
  const { orders, reload, error } = useOrders(restaurantId, ['received', 'preparing', 'ready', 'served'])
  useEffect(() => {
    let alive = true
    void supabase.from('dining_tables').select('id,label,floor_x,floor_y,zone,seats').eq('restaurant_id', restaurantId).order('label').then(({ data, error }) => {
      if (!alive) return
      if (error) setMessage(error.message)
      else setTables(data as Table[])
    })
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => { alive = false; clearInterval(tick) }
  }, [restaurantId])
  const selected = tables.find((t) => t.id === source)
  async function action(name: 'table_move_orders' | 'table_request_bill') {
    if (lock.current || !source || (name === 'table_move_orders' && (!target || target === source))) return
    lock.current = true
    setBusy(true)
    const args = name === 'table_move_orders' ? { p_restaurant_id: restaurantId, p_source_table_id: source, p_target_table_id: target } : { p_restaurant_id: restaurantId, p_table_id: source }
    const { error } = await supabase.rpc(name, args)
    setMessage(error ? error.message : name === 'table_move_orders' ? translate('ย้าย / รวมโต๊ะแล้ว', 'Tables moved / merged') : translate('แจ้งขอเช็คบิลแล้ว', 'Bill requested'))
    lock.current = false
    setBusy(false)
    void reload()
  }
  async function save() {
    if (!selected || lock.current) return
    lock.current = true
    setBusy(true)
    const { error } = await supabase.from('dining_tables').update({ floor_x: selected.floor_x, floor_y: selected.floor_y, zone: selected.zone.trim() || 'Main', seats: selected.seats }).eq('id', source)
    setMessage(error?.message ?? translate('บันทึกตำแหน่งโต๊ะแล้ว', 'Table layout saved'))
    lock.current = false
    setBusy(false)
  }
  return <div className="page"><h1 className="page-title">{translate('ผังโต๊ะ', 'Table map')}</h1>
    {(message || error) && <p role="status" className="alert-warn">{message || error}</p>}
    <label className="label">{translate('โซน', 'Zone')} <select className="input" value={zone} onChange={(e) => setZone(e.target.value)}><option value="">{translate('ทุกโซน', 'All zones')}</option>{[...new Set(tables.map((t) => t.zone))].map((z) => <option key={z}>{z}</option>)}</select></label>
    <div className="relative my-4 h-[500px] overflow-auto rounded-xl border bg-gray-50">
      {tables.filter((t) => !zone || t.zone === zone).map((t) => {
        const active = orders.filter((o) => o.table_id === t.id)
        const minutes = active.length ? Math.max(0, Math.floor((now - Math.min(...active.map((o) => Date.parse(o.created_at)))) / 60000)) : 0
        return <button key={t.id} onClick={() => setSource(t.id)} aria-pressed={source === t.id} className={`absolute w-28 rounded-xl border-2 p-3 text-sm ${source === t.id ? 'border-brand-500' : 'border-gray-200'} ${active.length ? 'bg-amber-50' : 'bg-white'}`} style={{ left: `${Number.isFinite(Number(t.floor_x)) ? Number(t.floor_x) : 0}%`, top: `${Number.isFinite(Number(t.floor_y)) ? Number(t.floor_y) : 0}%` }}><b>{t.label}</b><span className="block">{active.length ? translate(`${active.length} ออเดอร์ / ${minutes} นาที`, `${active.length} orders / ${minutes} min`) : translate('ว่าง', 'Available')}</span>{active.length > 0 && <span>{baht(active.reduce((s, o) => s + Number(o.total), 0))}</span>}</button>
      })}
    </div>
    {selected && <section className="card space-y-3"><h2 className="section-title">{selected.label}</h2><div className="toolbar"><label>{translate('โต๊ะปลายทาง', 'Destination table')} <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}><option value="">{translate('เลือกโต๊ะ', 'Choose table')}</option>{tables.filter((t) => t.id !== source).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label><button disabled={busy || !target} className="btn btn-primary" onClick={() => void action('table_move_orders')}>{translate('ย้าย / รวมออเดอร์', 'Move / merge orders')}</button><button disabled={busy} className="btn btn-secondary" onClick={() => void action('table_request_bill')}>{translate('ขอเช็คบิล', 'Request bill')}</button></div>
      {canEdit && <div className="toolbar">{(['floor_x', 'floor_y', 'zone', 'seats'] as const).map((key) => <label key={key}>{key === 'seats' ? translate('ที่นั่ง', 'Seats') : key === 'zone' ? translate('โซน', 'Zone') : key === 'floor_x' ? translate('ตำแหน่งแนวนอน (%)', 'Horizontal position (%)') : translate('ตำแหน่งแนวตั้ง (%)', 'Vertical position (%)')}<input className="input w-32" type={key === 'zone' ? 'text' : 'number'} min={key === 'seats' ? 1 : 0} max={key === 'seats' ? 100 : 90} value={selected[key] ?? 4} onChange={(e) => setTables(tables.map((t) => t.id !== source ? t : { ...t, [key]: key === 'zone' ? e.target.value : Math.max(key === 'seats' ? 1 : 0, Math.min(key === 'seats' ? 100 : 90, Number(e.target.value))) }))} /></label>)}<button disabled={busy} className="btn btn-secondary" onClick={() => void save()}>{translate('บันทึกผัง', 'Save layout')}</button></div>}
    </section>}
  </div>
}
export default function TableMap() { return <RequireRole roles={['owner', 'staff']}>{(ctx) => <Board restaurantId={ctx.restaurantId} canEdit={ctx.roles.includes('owner') || ctx.roles.includes('manager')} />}</RequireRole> }
