import { translateUi } from "../lib/uiText"
import Modal from '../components/Modal'
import LoadingState from '../components/LoadingState'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { rolesFor } from '../lib/roles'
import { baht, kg, orderLabel } from '../lib/format'
import { useOrders } from '../lib/useOrders'
import RequireRole from '../components/RequireRole'
import PromoPicker, { usePromoSelection, usePromotions } from '../components/PromoPicker'
import Icon from '../components/Icon'
import { mediaUrl } from '../lib/media'
import TaxShiftBar from '../components/TaxShiftBar'
import { useCurrentShift } from '../components/ShiftModal'
import { useTaxSetup } from '../lib/tax'
import { getSession } from '../lib/session'
import { queueOrder, sendQueuedOrder } from '../lib/orderQueue'
import type { CartLine, MenuCategory, MenuItem, OrderStatus, OrderType } from '../lib/types'
import { useCachedState } from '../lib/useCachedState'

// หน้ารับออเดอร์ของพนักงาน: เลือกโต๊ะ/กลับบ้าน → เลือกเมนู → ส่งเข้าครัว
// ราคาและเมนูที่หมดตรวจซ้ำในฐานข้อมูล (staff_place_order) เสมอ

interface DiningTable {
  id: string
  label: string
}

const OPEN: OrderStatus[] = ['received', 'preparing', 'ready', 'served']

// ราคาของบรรทัด: ของชั่งขาย = ราคาต่อ กก. x น้ำหนัก (ฐานข้อมูลคิดซ้ำเองตอนส่ง)
const lineAmount = (l: CartLine) => {
  const extra = (l.item.option_choices ?? []).filter((o) => l.selected_option_ids?.includes(o.id)).reduce((s, o) => s + Number(o.price), 0)
  return l.weight_g ? Math.round(l.item.price * l.weight_g / 10) / 100 + extra : l.quantity * (l.item.price + extra)
}
const STATUS_LABEL: Partial<Record<OrderStatus, string>> = {
  received: 'รอครัว',
  preparing: 'กำลังทำ',
  ready: 'พร้อมเสิร์ฟ',
  served: 'เสิร์ฟแล้ว',
}

