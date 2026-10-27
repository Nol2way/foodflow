import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useOrders } from '../lib/useOrders'
import { rolesFor } from '../lib/roles'
import { orderLabel, itemQty } from '../lib/format'
import RequireRole from '../components/RequireRole'
import Icon from '../components/Icon'
import type { KitchenOrder, OrderStatus } from '../lib/types'

// พนักงานเสิร์ฟ: ออเดอร์ที่ครัวทำเสร็จ จัดกลุ่มตามที่ต้องไปส่ง (โต๊ะ / กลับบ้าน)
// ติ๊กเสิร์ฟทีละเมนู แล้วกด "เสิร์ฟครบแล้ว" · ด้านล่างเป็นออเดอร์ที่เสิร์ฟแล้วรอชำระเงิน
const STATUSES: OrderStatus[] = ['ready', 'served']

interface Destination {
  key: string
  label: string
  takeaway: boolean
  orders: KitchenOrder[]
}

function groupByDestination(orders: KitchenOrder[]): Destination[] {
  const map = new Map<string, Destination>()
  for (const o of orders) {
    const key = o.order_type === 'dine_in' && o.table_id ? `t:${o.table_id}` : `o:${o.id}`
    const d = map.get(key) ?? { key, label: orderLabel(o), takeaway: o.order_type === 'takeaway', orders: [] }
    d.orders.push(o)
    map.set(key, d)
  }
  return [...map.values()]
}

function Board({ restaurantId }: { restaurantId: string }) {
  const { orders, error, setError, reload } = useOrders(restaurantId, STATUSES)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(tick)
  }, [])

  const waiting = useMemo(() => groupByDestination(orders.filter((o) => o.status === 'ready')), [orders])
  const served = useMemo(() => groupByDestination(orders.filter((o) => o.status === 'served')), [orders])

  async function toggleItem(itemId: string, on: boolean) {
    const { error: err } = await supabase.rpc('set_item_served', { p_item_id: itemId, p_served: on })
    if (err) setError(err.message)
    else void reload()
  }

  async function markServed(o: KitchenOrder) {
    const { error: err } = await supabase.from('orders').update({ status: 'served' }).eq('id', o.id).eq('status', 'ready')
    if (err) setError(err.message)
    else void reload()
  }

  return (
    <div className="page-narrow">
      <div className="page-header">
        <h1 className="page-title">เสิร์ฟอาหาร</h1>
      </div>
      {error && <p className="alert-error">{error}</p>}

      <h2 className="section-title flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full bg-brand-500" />
        รอเสิร์ฟ
        <span className="badge badge-brand">{waiting.reduce((n, d) => n + d.orders.length, 0)} ออเดอร์</span>
      </h2>
      <div className="space-y-3">
        {waiting.map((d) => (
          <article key={d.key} className="card border-l-4 border-l-brand-500 p-4">
            <div className="flex items-center gap-2">
              <span className={`grid h-9 w-9 place-items-center rounded-xl ${d.takeaway ? 'bg-blue-50 text-blue-600' : 'bg-brand-50 text-brand-600'}`}>
                <Icon name={d.takeaway ? 'bag' : 'table'} className="h-5 w-5" />
              </span>
              <div>
                <div className="text-xs text-gray-500">ส่งที่</div>
                <strong className={`text-lg leading-tight ${d.takeaway ? 'text-blue-700' : 'text-gray-900'}`}>{d.label}</strong>
              </div>
            </div>
            {d.orders.map((o) => {
              const minutes = Math.max(0, Math.floor((now - new Date(o.ready_at ?? o.created_at).getTime()) / 60000))
              const servedCount = o.order_items.filter((it) => it.served_at).length
              return (
                <div key={o.id} className="mt-3 border-t pt-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-500">
                      สั่งเมื่อ {new Date(o.created_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className={`badge ${minutes >= 5 ? 'badge-red' : 'badge-gray'}`}>
                      <Icon name="clock" className="h-3.5 w-3.5" />
                      พร้อมมาแล้ว {minutes} นาที
                    </span>
                  </div>
                  {o.note && <p className="note mt-2">หมายเหตุ: {o.note}</p>}
                  <ul className="mt-2 space-y-0.5 text-[15px]">
                    {o.order_items.map((it) => (
                      <li key={it.id}>
                        <button
                          className={`check-row py-2 ${it.served_at ? 'check-row-on' : ''}`}
                          onClick={() => void toggleItem(it.id, !it.served_at)}
                        >
                          <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border-2 ${it.served_at ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-gray-300 bg-white'}`}>
                            {it.served_at && <Icon name="check" className="h-3.5 w-3.5" />}
                          </span>
                          <span className={it.served_at ? 'text-gray-400 line-through' : ''}>
                            {itemQty(it)} {it.menu_items?.name ?? '-'}
                            {it.note && <span className="block text-xs text-brand-600">หมายเหตุ: {it.note}</span>}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className={`text-xs ${servedCount === o.order_items.length ? 'font-semibold text-green-600' : 'text-gray-500'}`}>
                      เสิร์ฟแล้ว {servedCount}/{o.order_items.length} รายการ
                    </span>
                    <button className="btn btn-primary" onClick={() => void markServed(o)}>
                      <Icon name="check" className="h-4 w-4" />
                      เสิร์ฟครบแล้ว
                    </button>
                  </div>
                </div>
              )
            })}
          </article>
        ))}
        {waiting.length === 0 && <p className="empty">ไม่มีอาหารรอเสิร์ฟ</p>}
      </div>

      <h2 className="section-title mt-8 flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
        เสิร์ฟแล้ว รอชำระเงิน
        <span className="badge badge-green">{served.length}</span>
      </h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {served.map((d) => (
          <article key={d.key} className="card p-3 text-sm text-gray-600">
            <strong className={`flex items-center gap-1.5 ${d.takeaway ? 'text-blue-700' : 'text-gray-900'}`}>
              <Icon name="check" className="h-4 w-4 text-emerald-600" />
              {d.label}
            </strong>
            <ul className="mt-1">
              {d.orders.flatMap((o) =>
                o.order_items.map((it) => (
                  <li key={it.id}>
                    {itemQty(it)} {it.menu_items?.name ?? '-'}
                  </li>
                )),
              )}
            </ul>
          </article>
        ))}
        {served.length === 0 && <p className="empty sm:col-span-2">ไม่มี</p>}
      </div>
    </div>
  )
}

export default function Serve() {
  return <RequireRole roles={rolesFor('/serve')}>{(ctx) => <Board restaurantId={ctx.restaurantId} />}</RequireRole>
}
