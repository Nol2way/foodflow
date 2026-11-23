import { translateUi } from "../lib/uiText"
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useOrders } from '../lib/useOrders'
import { rolesFor } from '../lib/roles'
import { orderLabel, itemQty } from '../lib/format'
import RequireRole from '../components/RequireRole'
import Icon from '../components/Icon'
import LoadingState from '../components/LoadingState'
import KitchenTicket from '../components/KitchenTicket'
import { useShopSettings } from '../lib/shop'
import type { Role } from '../lib/roles'
import type { KitchenOrder, OrderStatus } from '../lib/types'

const COLUMNS: { status: OrderStatus; title: string; dot: string; button: string }[] = [
  { status: 'received', title: 'ออเดอร์ใหม่', dot: 'bg-blue-500', button: 'btn-primary' },
  { status: 'preparing', title: 'กำลังทำ', dot: 'bg-amber-500', button: 'btn-success' },
  { status: 'ready', title: 'พร้อมเสิร์ฟ', dot: 'bg-emerald-500', button: 'btn-secondary' },
]

const NEXT: Partial<Record<OrderStatus, { status: OrderStatus; label: string }>> = {
  received: { status: 'preparing', label: 'เริ่มทำ' },
  preparing: { status: 'ready', label: 'ทำเสร็จ' },
  ready: { status: 'served', label: 'เสิร์ฟแล้ว' },
}

// 0034: เริ่มทำ / ทำเสร็จ / ติ๊กเสร็จรายเมนู เป็นของครัว (และเจ้าของ) เท่านั้น
// หน้าร้าน/เสิร์ฟกดได้แค่คอลัมน์พร้อมเสิร์ฟ (ติ๊กเสิร์ฟรายเมนู + เสิร์ฟแล้ว) ฐานข้อมูลบังคับซ้ำ
const COOK_STEPS: OrderStatus[] = ['received', 'preparing']
const canCook = (roles: Role[]) => roles.includes('owner') || roles.includes('kitchen')

// คอลัมน์ที่ติ๊กรายเมนูได้: กำลังทำ = เสร็จแล้ว / พร้อมเสิร์ฟ = เสิร์ฟแล้ว
const ITEM_CHECK: Partial<Record<OrderStatus, { field: 'done_at' | 'served_at'; label: string }>> = {
  preparing: { field: 'done_at', label: 'เสร็จ' },
  ready: { field: 'served_at', label: 'เสิร์ฟแล้ว' },
}

