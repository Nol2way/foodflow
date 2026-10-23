import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { rolesFor } from '../lib/roles'
import { baht, orderLabel } from '../lib/format'
import { useOrders } from '../lib/useOrders'
import RequireRole from '../components/RequireRole'
import PromoPicker, { usePromoSelection, usePromotions } from '../components/PromoPicker'
import Icon from '../components/Icon'
import { promotionError } from '../lib/promotions'
import type { CartLine, MenuCategory, MenuItem, OrderStatus, OrderType } from '../lib/types'

// หน้ารับออเดอร์ของพนักงาน: เลือกโต๊ะ/กลับบ้าน → เลือกเมนู → ส่งเข้าครัว
// ราคาและเมนูที่หมดตรวจซ้ำในฐานข้อมูล (staff_place_order) เสมอ

interface DiningTable {
  id: string
  label: string
}

const OPEN: OrderStatus[] = ['received', 'preparing', 'ready', 'served']
const STATUS_LABEL: Partial<Record<OrderStatus, string>> = {
  received: 'รอครัว',
  preparing: 'กำลังทำ',
  ready: 'พร้อมเสิร์ฟ',
  served: 'เสิร์ฟแล้ว',
}

function Board({ restaurantId }: { restaurantId: string }) {
  const [categories, setCategories] = useState<MenuCategory[]>([])
  const [items, setItems] = useState<MenuItem[]>([])
  const [tables, setTables] = useState<DiningTable[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  const [orderType, setOrderType] = useState<OrderType>('dine_in')
  const [tableId, setTableId] = useState<string | null>(null)
  const [customer, setCustomer] = useState('')
  const [category, setCategory] = useState<string | 'all'>('all')
  const [search, setSearch] = useState('')
  const [cart, setCart] = useState<Record<string, CartLine>>({})
  const [orderNote, setOrderNote] = useState('')
  const [sending, setSending] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const { orders } = useOrders(restaurantId, OPEN)
  const promotions = usePromotions(restaurantId)

  const loadMenu = useCallback(async () => {
    const [c, m, t] = await Promise.all([
      supabase.from('menu_categories').select('id,name,sort_order').eq('restaurant_id', restaurantId).order('sort_order'),
      supabase.from('menu_items').select('id,category_id,name,price,is_available').eq('restaurant_id', restaurantId).order('name'),
      supabase.from('dining_tables').select('id,label').eq('restaurant_id', restaurantId).order('label'),
    ])
    if (c.error || m.error || t.error) {
      setLoadError('โหลดเมนูหรือโต๊ะไม่สำเร็จ')
      return
    }
    setLoadError(null)
    setCategories(c.data as MenuCategory[])
    setItems((m.data as MenuItem[]).map((x) => ({ ...x, price: Number(x.price) })))
    setTables(t.data as DiningTable[])
  }, [restaurantId])

  useEffect(() => {
    void loadMenu()
    // เมนูหมด/เปิดขาย เปลี่ยนจากหน้าครัวหรือสต็อก ให้หน้านี้เห็นด้วย
    const ch = supabase
      .channel(`menu-${restaurantId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_items', filter: `restaurant_id=eq.${restaurantId}` }, () => void loadMenu())
      .subscribe()
    return () => void supabase.removeChannel(ch)
  }, [restaurantId, loadMenu])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter((i) => (category === 'all' || i.category_id === category) && (!q || i.name.toLowerCase().includes(q)))
  }, [items, category, search])

  const lines = Object.values(cart)
  const count = lines.reduce((s, l) => s + l.quantity, 0)
  const total = lines.reduce((s, l) => s + l.quantity * l.item.price, 0)
  const openByTable = useMemo(() => {
    const m = new Map<string, number>()
    for (const o of orders) if (o.table_id) m.set(o.table_id, (m.get(o.table_id) ?? 0) + 1)
    return m
  }, [orders])
  const tableOrders = orders.filter((o) => orderType === 'dine_in' && o.table_id === tableId)

  function change(item: MenuItem, delta: number) {
    setCart((prev) => {
      const cur = prev[item.id]
      const qty = (cur?.quantity ?? 0) + delta
      const next = { ...prev }
      if (qty <= 0) delete next[item.id]
      else next[item.id] = { item, quantity: Math.min(qty, 50), note: cur?.note ?? '' }
      return next
    })
  }

  function setNote(id: string, note: string) {
    setCart((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], note } } : prev))
  }

  const target =
    orderType === 'takeaway' ? (customer.trim() ? `กลับบ้าน · ${customer.trim()}` : 'กลับบ้าน') : tables.find((t) => t.id === tableId)?.label
  // โปรที่ใช้ได้ตอนนี้ เลือกให้อัตโนมัติ (ใช้หลายโปรได้ถ้าไม่ชนกัน) พนักงานติ๊กเปลี่ยนได้
  const livePromos = promotions.all.filter((p) => promotions.liveIds.has(p.id))
  const promoLines = lines.map((l) => ({ menuItemId: l.item.id, amount: l.quantity * l.item.price }))
  const promoSel = usePromoSelection(livePromos, promotions.itemsOf, promoLines)
  const discount = promoSel.discounts.total
  const ready = count > 0 && (orderType === 'takeaway' || tableId !== null) && !sending

  async function send() {
    if (!ready) return
    setSending(true)
    setMessage(null)
    const { data: orderId, error } = await supabase.rpc('staff_place_order', {
      p_restaurant_id: restaurantId,
      p_items: lines.map((l) => ({ menu_item_id: l.item.id, quantity: l.quantity, note: l.note.trim() || null })),
      p_table_id: orderType === 'dine_in' ? tableId : null,
      p_order_type: orderType,
      p_customer_label: orderType === 'takeaway' ? customer.trim() || null : null,
      p_note: orderNote.trim() || null,
      p_promotion_ids: promoSel.selectedIds,
    })
    setSending(false)
    if (error) {
      const unavailable = error.message.match(/item_unavailable: (.+)/)
      setMessage({
        ok: false,
        text: unavailable
          ? `${unavailable[1]} หมดแล้ว เอาออกจากรายการก่อนส่ง`
          : error.message.includes('promotion_')
            ? promotionError(error.message)
            : 'ส่งออเดอร์ไม่สำเร็จ กรุณาลองใหม่',
      })
      void loadMenu()
      void promotions.reload()
      return
    }
    // ยอดจริงจากฐานข้อมูล (หลังหักส่วนลด)
    const { data: saved } = await supabase.from('orders').select('total,discount_total').eq('id', orderId as string).single()
    const net = saved ? Number(saved.total) : total - discount
    const disc = saved ? Number(saved.discount_total) : discount
    setMessage({
      ok: true,
      text: `ส่งออเดอร์ ${target} เข้าครัวแล้ว (${count} รายการ · ${baht(net)}${disc > 0 ? ` ลด ${baht(disc)}` : ''})`,
    })
    promoSel.resetAuto()
    void promotions.reload() // จำนวนครั้งที่เหลือเปลี่ยน
    setCart({})
    setOrderNote('')
    if (orderType === 'takeaway') setCustomer('')
  }

  return (
    <div className="page grid max-w-7xl gap-5 lg:grid-cols-[1fr_380px]">
      <div>
        <h1 className="page-title mb-4">รับออเดอร์</h1>
        {loadError && <p className="alert-error">{loadError}</p>}

        {/* 1) ทานที่ร้าน / กลับบ้าน */}
        <div className="mb-4 inline-flex rounded-xl border bg-white p-1 shadow-xs">
          {(['dine_in', 'takeaway'] as OrderType[]).map((t) => (
            <button
              key={t}
              onClick={() => setOrderType(t)}
              className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${orderType === t ? 'bg-brand-500 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              <Icon name={t === 'dine_in' ? 'table' : 'bag'} className="h-4 w-4" />
              {t === 'dine_in' ? 'ทานที่ร้าน' : 'กลับบ้าน'}
            </button>
          ))}
        </div>

        {orderType === 'dine_in' ? (
          <div className="mb-5 grid grid-cols-3 gap-2 sm:grid-cols-5 xl:grid-cols-6">
            {tables.map((t) => {
              const open = openByTable.get(t.id) ?? 0
              return (
                <button
                  key={t.id}
                  onClick={() => setTableId(t.id)}
                  className={`rounded-xl border-2 bg-white px-2 py-3 text-sm font-medium shadow-xs transition ${tableId === t.id ? 'border-brand-500 bg-brand-50 text-brand-700' : open > 0 ? 'border-blue-200 hover:border-blue-300' : 'border-transparent hover:border-gray-300'}`}
                >
                  {t.label}
                  {open > 0 && <div className="mt-0.5 text-xs font-normal text-blue-600">มี {open} ออเดอร์</div>}
                </button>
              )
            })}
            {tables.length === 0 && <p className="empty col-span-full">ยังไม่มีโต๊ะในระบบ</p>}
          </div>
        ) : (
          <input
            className="input mb-5 w-full py-2.5"
            maxLength={50}
            placeholder="ชื่อหรือเบอร์ลูกค้า (ไม่บังคับ)"
            value={customer}
            onChange={(e) => setCustomer(e.target.value)}
          />
        )}

        {/* 2) เมนู */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            className="input min-w-48 flex-1"
            placeholder="ค้นหาเมนู"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {[{ id: 'all', name: 'ทั้งหมด' }, ...categories].map((c) => (
            <button
              key={c.id}
              onClick={() => setCategory(c.id)}
              className={`rounded-full border px-3.5 py-1.5 text-sm transition ${category === c.id ? 'border-gray-900 bg-gray-900 text-white' : 'bg-white text-gray-600 hover:border-gray-300'}`}
            >
              {c.name}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
          {visible.map((item) => {
            const qty = cart[item.id]?.quantity ?? 0
            return (
              <button
                key={item.id}
                disabled={!item.is_available}
                onClick={() => change(item, 1)}
                className={`relative min-h-20 rounded-xl border-2 p-3 text-left shadow-xs transition active:scale-[.98] ${item.is_available ? (qty > 0 ? 'border-brand-400 bg-brand-50' : 'border-transparent bg-white hover:border-brand-300') : 'cursor-not-allowed border-transparent bg-gray-100 text-gray-400'}`}
              >
                <div className="pr-6 font-medium leading-snug">{item.name}</div>
                <div className={`mt-1 text-sm ${item.is_available ? 'font-semibold text-brand-600' : ''}`}>{item.is_available ? baht(item.price) : 'หมด'}</div>
                {qty > 0 && (
                  <span className="absolute right-2 top-2 grid h-6 min-w-6 place-items-center rounded-full bg-brand-500 px-1.5 text-xs font-bold text-white shadow-sm">{qty}</span>
                )}
              </button>
            )
          })}
          {visible.length === 0 && <p className="empty col-span-full">ไม่พบเมนู</p>}
        </div>
      </div>

      {/* 3) ตะกร้า + ส่งเข้าครัว */}
      <aside className="card h-fit p-5 lg:sticky lg:top-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">{target ?? 'เลือกโต๊ะก่อน'}</h2>
          {count > 0 && <span className="badge badge-brand">{count} รายการ</span>}
        </div>
        {lines.length === 0 ? (
          <p className="empty py-8">แตะเมนูเพื่อเพิ่มรายการ</p>
        ) : (
          <ul className="divide-y text-sm">
            {lines.map((l) => (
              <li key={l.item.id} className="py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex-1 font-medium">{l.item.name}</span>
                  <button className="grid h-8 w-8 place-items-center rounded-full border bg-white text-gray-600 hover:bg-gray-50" onClick={() => change(l.item, -1)} aria-label="ลด">−</button>
                  <span className="w-6 text-center font-semibold tabular-nums">{l.quantity}</span>
                  <button className="grid h-8 w-8 place-items-center rounded-full border bg-white text-gray-600 hover:bg-gray-50" onClick={() => change(l.item, 1)} aria-label="เพิ่ม">+</button>
                  <span className="w-16 text-right tabular-nums">{baht(l.quantity * l.item.price)}</span>
                </div>
                <input
                  className="input mt-1.5 w-full py-1.5 text-xs"
                  maxLength={200}
                  placeholder="หมายเหตุ เช่น ไม่เผ็ด ไม่ใส่ผัก"
                  value={l.note}
                  onChange={(e) => setNote(l.item.id, e.target.value)}
                />
              </li>
            ))}
          </ul>
        )}
        <input
          className="input mt-3 w-full"
          maxLength={200}
          placeholder="หมายเหตุถึงครัว (ทั้งออเดอร์)"
          value={orderNote}
          onChange={(e) => setOrderNote(e.target.value)}
        />
        {lines.length > 0 && <PromoPicker promos={livePromos} lines={promoLines} selection={promoSel} />}
        {discount > 0 && (
          <div className="mt-3 flex justify-between text-sm text-gray-500">
            <span>ก่อนลด</span>
            <span className="tabular-nums">{baht(total)}</span>
          </div>
        )}
        {discount > 0 && (
          <div className="flex justify-between text-sm font-medium text-emerald-700">
            <span>ส่วนลดรวม</span>
            <span className="tabular-nums">−{baht(discount)}</span>
          </div>
        )}
        <div className="mt-4 flex items-baseline justify-between border-t pt-4">
          <span className="text-sm text-gray-500">ยอดรวม {count} รายการ</span>
          <span className="text-2xl font-bold text-gray-900 tabular-nums">{baht(total - discount)}</span>
        </div>
        <button
          className="btn btn-primary btn-lg mt-4 w-full"
          disabled={!ready}
          onClick={() => void send()}
        >
          {sending ? 'กำลังส่ง...' : 'ส่งเข้าครัว'}
        </button>
        {lines.length > 0 && (
          <button className="link-muted mt-3 block w-full text-center" onClick={() => setCart({})}>
            ล้างรายการ
          </button>
        )}
        {message && (
          <p className={`${message.ok ? 'alert-success' : 'alert-error'} mt-4 mb-0`}>{message.text}</p>
        )}

        {tableOrders.length > 0 && (
          <div className="mt-5 border-t pt-4 text-sm">
            <h3 className="mb-2 font-semibold text-gray-900">ออเดอร์ของโต๊ะนี้ที่ยังไม่ชำระ</h3>
            <ul className="space-y-1">
              {tableOrders.map((o) => (
                <li key={o.id} className="flex justify-between text-gray-600">
                  <span>
                    {new Date(o.created_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} · {orderLabel(o)}
                  </span>
                  <span>
                    {STATUS_LABEL[o.status]} · {baht(Number(o.total))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  )
}

export default function Pos() {
  return <RequireRole roles={rolesFor('/pos')}>{(ctx) => <Board restaurantId={ctx.restaurantId} />}</RequireRole>
}
