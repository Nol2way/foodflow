import { translateUi } from "../lib/uiText"
import { useEffect } from 'react'
import type { KitchenOrder } from '../lib/types'
import { itemQty, orderLabel } from '../lib/format'
import Modal from './Modal'
export default function KitchenTicket({ orders, auto, onClose }: { orders: KitchenOrder[]; auto?: boolean; onClose: () => void }) {
  useEffect(() => { if (!auto) return; const timer = setTimeout(() => window.print(), 250); return () => clearTimeout(timer) }, [auto, orders])
  return <Modal label={translateUi("ใบงานครัว 80 มม.")} onClose={onClose}><div className="no-print toolbar"><button className="btn btn-primary" onClick={() => window.print()}>{translateUi("พิมพ์ 80 มม.")}</button><button className="btn btn-secondary" onClick={onClose}>{translateUi("ปิด")}</button></div><div className="print-area bg-white text-black" style={{ width: '72mm', maxWidth: '100%' }}>{orders.map((order) => <section key={order.id} style={{ breakAfter: 'page' }} className="py-3"><h1 className="text-2xl font-bold">{orderLabel(order)}</h1><p>{new Date(order.created_at).toLocaleString('th-TH')}</p><p className="text-xs">{order.id}</p><hr className="my-2" />{order.order_items.map((it) => <div key={it.id} className="mb-3"><p className="text-xl font-bold">{itemQty(it)} {it.menu_items?.name}</p>{it.options_snapshot?.map((o) => <p key={o.id}>+ {o.name}</p>)}{it.note && <p className="font-bold">{"" + translateUi("หมายเหตุ:") + " "}{it.note}</p>}</div>)}{order.note && <p className="border-t pt-2 font-bold">{"" + translateUi("หมายเหตุทั้งออเดอร์:") + " "}{order.note}</p>}</section>)}</div></Modal>
}