function Board({ restaurantId }: { restaurantId: string }) {
  const [categories, setCategories, categoriesLoaded] = useCachedState<MenuCategory[]>(`menu.categories:${restaurantId}`, [])
  const [items, setItems, itemsLoaded] = useCachedState<MenuItem[]>(`pos.items:${restaurantId}`, [])
  const [tables, setTables, tablesLoaded] = useCachedState<DiningTable[]>(`menu.tables:${restaurantId}`, [])
  const [images, setImages] = useState<Record<string, string>>({})
  const [loadError, setLoadError] = useState<string | null>(null)

  const [orderType, setOrderType] = useState<OrderType>('dine_in')
  const [tableId, setTableId] = useState<string | null>(null)
  const [customer, setCustomer] = useState('')
  const [category, setCategory] = useState<string | 'all'>('all')
  const [search, setSearch] = useState('')
  const [cart, setCart] = useState<Record<string, CartLine>>({})
  const [weighing, setWeighing] = useState<MenuItem | null>(null)
  const [weightKg, setWeightKg] = useState('')
  const [orderNote, setOrderNote] = useState('')
  const submitLock = useRef(false)
  const [sending, setSending] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const { orders, loaded: ordersLoaded, error: ordersError } = useOrders(restaurantId, OPEN)
  const promotions = usePromotions(restaurantId)
  const tax = useTaxSetup(restaurantId)
  const current = useCurrentShift(restaurantId)

  const loadMenu = useCallback(async () => {
    const cacheKey = `plato.menu:${getSession()?.user.id}:${restaurantId}`
    if (!navigator.onLine) {
      try {
        const snapshot = JSON.parse(localStorage.getItem(cacheKey) ?? 'null')
        if (snapshot && Date.now() - snapshot.savedAt < 86_400_000) {
          setCategories(snapshot.categories); setItems(snapshot.items); setTables(snapshot.tables)
          setLoadError('ใช้เมนูที่บันทึกไว้ชั่วคราว ราคาและสถานะขายจะตรวจอีกครั้งตอนส่งเข้าครัว')
          return
        }
      } catch { /* No usable offline snapshot. */ }
      setLoadError('ไม่มีเมนูออฟไลน์ที่ยังใช้ได้ กรุณาเชื่อมต่อเพื่อโหลดเมนู')
      return
    }
    const signal = AbortSignal.timeout(10000)
    const [c, m, t, media] = await Promise.all([
      supabase.from('menu_categories').select('id,name,sort_order').eq('restaurant_id', restaurantId).order('sort_order').abortSignal(signal),
      supabase.from('menu_items').select('id,category_id,name,price,is_available,sold_by_weight,option_choices').eq('restaurant_id', restaurantId).order('name').abortSignal(signal),
      supabase.from('dining_tables').select('id,label').eq('restaurant_id', restaurantId).order('label').abortSignal(signal),
      supabase.from('display_media').select('menu_item_id,storage_path,url').eq('restaurant_id', restaurantId).eq('kind', 'image').eq('is_active', true).order('sort_order').abortSignal(signal),
    ])
    if (c.error || m.error || t.error) {
      setLoadError('โหลดเมนูหรือโต๊ะไม่สำเร็จ')
      return
    }
    if (!media.error) {
      const urls: Record<string, string> = {}
      for (const row of media.data ?? []) if (row.menu_item_id && !urls[row.menu_item_id]) urls[row.menu_item_id] = row.storage_path ? mediaUrl(row.storage_path) : row.url ?? ''
      setImages(urls)
    }
    setLoadError(null)
    setCategories(c.data as MenuCategory[])
    setItems((m.data as MenuItem[]).map((x) => ({ ...x, price: Number(x.price) })))
    setTables(t.data as DiningTable[])
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ savedAt: Date.now(), categories: c.data, items: m.data, tables: t.data }))
    } catch { /* Online orders remain usable when browser storage is full. */ }
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

  const entries = Object.entries(cart)
  const lines = entries.map(([, l]) => l)
  const count = lines.reduce((s, l) => s + l.quantity, 0)
  const total = lines.reduce((s, l) => s + lineAmount(l), 0)
  const openByTable = useMemo(() => {
    const m = new Map<string, number>()
    for (const o of orders) if (o.table_id) m.set(o.table_id, (m.get(o.table_id) ?? 0) + 1)
    return m
  }, [orders])
  const tableOrders = orders.filter((o) => orderType === 'dine_in' && o.table_id === tableId)

  function change(item: MenuItem, delta: number) {
    if (submitLock.current) return
    if (!cart[item.id] && Object.keys(cart).length >= 50) { setMessage({ ok: false, text: 'ส่งได้ครั้งละ 50 รายการ กรุณาส่งออเดอร์นี้ก่อน' }); return }
    setCart((prev) => {
      const cur = prev[item.id]
      const qty = (cur?.quantity ?? 0) + delta
      const next = { ...prev }
      if (qty <= 0) delete next[item.id]
      else next[item.id] = { item, quantity: Math.min(qty, 50), note: cur?.note ?? '', selected_option_ids: cur?.selected_option_ids ?? [] }
      return next
    })
  }

  // ของชั่งขาย: ชั่งแล้วกรอกน้ำหนัก 1 ครั้ง = 1 บรรทัด
  function addWeighed() {
    if (submitLock.current || Object.keys(cart).length >= 50) { setMessage({ ok: false, text: 'ส่งได้ครั้งละ 50 รายการ' }); return }
    const grams = Math.round(Number(weightKg) * 10000) / 10
    if (!weighing || !(grams > 0) || grams > 100000) return
    const item = weighing
    setCart((prev) => ({ ...prev, [`w:${item.id}:${Date.now()}`]: { item, quantity: 1, note: '', weight_g: grams } }))
    setWeighing(null)
    setWeightKg('')
  }

  function removeLine(key: string) {
    if (submitLock.current) return
    setCart((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  function setNote(id: string, note: string) {
    if (submitLock.current) return
    setCart((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], note } } : prev))
  }

  const target =
    orderType === 'takeaway' ? (customer.trim() ? `${translateUi('กลับบ้าน')} / ${customer.trim()}` : translateUi('กลับบ้าน')) : tables.find((t) => t.id === tableId)?.label
  // โปรที่ใช้ได้ตอนนี้ เลือกให้อัตโนมัติ (ใช้หลายโปรได้ถ้าไม่ชนกัน) พนักงานติ๊กเปลี่ยนได้
  const livePromos = promotions.all.filter((p) => promotions.liveIds.has(p.id))
  const promoLines = lines.map((l) => ({ menuItemId: l.item.id, amount: lineAmount(l) }))
  const promoSel = usePromoSelection(livePromos, promotions.itemsOf, promoLines)
  const discount = promoSel.discounts.total
  const ready = count > 0 && (orderType === 'takeaway' || tableId !== null) && !sending && (promotions.ready || !navigator.onLine)

  async function send() {
    if (!ready || submitLock.current || lines.length > 50) return
    submitLock.current = true
    setSending(true)
    setMessage(null)
    try {
    const userId = getSession()?.user.id
    if (!userId) throw new Error('session_expired')
    const queued = await queueOrder(userId, restaurantId, {
      p_restaurant_id: restaurantId,
      p_items: lines.map((l) => ({ menu_item_id: l.item.id, quantity: l.quantity, weight_g: l.weight_g ?? null, note: l.note.trim() || null, selected_option_ids: l.selected_option_ids ?? [] })),
      p_table_id: orderType === 'dine_in' ? tableId : null,
      p_order_type: orderType,
      p_customer_label: orderType === 'takeaway' ? customer.trim() || null : null,
      p_note: orderNote.trim() || null,
      p_promotion_ids: promotions.ready ? promoSel.selectedIds : [],
    })
    // Once persisted, retries use the same client_ref, including after a lost response.
    setCart({}); setOrderNote('')
    if (orderType === 'takeaway') setCustomer('')
    if (!navigator.onLine) {
      setMessage({ ok: true, text: 'เก็บในคิวออฟไลน์แล้ว ยังไม่เข้าครัว กดส่งรายการที่ค้างเมื่อเชื่อมต่ออีกครั้ง' })
      return
    }
    let orderId: string
    try { orderId = await sendQueuedOrder(queued) }
    catch {
      setMessage({ ok: false, text: 'ยังยืนยันการส่งไม่ได้ รายการเก็บในคิวแล้ว ให้ลองส่งจากคิวเดิมเพื่อป้องกันออเดอร์ซ้ำ' })
      return
    }
    // ยอดจริงจากฐานข้อมูล (หลังหักส่วนลด)
    const { data: saved } = await supabase.from('orders').select('total,discount_total').eq('id', orderId as string).single()
    const net = saved ? Number(saved.total) : total - discount
    const disc = saved ? Number(saved.discount_total) : discount
    setMessage({
      ok: true,
      text: `ส่งออเดอร์ ${target} เข้าครัวแล้ว (${count} รายการ / ${baht(net)}${disc > 0 ? ` ลด ${baht(disc)}` : ''})`,
    })
    promoSel.resetAuto()
    void promotions.reload() // จำนวนครั้งที่เหลือเปลี่ยน
    setCart({})
    setOrderNote('')
    if (orderType === 'takeaway') setCustomer('')
    } catch {
      setMessage({ ok: false, text: 'บันทึกคิวไม่สำเร็จ รายการยังอยู่ในตะกร้า กรุณาตรวจพื้นที่จัดเก็บและเข้าสู่ระบบใหม่' })
    } finally {
      submitLock.current = false
      setSending(false)
    }
  }

  return (
    <div className="page grid max-w-7xl gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div>
        <div className="mb-4 toolbar justify-between">
          <h1 className="page-title">{translateUi("รับออเดอร์")}</h1>
          <TaxShiftBar restaurantId={restaurantId} setup={tax} current={current} />
        </div>
        {loadError && <p role="alert" className="alert-error">{loadError} <button className="underline" onClick={() => void loadMenu()}>{translateUi('ลองใหม่')}</button></p>}
        {ordersError && <p role="alert" className="alert-warn">{translateUi('โหลดสถานะโต๊ะไม่สำเร็จ')}: {ordersError}</p>}

        {/* 1) ทานที่ร้าน / กลับบ้าน */}
        <div className="mb-4 inline-flex rounded-xl border bg-white p-1 shadow-xs">
          {(['dine_in', 'takeaway'] as OrderType[]).map((t) => (
            <button
              key={t}
              disabled={sending}
              onClick={() => { if (!submitLock.current) setOrderType(t) }}
              className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${orderType === t ? 'bg-brand-500 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              <Icon name={t === 'dine_in' ? 'table' : 'bag'} className="h-4 w-4" />
              {translateUi(t === 'dine_in' ? 'ทานที่ร้าน' : 'กลับบ้าน')}
            </button>
          ))}
        </div>

        {orderType === 'dine_in' ? (
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4 2xl:grid-cols-5">
            {tables.map((t) => {
              const open = openByTable.get(t.id) ?? 0
              return (
                <button
                  key={t.id}
                  disabled={sending}
                  onClick={() => { if (!submitLock.current) setTableId(t.id) }}
                  className={`rounded-xl border-2 bg-white px-2 py-3 text-sm font-medium shadow-xs transition ${tableId === t.id ? 'border-brand-500 bg-brand-50 text-brand-700' : open > 0 ? 'border-blue-200 hover:border-blue-300' : 'border-transparent hover:border-gray-300'}`}
                >
                  {t.label}
                  {!ordersLoaded && !ordersError && <span className="block text-xs text-gray-600">{translateUi('กำลังตรวจสถานะ')}</span>}
                  {open > 0 && <div className="mt-0.5 text-xs font-normal text-blue-600">{"" + translateUi("มี") + " "}{open}{" " + translateUi("ออเดอร์") + ""}</div>}
                </button>
              )
            })}
            {tablesLoaded && tables.length === 0 && <p className="empty col-span-full">{translateUi("ยังไม่มีโต๊ะในระบบ")}</p>}
          </div>
        ) : (
          <input
            className="input mb-5 w-full py-2.5"
            maxLength={50}
            placeholder={translateUi("ชื่อหรือเบอร์ลูกค้า (ไม่บังคับ)")}
            value={customer}
            disabled={sending}
            onChange={(e) => setCustomer(e.target.value)}
          />
        )}

        {/* 2) เมนู */}
        <div className="mb-3 toolbar">
          <input
            className="input min-w-48 flex-1"
            placeholder={translateUi("ค้นหาเมนู")}
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
            const qty = item.sold_by_weight ? lines.filter((l) => l.item.id === item.id).length : (cart[item.id]?.quantity ?? 0)
            return (
              <button
                key={item.id}
                disabled={!item.is_available}
                onClick={() => (item.sold_by_weight ? setWeighing(item) : change(item, 1))}
                className={`relative min-h-20 rounded-xl border-2 p-3 text-left shadow-xs transition active:scale-[.98] ${item.is_available ? (qty > 0 ? 'border-brand-400 bg-brand-50' : 'border-transparent bg-white hover:border-brand-300') : 'cursor-not-allowed border-transparent bg-gray-100 text-gray-400'}`}
              >
                {images[item.id] && <img src={images[item.id]} alt="" loading="lazy" className="mb-2 h-24 w-full rounded-lg object-cover" />}
                <div className="pr-6 font-medium leading-snug">{item.name}</div>
                <div className={`mt-1 text-sm ${item.is_available ? 'font-semibold text-brand-600' : ''}`}>{item.is_available ? `${baht(item.price)}${item.sold_by_weight ? '/กก.' : ''}` : translateUi('หมด')}</div>
                {item.sold_by_weight && item.is_available && <div className="hint">{translateUi("ชั่งน้ำหนัก")}</div>}
                {qty > 0 && (
                  <span className="absolute right-2 top-2 grid h-6 min-w-6 place-items-center rounded-full bg-brand-500 px-1.5 text-xs font-bold text-white shadow-sm">{qty}</span>
                )}
              </button>
            )
          })}
          {!(categoriesLoaded && itemsLoaded && tablesLoaded) && !loadError && <div className="col-span-full"><LoadingState label={translateUi('กำลังโหลดเมนูและโต๊ะ')} /></div>}
          {itemsLoaded && visible.length === 0 && <p className="empty col-span-full">{translateUi("ไม่พบเมนู")}</p>}
        </div>
      </div>

      {/* 3) ตะกร้า + ส่งเข้าครัว */}
      <aside className="card h-fit min-w-0 p-5 xl:sticky xl:top-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg strong-text">{target ?? translateUi('เลือกโต๊ะก่อน')}</h2>
          {count > 0 && <span className="badge badge-brand">{count}{" " + translateUi("รายการ") + ""}</span>}
        </div>
        {lines.length === 0 ? (
          <p className="empty py-8">{translateUi("แตะเมนูเพื่อเพิ่มรายการ")}</p>
        ) : (
          <ul className="divide-y text-sm">
            {entries.map(([key, l]) => (
              <li key={key} className="py-2">
                <div className="row-between">
                  <span className="flex-1 font-medium">
                    {l.item.name}
                    {l.weight_g && (
                      <span className="block hint font-normal">
                        {kg(l.weight_g)} × {baht(l.item.price)}{"" + translateUi("/กก.") + " "}</span>
                    )}
                  </span>
                  {l.weight_g ? (
                    <button className="link-danger text-xs" onClick={() => removeLine(key)}>{translateUi("เอาออก")}</button>
                  ) : (
                    <>
                      <button className="grid h-8 w-8 place-items-center rounded-full border bg-white text-gray-600 hover:bg-gray-50" onClick={() => change(l.item, -1)} aria-label={translateUi("ลด")}>−</button>
                      <span className="w-6 text-center font-semibold tabular-nums">{l.quantity}</span>
                      <button className="grid h-8 w-8 place-items-center rounded-full border bg-white text-gray-600 hover:bg-gray-50" onClick={() => change(l.item, 1)} aria-label={translateUi("เพิ่ม")}>+</button>
                    </>
                  )}
                  <span className="w-16 num">{baht(lineAmount(l))}</span>
                </div>
                {Boolean(l.item.option_choices?.length) && <fieldset disabled={sending} className="mt-2 space-y-1"><legend className="hint">{translateUi("ตัวเลือกเพิ่มเติม")}</legend>{l.item.option_choices?.map((option) => <label key={option.id} className="flex gap-2"><input type="checkbox" checked={l.selected_option_ids?.includes(option.id) ?? false} onChange={(e) => { if (submitLock.current) return; const checked = e.target.checked; setCart((prev) => ({ ...prev, [key]: { ...prev[key], selected_option_ids: checked ? [...(prev[key].selected_option_ids ?? []), option.id] : (prev[key].selected_option_ids ?? []).filter((id) => id !== option.id) } })) }} />{option.name} (+{baht(Number(option.price))})</label>)}</fieldset>}
                <input
                  className="input mt-1.5 w-full py-1.5 text-xs"
                  maxLength={200}
                  placeholder={translateUi("หมายเหตุ เช่น ไม่เผ็ด ไม่ใส่ผัก")}
                  value={l.note}
                  onChange={(e) => setNote(key, e.target.value)}
                />
              </li>
            ))}
          </ul>
        )}
        <input
          className="input mt-3 w-full"
          maxLength={200}
          placeholder={translateUi("หมายเหตุถึงครัว (ทั้งออเดอร์)")}
          value={orderNote}
          disabled={sending}
          onChange={(e) => setOrderNote(e.target.value)}
        />
        {lines.length > 0 && <PromoPicker restaurantId={restaurantId} promos={livePromos} lines={promoLines} selection={promoSel} />}
        {discount > 0 && (
          <div className="mt-3 flex justify-between text-sm text-gray-500">
            <span>{translateUi("ก่อนลด")}</span>
            <span className="tabular-nums">{baht(total)}</span>
          </div>
        )}
        {discount > 0 && (
          <div className="flex justify-between text-sm font-medium text-emerald-700">
            <span>{translateUi("ส่วนลดรวม")}</span>
            <span className="tabular-nums">−{baht(discount)}</span>
          </div>
        )}
        <div className="mt-4 flex items-baseline justify-between border-t pt-4">
          <span className="text-sm text-gray-500">{"" + translateUi("ยอดรวม") + " "}{count}{" " + translateUi("รายการ") + ""}</span>
          <span className="text-2xl font-bold text-gray-900 tabular-nums">{baht(total - discount)}</span>
        </div>
        <button
          className="btn btn-primary btn-lg mt-4 w-full"
          disabled={!ready}
          onClick={() => void send()}
        >
          {translateUi(sending ? 'กำลังส่ง...' : 'ส่งเข้าครัว')}
        </button>
        {lines.length > 0 && (
          <button className="link-muted mt-3 block w-full text-center" disabled={sending} onClick={() => setCart({})}>{"" + translateUi("ล้างรายการ") + " "}</button>
        )}
        {message && (
          <p role={message.ok ? 'status' : 'alert'} className={`${message.ok ? 'alert-success' : 'alert-error'} mt-4 mb-0`}>{message.text}</p>
        )}

        {tableOrders.length > 0 && (
          <div className="mt-5 border-t pt-4 text-sm">
            <h3 className="mb-2 strong-text">{translateUi("ออเดอร์ของโต๊ะนี้ที่ยังไม่ชำระ")}</h3>
            <ul className="space-y-1">
              {tableOrders.map((o) => (
                <li key={o.id} className="flex justify-between text-gray-600">
                  <span>
                    {new Date(o.created_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} / {orderLabel(o)}
                  </span>
                  <span>
                    {translateUi(STATUS_LABEL[o.status] ?? '')} / {baht(Number(o.total))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>

      {weighing && (
        <Modal label={weighing.name} onClose={() => setWeighing(null)} className="max-w-sm p-0">
          <form
            className="card w-full max-w-sm space-y-4 p-5"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault()
              addWeighed()
            }}
          >
            <div>
              <h2 className="title-lg">{weighing.name}</h2>
              <p className="text-sm text-gray-500">{"" + translateUi("ราคา") + " "}{baht(weighing.price)}{" " + translateUi("ต่อ กก. / ชั่งแล้วกรอกน้ำหนักจริง") + ""}</p>
            </div>
            <label className="block">
              <span className="label">{translateUi("น้ำหนัก (กก.)")}</span>
              <input
                className="input w-full py-3 num text-2xl font-semibold"
                type="number"
                inputMode="decimal"
                min="0.001"
                max="100"
                step="0.001"
                placeholder="0.000"
                autoFocus
                value={weightKg}
                onChange={(e) => setWeightKg(e.target.value)}
              />
            </label>
            <div className="flex items-baseline justify-between border-t pt-3">
              <span className="text-sm text-gray-500">{translateUi("ราคา")}</span>
              <span className="text-2xl font-bold text-gray-900 tabular-nums">
                {Number(weightKg) > 0 ? baht(Math.round(weighing.price * Number(weightKg) * 100) / 100) : '-'}
              </span>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-secondary" onClick={() => setWeighing(null)}>{translateUi("ยกเลิก")}</button>
              <button className="btn btn-primary" disabled={!(Number(weightKg) > 0 && Number(weightKg) <= 100)}>{translateUi("เพิ่มรายการ")}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}

export default function Pos() {
  return <RequireRole roles={rolesFor('/pos')}>{(ctx) => <Board restaurantId={ctx.restaurantId} />}</RequireRole>
}
