import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useOrders } from '../lib/useOrders'
import { rolesFor } from '../lib/roles'
import { baht, orderLabel, itemQty } from '../lib/format'
import { promotionError } from '../lib/promotions'
import RequireRole from '../components/RequireRole'
import Icon from '../components/Icon'
import PromoPicker, { usePromoSelection, usePromotions } from '../components/PromoPicker'
import PromptPayQR from '../components/PromptPayQR'
import Receipt from '../components/Receipt'
import MemberBox from '../components/MemberBox'
import { useShopSettings } from '../lib/shop'
import { pointsDiscount } from '../lib/loyalty'
import type { KitchenOrder, Member, OrderStatus, PaymentMethod, ShopSettings } from '../lib/types'

// หน้าร้าน: รวมบิลตามโต๊ะ (หลายออเดอร์ต่อโต๊ะได้) รับชำระเมื่อเสิร์ฟครบ และยกเลิกออเดอร์ที่ครัวยังไม่เริ่ม
// โปรโมชันเลือกให้อัตโนมัติทั้งบิล (ใช้หลายโปรได้ถ้าไม่ชนกัน) ฐานข้อมูลคิดส่วนลดจริงตอนรับชำระ (counter_pay_bill)
// 0017: เลือกวิธีชำระ (พร้อมเพย์แสดง QR ใส่ยอด) · สมาชิกสะสม/แลกแต้ม · จ่ายแล้วเปิดใบเสร็จพิมพ์ได้
const METHODS: { key: PaymentMethod; label: string }[] = [
  { key: 'cash', label: 'เงินสด' },
  { key: 'promptpay', label: 'พร้อมเพย์' },
  { key: 'card', label: 'บัตร' },
  { key: 'other', label: 'อื่นๆ' },
]
const OPEN: OrderStatus[] = ['received', 'preparing', 'ready', 'served']
const STATUS_LABEL: Partial<Record<OrderStatus, string>> = {
  received: 'รอครัว',
  preparing: 'กำลังทำ',
  ready: 'พร้อมเสิร์ฟ',
  served: 'เสิร์ฟแล้ว',
}
const STATUS_BADGE: Partial<Record<OrderStatus, string>> = {
  received: 'badge-blue',
  preparing: 'badge-amber',
  ready: 'badge-brand',
  served: 'badge-green',
}

interface Bill {
  key: string
  label: string
  orders: KitchenOrder[]
  total: number
  allServed: boolean
}

function Board({ restaurantId }: { restaurantId: string }) {
  const { orders, error, setError, reload } = useOrders(restaurantId, OPEN)
  const promotions = usePromotions(restaurantId)
  const shop = useShopSettings(restaurantId)
  const [receiptIds, setReceiptIds] = useState<string[] | null>(null)

  const bills = useMemo(() => {
    const map = new Map<string, Bill>()
    for (const o of orders) {
      // ทานที่ร้าน: รวมตามโต๊ะ · กลับบ้าน: แยกบิลต่อออเดอร์
      const key = o.order_type === 'dine_in' && o.table_id ? `t:${o.table_id}` : `o:${o.id}`
      const b = map.get(key) ?? { key, label: orderLabel(o), orders: [], total: 0, allServed: true }
      b.orders.push(o)
      b.total += Number(o.total)
      b.allServed &&= o.status === 'served'
      map.set(key, b)
    }
    return [...map.values()].sort((a, b) => Number(b.allServed) - Number(a.allServed) || a.label.localeCompare(b.label, 'th'))
  }, [orders])

  async function cancel(o: KitchenOrder) {
    if (!window.confirm('ยืนยันยกเลิกออเดอร์นี้?')) return
    const { error: err } = await supabase.from('orders').update({ status: 'cancelled' }).eq('id', o.id).eq('status', 'received')
    if (err) setError(err.message)
    void reload()
  }

  return (
    <div className="page-narrow">
      <div className="page-header">
        <h1 className="page-title">รับชำระเงิน</h1>
        <Link to="/pos" className="btn btn-primary">
          <Icon name="plus" className="h-4 w-4" />
          รับออเดอร์
        </Link>
      </div>
      {error && <p className="alert-error">{error}</p>}

      <div className="space-y-3">
        {bills.map((b) => (
          <BillCard
            key={b.key}
            bill={b}
            restaurantId={restaurantId}
            promotions={promotions}
            settings={shop.settings}
            onCancel={(o) => void cancel(o)}
            onPaid={(ids) => {
              if (ids) setReceiptIds(ids)
              void reload()
              void promotions.reload()
            }}
            onError={setError}
          />
        ))}
        {bills.length === 0 && <p className="empty">ไม่มีบิลค้างชำระ</p>}
      </div>
      {receiptIds && <Receipt orderIds={receiptIds} onClose={() => setReceiptIds(null)} />}
    </div>
  )
}

