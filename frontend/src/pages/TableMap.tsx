import { useText } from '../lib/preferences'
import { useCallback, useEffect, useRef, useState } from 'react'
import RequireRole from '../components/RequireRole'
import LoadingState from '../components/LoadingState'
import Icon from '../components/Icon'
import { supabase } from '../lib/supabase'
import { useOrders } from '../lib/useOrders'
import { baht } from '../lib/format'
import { tableLayout } from '../lib/tableLayout'
import { confirmAction, showAlert } from '../lib/alerts'

type Table = { id: string; label: string; floor_x: number; floor_y: number; zone: string; seats: number }
function Board({ restaurantId, canEdit }: { restaurantId: string; canEdit: boolean }) {
  const t = useText()
  const [tables, setTables] = useState<Table[]>([])
  const [loaded, setLoaded] = useState(false)
  const [tableError, setTableError] = useState('')
  const [zone, setZone] = useState('')
  const [filter, setFilter] = useState('all')
  const [view, setView] = useState('overview')
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [now, setNow] = useState(Date.now())
  const { orders, reload, error, loaded: ordersLoaded } = useOrders(restaurantId, ['received', 'preparing', 'ready', 'served'])
  const loadTables = useCallback(async (signal?: AbortSignal) => {
    let query = supabase.from('dining_tables').select('id,label,floor_x,floor_y,zone,seats').eq('restaurant_id', restaurantId).order('label')
    if (signal) query = query.abortSignal(signal)
    const result = await query
    if (signal?.aborted) return
    setTableError(result.error?.message ?? '')
    if (!result.error) { setTables(result.data ?? []); setLoaded(true) }
  }, [restaurantId])
  useEffect(() => {
    const controller = new AbortController()
    void loadTables(controller.signal)
    const tick = setInterval(() => setNow(Date.now()), 30000)
    return () => { controller.abort(); clearInterval(tick) }
  }, [loadTables])
  const selected = tables.find(table => table.id === source)
  const activeFor = (id: string) => orders.filter(order => order.table_id === id)
  const occupied = tables.filter(table => activeFor(table.id).length > 0).length
  const requested = tables.filter(table => activeFor(table.id).some(order => order.bill_requested_at)).length
  const visible = tables.filter(table => (!zone || table.zone === zone) && (filter === 'all' || (filter === 'available' ? !activeFor(table.id).length : filter === 'requested' ? activeFor(table.id).some(order => order.bill_requested_at) : activeFor(table.id).length > 0)))
  const layout = new Map(tableLayout(visible).map(item => [item.id, item]))
  const ready = loaded && ordersLoaded
  const failed = !!(error || tableError)

  async function action(name: 'table_move_orders' | 'table_request_bill') {
    if (lock.current || !ready || failed || !source || (name === 'table_move_orders' && (!target || target === source))) return
    lock.current = true; setBusy(true)
    try {
      const destination = tables.find(table => table.id === target)
      const text = name === 'table_move_orders'
        ? t(`ย้ายออเดอร์จาก ${selected?.label} ไป ${destination?.label} หากมีออเดอร์อยู่จะรวมเข้าด้วยกัน`, `Move orders from ${selected?.label} to ${destination?.label}. Existing orders will be merged.`)
        : t(`แจ้งขอเช็คบิลสำหรับ ${selected?.label}`, `Request the bill for ${selected?.label}`)
      if (!await confirmAction(text)) return
      const args = name === 'table_move_orders' ? { p_restaurant_id: restaurantId, p_source_table_id: source, p_target_table_id: target } : { p_restaurant_id: restaurantId, p_table_id: source }
      const result = await supabase.rpc(name, args)
      if (result.error) throw result.error
      await reload()
      await showAlert(name === 'table_move_orders' ? t('ย้าย / รวมโต๊ะแล้ว', 'Tables moved / merged') : t('แจ้งขอเช็คบิลแล้ว', 'Bill requested'))
    } catch { await showAlert(t('ทำรายการไม่สำเร็จ กรุณาลองใหม่', 'Action failed. Please try again.'), false) }
    finally { lock.current = false; setBusy(false) }
  }
  async function save() {
    if (!selected || lock.current) return
    lock.current = true; setBusy(true)
    try {
      const result = await supabase.from('dining_tables').update({ floor_x: selected.floor_x, floor_y: selected.floor_y, zone: selected.zone.trim() || 'Main', seats: selected.seats }).eq('id', source).eq('restaurant_id', restaurantId)
      if (result.error) throw result.error
      await showAlert(t('บันทึกตำแหน่งโต๊ะแล้ว', 'Table layout saved'))
    } catch { await showAlert(t('บันทึกไม่สำเร็จ กรุณาลองใหม่', 'Unable to save. Please try again.'), false) }
    finally { lock.current = false; setBusy(false) }
  }
  return <div className="page max-w-7xl">
    <div className="page-header"><div><p className="page-subtitle mb-1">{t('หน้าร้าน / สถานะโต๊ะ', 'Front of house / Tables')}</p><h1 className="page-title">{t('ผังโต๊ะ', 'Table map')}</h1><p className="page-subtitle">{t('เลือกโต๊ะเพื่อดูยอด ย้ายออเดอร์ หรือขอเช็คบิล', 'Choose a table to view totals, move orders or request a bill')}</p></div><button className="btn btn-secondary" disabled={busy} onClick={() => { void loadTables(); void reload() }}><Icon name="refresh" />{t('อัปเดต', 'Refresh')}</button></div>
    {failed && <div role="alert" className="alert-error mb-4">{t('โหลดสถานะโต๊ะไม่สำเร็จ', 'Unable to load table status')}: {tableError || error} <button className="underline" onClick={() => { void loadTables(); void reload() }}>{t('ลองใหม่', 'Retry')}</button></div>}
    {!ready && !failed ? <LoadingState label={t('กำลังโหลดโต๊ะและออเดอร์', 'Loading tables and orders')} /> : ready && <>
      <div className="table-summary mb-6" aria-label={t('สรุปโต๊ะ', 'Table summary')}>
        {[[t('โต๊ะทั้งหมด', 'All tables'), tables.length], [t('ว่าง', 'Available'), tables.length - occupied], [t('กำลังใช้งาน', 'Occupied'), occupied], [t('ขอเช็คบิล', 'Bill requested'), requested]].map(([label, count]) => <div key={label}><span className="text-sm text-gray-600">{label}</span><strong className="block text-2xl tabular-nums font-semibold">{failed ? '--' : count}</strong></div>)}
      </div>
      <div className="table-workspace">
        <section className="min-w-0 space-y-4" aria-label={t('เลือกโต๊ะ', 'Choose table')}>
          <div className="flex flex-wrap items-end gap-3">
            <label className="label min-w-32">{t('โซน', 'Zone')}<select className="input block w-full" value={zone} onChange={e => setZone(e.target.value)}><option value="">{t('ทุกโซน', 'All zones')}</option>{[...new Set(tables.map(table => table.zone))].map(z => <option key={z}>{z}</option>)}</select></label>
            <label className="label min-w-36">{t('สถานะ', 'Status')}<select className="input block w-full" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">{t('ทั้งหมด', 'All')}</option><option value="available">{t('ว่าง', 'Available')}</option><option value="occupied">{t('กำลังใช้งาน', 'Occupied')}</option><option value="requested">{t('ขอเช็คบิล', 'Bill requested')}</option></select></label>
            <div className="segmented-control ml-auto" aria-label={t('รูปแบบการแสดงโต๊ะ', 'Table view')}><button aria-pressed={view === 'overview'} onClick={() => setView('overview')}>{t('ภาพรวม', 'Overview')}</button><button aria-pressed={view === 'floor'} onClick={() => setView('floor')}>{t('ผังร้าน', 'Floor plan')}</button></div>
          </div>
          {view === 'floor' && <p className="hint">{t('จัดช่องตามพิกัดเดิม โต๊ะที่ชนกันจะแยกลงแถวถัดไป เลื่อนดูด้านข้างได้', 'Positions follow saved coordinates. Collisions move to the next row. Scroll sideways to explore.')}</p>}
          <div className={view === 'floor' ? 'table-floor-scroll' : ''}>
            <div className={view === 'floor' ? 'table-floor' : 'table-grid'}>
              {visible.map(table => {
                const active = activeFor(table.id)
                const minutes = active.length ? Math.max(0, Math.floor((now - Math.min(...active.map(order => Date.parse(order.created_at)))) / 60000)) : 0
                const bill = active.some(order => order.bill_requested_at)
                const cell = layout.get(table.id)!
                return <button key={table.id} data-table-card={table.id} disabled={busy || failed} onClick={() => { setSource(table.id); setTarget('') }} aria-pressed={source === table.id} className={`table-card ${source === table.id ? 'is-selected' : ''}`} style={view === 'floor' ? { gridColumn: cell.column, gridRow: cell.row } : undefined}>
                  <div className="flex items-center justify-between gap-2"><span className="font-semibold break-words">{table.label}</span><Icon name={source === table.id ? 'check' : 'table'} className="h-5 w-5 shrink-0 text-gray-500" /></div>
                  <span className={`table-status ${bill ? 'status-bill' : active.length ? 'status-occupied' : 'status-available'}`}><span aria-hidden="true" />{bill ? t('ขอเช็คบิล', 'Bill requested') : active.length ? t('กำลังใช้งาน', 'Occupied') : t('ว่าง', 'Available')}</span>
                  <span className="text-xs text-gray-600">{active.length ? t(`${active.length} ออเดอร์ / ${minutes} นาที`, `${active.length} orders / ${minutes} min`) : t(`${table.seats ?? 4} ที่นั่ง / ${table.zone}`, `${table.seats ?? 4} seats / ${table.zone}`)}</span>
                  <span className="font-semibold tabular-nums">{active.length ? baht(active.reduce((sum, order) => sum + Number(order.total), 0)) : t('พร้อมรับลูกค้า', 'Ready for guests')}</span>
                </button>
              })}
            </div>
          </div>
          {!visible.length && <p className="empty card">{tables.length ? t('ไม่มีโต๊ะตรงกับตัวกรอง', 'No tables match these filters') : t('ยังไม่มีโต๊ะในระบบ', 'No tables have been added')}</p>}
        </section>
        <aside className="card table-details space-y-5" aria-label={t('รายละเอียดโต๊ะ', 'Table details')}>
          {!selected ? <div className="py-8 text-center"><Icon name="table" className="mx-auto mb-4 h-8 w-8 text-gray-500" /><h2 className="section-title">{t('เลือกโต๊ะที่ต้องการ', 'Choose a table')}</h2><p className="hint">{t('รายละเอียดและปุ่มทำรายการจะแสดงที่นี่', 'Table details and actions will appear here')}</p></div> : <>
            <div><p className="hint">{selected.zone} / {selected.seats ?? 4} {t('ที่นั่ง', 'seats')}</p><h2 className="text-xl font-semibold">{selected.label}</h2></div>
            <div className="border-y py-4"><span className="text-sm text-gray-600">{t('ยอดรอชำระ', 'Open total')}</span><strong className="block text-3xl font-semibold tabular-nums">{baht(activeFor(source).reduce((sum, order) => sum + Number(order.total), 0))}</strong></div>
            <button disabled={busy || !activeFor(source).length || failed} className="btn btn-primary w-full" onClick={() => void action('table_request_bill')}>{t('ขอเช็คบิล', 'Request bill')}</button>
            <details className="border-t pt-4"><summary className="cursor-pointer font-medium py-2">{t('ย้าย / รวมออเดอร์', 'Move / merge orders')}</summary><div className="space-y-3 pt-3"><label className="label">{t('โต๊ะปลายทาง', 'Destination table')}<select className="input w-full" disabled={busy} value={target} onChange={e => setTarget(e.target.value)}><option value="">{t('เลือกโต๊ะ', 'Choose table')}</option>{tables.filter(table => table.id !== source).map(table => <option key={table.id} value={table.id}>{table.label}</option>)}</select></label><button disabled={busy || !target || !activeFor(source).length || failed} className="btn btn-secondary w-full" onClick={() => void action('table_move_orders')}>{t('ย้าย / รวมออเดอร์', 'Move / merge orders')}</button></div></details>
            {canEdit && <details className="border-t pt-4"><summary className="cursor-pointer font-medium py-2">{t('แก้ไขข้อมูลและตำแหน่ง', 'Edit table and position')}</summary><fieldset disabled={busy} className="grid grid-cols-2 gap-3 pt-3">{(['floor_x', 'floor_y', 'zone', 'seats'] as const).map(key => <label className="label min-w-0" key={key}>{key === 'seats' ? t('ที่นั่ง', 'Seats') : key === 'zone' ? t('โซน', 'Zone') : key === 'floor_x' ? t('แนวนอน (%)', 'Horizontal (%)') : t('แนวตั้ง (%)', 'Vertical (%)')}<input className="input w-full" type={key === 'zone' ? 'text' : 'number'} min={key === 'seats' ? 1 : 0} max={key === 'seats' ? 100 : 90} value={selected[key] ?? (key === 'zone' ? '' : 4)} onChange={e => setTables(rows => rows.map(table => table.id !== source ? table : { ...table, [key]: key === 'zone' ? e.target.value : Math.max(key === 'seats' ? 1 : 0, Math.min(key === 'seats' ? 100 : 90, Number(e.target.value))) }))} /></label>)}<button className="btn btn-secondary col-span-2" onClick={() => void save()}>{t('บันทึกข้อมูลโต๊ะ', 'Save table')}</button></fieldset></details>}
          </>}
        </aside>
      </div>
    </>}
  </div>
}
export default function TableMap() { return <RequireRole roles={['owner', 'staff', 'manager']}>{ctx => <Board key={ctx.restaurantId} restaurantId={ctx.restaurantId} canEdit={ctx.roles.includes('owner') || ctx.roles.includes('manager')} />}</RequireRole> }