function Board({ restaurantId, roles }: { restaurantId: string; roles: Role[] }) {
  const shop = useShopSettings(restaurantId)
  const [tickets, setTickets] = useState<KitchenOrder[]>([])
  const [autoTicket, setAutoTicket] = useState(false)
  const [soundReady, setSoundReady] = useState(false)
  const audio = useRef<AudioContext | null>(null)
  const seen = useRef<Set<string> | null>(null)
  const [warning, setWarning] = useState('15')
  useEffect(() => { if (shop.settings) setWarning(String(shop.settings.kitchen_warn_minutes ?? 15)) }, [shop.settings])
  const cook = canCook(roles)
  const allowed = (status: OrderStatus) => cook || !COOK_STEPS.includes(status)
  const { orders, error, setError, reload, loaded } = useOrders(restaurantId, ['received', 'preparing', 'ready'])
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [])

  useEffect(() => {
    if (!loaded) return
    const fresh = orders.filter((o) => o.status === 'received' && seen.current && !seen.current.has(o.id))
    const previous = seen.current ?? new Set<string>()
    for (const order of orders) previous.add(order.id)
    seen.current = previous
    if (!fresh.length) return
    if (shop.settings?.kitchen_sound !== false && soundReady && audio.current) {
      const oscillator = audio.current.createOscillator()
      const gain = audio.current.createGain()
      oscillator.connect(gain); gain.connect(audio.current.destination)
      gain.gain.value = 0.15; oscillator.frequency.value = 880
      oscillator.start(); oscillator.stop(audio.current.currentTime + 0.3)
    }
    if (shop.settings?.kitchen_auto_print) { setAutoTicket(true); setTickets((rows) => [...rows, ...fresh]) }
  }, [orders, shop.settings, soundReady, loaded])
  useEffect(() => () => { void audio.current?.close() }, [])
  async function saveKitchen(patch: Record<string, unknown>) {
    const { error } = await supabase.from('shop_settings').upsert({ restaurant_id: restaurantId, ...patch })
    if (error) setError(error.message)
    else void shop.reload()
  }

  async function advance(order: KitchenOrder) {
    const next = NEXT[order.status]
    if (!next || !allowed(order.status)) return
    const { error: err } = await supabase.from('orders').update({ status: next.status }).eq('id', order.id)
    if (err) setError(err.message.includes('kitchen_only') ? 'ขั้นนี้ต้องให้ครัวเป็นคนกด' : err.message)
    else void reload()
  }

  // กำลังทำ: ครัวติ๊กเสร็จรายเมนู / พร้อมเสิร์ฟ: พนักงานติ๊กเสิร์ฟรายเมนู
  async function toggleItem(order: KitchenOrder, itemId: string, on: boolean) {
    if (!allowed(order.status)) return
    const { error: err } =
      order.status === 'preparing'
        ? await supabase.rpc('kitchen_set_item_done', { p_item_id: itemId, p_done: on })
        : await supabase.rpc('set_item_served', { p_item_id: itemId, p_served: on })
    if (err) setError(err.message)
    else void reload()
  }

  return (
    // พื้นหลังเดียวกับทุกหน้า (สีครีมจาก body)
    <div className="page max-w-none">
      <div className="page-header">
        <h1 className="page-title">{translateUi("หน้าจอครัว")}</h1>
        <span className="badge badge-green">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />{"" + translateUi("อัปเดตอัตโนมัติ") + " "}</span>
      </div>
      <div className="toolbar mb-4"><button className="btn btn-secondary" onClick={() => { audio.current ??= new AudioContext(); void audio.current.resume(); setSoundReady(true) }}>{soundReady ? 'เปิดเสียงแจ้งเตือนแล้ว' : 'เปิดเสียงแจ้งเตือน'}</button>
        {roles.includes('owner') && <><label>{translateUi("เตือนเมื่อครบ (นาที)")}<input className="input w-20" type="number" min="1" max="180" value={warning} onChange={(e) => setWarning(e.target.value)} /></label><button className="btn btn-secondary" disabled={!Number.isInteger(Number(warning)) || Number(warning) < 1 || Number(warning) > 180} onClick={() => void saveKitchen({ kitchen_warn_minutes: Number(warning) })}>{translateUi("บันทึกเวลา")}</button><label className="flex gap-2"><input type="checkbox" checked={shop.settings?.kitchen_auto_print ?? false} onChange={(e) => void saveKitchen({ kitchen_auto_print: e.target.checked })} />{translateUi("เปิดหน้าพิมพ์เมื่อมีออเดอร์ใหม่")}</label><label className="flex gap-2"><input type="checkbox" checked={shop.settings?.kitchen_sound ?? true} onChange={(e) => void saveKitchen({ kitchen_sound: e.target.checked })} />{translateUi("เสียงออเดอร์ใหม่")}</label></>}
      </div>
      {tickets.length > 0 && <KitchenTicket orders={tickets} auto={autoTicket} onClose={() => { setTickets([]); setAutoTicket(false) }} />}
      {error && <p className="alert-error">{error}</p>}
      {!cook && (
        <p className="mb-4 flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600 shadow-card">
          <Icon name="serve" className="h-4 w-4 shrink-0 text-emerald-600" />{"" + translateUi("โหมดหน้าร้าน: ดูความคืบหน้าของครัวได้ กดได้เฉพาะออเดอร์ที่พร้อมเสิร์ฟ") + " "}</p>
      )}

      {!loaded && !error ? <LoadingState label={translateUi('กำลังโหลดออเดอร์')} rows={3} /> : <div className="grid items-start gap-4 md:grid-cols-3">
        {COLUMNS.map((col) => {
          const list = orders.filter((o) => o.status === col.status)
          return (
            <section key={col.status} className="rounded-2xl border border-gray-200/80 bg-gray-900/[.03] p-3">
              <h2 className="mb-3 flex items-center gap-2 px-1 strong-text">
                <span className={`h-2.5 w-2.5 rounded-full ${col.dot}`} />
                {translateUi(col.title)}
                <span className="badge badge-gray ml-auto">{list.length}</span>
              </h2>
              <div className="space-y-3">
                {list.map((o) => {
                  const minutes = Math.max(0, Math.floor((now - new Date(o.created_at).getTime()) / 60000))
                  const can = allowed(o.status)
                  const check = ITEM_CHECK[o.status]
                  const isOn = (it: KitchenOrder['order_items'][number]) => Boolean(check && it[check.field])
                  const onCount = o.order_items.filter(isOn).length
                  return (
                    <article key={o.id} className={`card p-3.5 ${minutes >= (shop.settings?.kitchen_warn_minutes ?? 15) ? 'border-red-300 ring-2 ring-red-100' : ''}`}>
                      <div className="row-between">
                        <strong className={`text-lg ${o.order_type === 'takeaway' ? 'text-blue-700' : 'text-gray-900'}`}>{orderLabel(o)}</strong>
                        <span className={`badge ${minutes >= (shop.settings?.kitchen_warn_minutes ?? 15) ? 'badge-red' : 'badge-gray'}`}>
                          <Icon name="clock" className="h-3.5 w-3.5" />
                          {minutes}{" " + translateUi("นาที") + " "}</span>
                      </div>
                      <button className="link text-xs" onClick={() => { setAutoTicket(false); setTickets([o]) }}>{translateUi("พิมพ์ใบงานครัว")}</button>
                      {o.note && <p className="note mt-2">{"" + translateUi("หมายเหตุ:") + " "}{o.note}</p>}
                      <ul className="mt-2 space-y-0.5 text-[15px]">
                        {o.order_items.map((it) =>
                          check ? (
                            <li key={it.id}>
                              <button
                                className={`check-row ${isOn(it) ? 'check-row-on' : ''} disabled:cursor-default disabled:hover:bg-transparent`}
                                disabled={!can}
                                onClick={() => void toggleItem(o, it.id, !isOn(it))}
                              >
                                <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border-2 ${isOn(it) ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-gray-300 bg-white'}`}>
                                  {isOn(it) && <Icon name="check" className="h-3.5 w-3.5" />}
                                </span>
                                <span className={isOn(it) ? 'text-gray-400 line-through' : ''}>
                                  {itemQty(it)} {it.menu_items?.name ?? '-'}
                                  {it.options_snapshot?.map((option) => <span key={option.id} className="block text-xs">+ {option.name}</span>)}
                                  {it.note && <span className="block text-xs text-brand-600 no-underline">{"" + translateUi("หมายเหตุ:") + " "}{it.note}</span>}
                                </span>
                              </button>
                            </li>
                          ) : (
                            <li key={it.id} className="px-2 py-1">
                              <span className="font-semibold">{itemQty(it)}</span> {it.menu_items?.name ?? '-'}
                              {it.options_snapshot?.map((option) => <span key={option.id} className="block text-xs">+ {option.name}</span>)}
                              {it.note && <div className="text-xs text-brand-600">{"" + translateUi("หมายเหตุ:") + " "}{it.note}</div>}
                            </li>
                          ),
                        )}
                      </ul>
                      {check && (
                        <p className={`mt-2 text-xs ${onCount === o.order_items.length ? 'font-semibold text-green-600' : 'text-gray-500'}`}>
                          {translateUi(check.label)} {onCount}/{o.order_items.length}{" " + translateUi("รายการ") + " "}</p>
                      )}
                      {can ? (
                        <button className={`btn ${col.button} mt-3 w-full`} onClick={() => void advance(o)}>
                          {translateUi(NEXT[o.status]?.label ?? '')}
                        </button>
                      ) : (
                        <p className="mt-3 flex min-h-10 items-center justify-center gap-1.5 rounded-xl bg-gray-100 text-sm text-gray-500">
                          <Icon name="clock" className="h-4 w-4" />
                          {translateUi(o.status === 'received' ? 'รอครัวรับออเดอร์' : 'ครัวกำลังทำ')}
                        </p>
                      )}
                    </article>
                  )
                })}
                {loaded && !error && list.length === 0 && <p className="empty">{translateUi("ไม่มีออเดอร์")}</p>}
              </div>
            </section>
          )
        })}
      </div>}
    </div>
  )
}

export default function Kitchen() {
  return <RequireRole roles={rolesFor('/kitchen')}>{(ctx) => <Board restaurantId={ctx.restaurantId} roles={ctx.roles} />}</RequireRole>
}