function BillCard({
  bill: b,
  restaurantId,
  promotions,
  settings,
  onCancel,
  onPaid,
  onError,
}: {
  bill: Bill
  restaurantId: string
  promotions: ReturnType<typeof usePromotions>
  settings: ShopSettings | null
  onCancel: (o: KitchenOrder) => void
  onPaid: (orderIds?: string[]) => void
  onError: (message: string) => void
}) {
  const [paying, setPaying] = useState(false)
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [member, setMember] = useState<Member | null>(null)
  const [redeem, setRedeem] = useState(0)
  const [showQR, setShowQR] = useState(false)
  const loyalty = settings?.loyalty_enabled ? settings : null
  const lines = b.orders.flatMap((o) => o.order_items.map((it) => ({ menuItemId: it.menu_item_id, amount: it.quantity * Number(it.unit_price) })))
  const subtotal = lines.reduce((s, l) => s + l.amount, 0)
  // โปรที่ใช้ได้ตอนนี้ + โปรที่บิลนี้ได้ไปแล้วตอนรับออเดอร์ (ใช้ต่อได้แม้หมดเวลา/ครบจำนวน)
  const applied = new Set(b.orders.flatMap((o) => o.order_promotions.map((x) => x.promotion_id)))
  const promos = promotions.all.filter((p) => promotions.liveIds.has(p.id) || applied.has(p.id))
  const selection = usePromoSelection(promos, promotions.itemsOf, lines)
  const discount = selection.discounts.total
  const afterPromo = Math.max(0, subtotal - discount)
  const usedPoints = loyalty && member && redeem >= loyalty.loyalty_min_redeem ? redeem : 0
  const fromPoints = loyalty ? pointsDiscount(loyalty, usedPoints) : 0
  const net = Math.max(0, afterPromo - fromPoints)
  const canPromptPay = Boolean(settings?.promptpay_id)

  function start() {
    if (method === 'promptpay') return setShowQR(true)
    if (window.confirm(`รับชำระ ${b.label} ยอด ${baht(net)} (${METHODS.find((m) => m.key === method)?.label})?`)) void pay()
  }

  async function pay() {
    setPaying(true)
    const ids = b.orders.map((o) => o.id)
    // ส่งพารามิเตอร์ใหม่เฉพาะเมื่อใช้ (ร้านที่ยังไม่รัน 0017 ยังรับชำระแบบเดิมได้)
    const extra = settings ? { p_payment_method: method, p_member_id: member?.id ?? null, p_redeem_points: usedPoints } : {}
    const { error } = await supabase.rpc('counter_pay_bill', {
      p_restaurant_id: restaurantId,
      p_order_ids: ids,
      p_promotion_ids: selection.selectedIds,
      ...extra,
    })
    setPaying(false)
    setShowQR(false)
    if (error) {
      onError(promotionError(error.message))
      return onPaid()
    }
    onPaid(settings ? ids : undefined)
  }

  return (
    <article className={`card p-4 ${b.allServed ? 'border-emerald-300 ring-2 ring-emerald-50' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <strong className="text-lg text-gray-900">{b.label}</strong>
        <strong className="text-xl tabular-nums text-gray-900">{baht(net)}</strong>
      </div>
      {b.orders.map((o) => (
        <div key={o.id} className="mt-3 border-t pt-3 text-sm">
          <div className="mb-1 flex items-center justify-between text-xs text-gray-500">
            <span>
              {new Date(o.created_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}{' '}
              <span className={`badge ml-1 ${STATUS_BADGE[o.status] ?? 'badge-gray'}`}>{STATUS_LABEL[o.status]}</span>
            </span>
            {o.status === 'received' && (
              <button className="link-danger text-xs" onClick={() => onCancel(o)}>
                ยกเลิก
              </button>
            )}
          </div>
          <ul className="text-gray-700">
            {o.order_items.map((it) => (
              <li key={it.id} className={`flex justify-between gap-2 ${o.status === 'ready' && it.served_at ? 'text-gray-400 line-through' : ''}`}>
                <span>
                  {o.status === 'ready' && it.served_at && <span className="mr-1 text-emerald-600">✓</span>}
                  {itemQty(it)} {it.menu_items?.name ?? '-'}
                </span>
                <span className="tabular-nums text-gray-500">{baht(it.quantity * Number(it.unit_price))}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      <PromoPicker promos={promos} lines={lines} selection={selection} />

      {loyalty && (
        <MemberBox
          restaurantId={restaurantId}
          settings={loyalty}
          member={member}
          redeem={redeem}
          payable={afterPromo}
          onMember={setMember}
          onRedeem={setRedeem}
        />
      )}

      <div className="mt-3 space-y-0.5 text-sm">
        <div className="flex justify-between text-gray-500">
          <span>ยอดก่อนลด</span>
          <span className="tabular-nums">{baht(subtotal)}</span>
        </div>
        {discount > 0 && (
          <div className="flex justify-between font-medium text-emerald-700">
            <span>ส่วนลดรวม</span>
            <span className="tabular-nums">−{baht(discount)}</span>
          </div>
        )}
        {fromPoints > 0 && (
          <div className="flex justify-between font-medium text-violet-700">
            <span>แลก {usedPoints} แต้ม</span>
            <span className="tabular-nums">−{baht(fromPoints)}</span>
          </div>
        )}
        <div className="flex justify-between pt-1 text-base font-semibold text-gray-900">
          <span>ยอดชำระ</span>
          <span className="tabular-nums">{baht(net)}</span>
        </div>
      </div>

      {settings && b.allServed && (
        <div className="mt-4 grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="วิธีชำระ">
          {METHODS.map((m) => {
            const disabled = m.key === 'promptpay' && !canPromptPay
            return (
              <button
                key={m.key}
                type="button"
                role="radio"
                aria-checked={method === m.key}
                disabled={disabled}
                title={disabled ? 'ตั้งเลขพร้อมเพย์ที่หน้าตั้งค่าร้านก่อน' : undefined}
                onClick={() => setMethod(m.key)}
                className={`rounded-lg border px-2 py-2 text-sm font-medium transition disabled:opacity-40 ${
                  method === m.key ? 'border-brand-500 bg-brand-50 text-brand-700' : 'bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                {m.label}
              </button>
            )
          })}
        </div>
      )}

      <button className="btn btn-success mt-3 w-full py-3" disabled={!b.allServed || paying} onClick={start}>
        {paying ? 'กำลังบันทึก...' : !b.allServed ? 'รอเสิร์ฟให้ครบก่อนชำระ' : method === 'promptpay' ? `แสดง QR ${baht(net)}` : `รับชำระ ${baht(net)}`}
      </button>

      {showQR && settings?.promptpay_id && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="QR พร้อมเพย์">
          <div className="w-full max-w-xs rounded-2xl bg-white p-4 shadow-2xl">
            <div className="mb-3 text-center font-semibold text-gray-900">{b.label} · สแกนจ่ายด้วยแอปธนาคาร</div>
            <PromptPayQR id={settings.promptpay_id} amount={net} />
            <p className="mt-3 text-center text-xs text-gray-500">ตรวจยอดเงินเข้าในแอปธนาคารของร้านก่อนกดยืนยัน</p>
            <div className="mt-3 flex gap-2">
              <button className="btn btn-success flex-1" disabled={paying} onClick={() => void pay()}>
                {paying ? 'กำลังบันทึก...' : 'ได้รับเงินแล้ว'}
              </button>
              <button className="btn btn-secondary" disabled={paying} onClick={() => setShowQR(false)}>
                ยกเลิก
              </button>
            </div>
          </div>
        </div>
      )}
    </article>
  )
}

export default function Counter() {
  return <RequireRole roles={rolesFor('/counter')}>{(ctx) => <Board restaurantId={ctx.restaurantId} />}</RequireRole>
}
