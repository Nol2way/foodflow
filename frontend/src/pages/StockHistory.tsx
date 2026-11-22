import Modal from '../components/Modal'
import { useLocalPagination } from '../components/Pagination'
import { translateUi } from "../lib/uiText"
import { useEffect, useRef, useState } from 'react'
import RequireRole from '../components/RequireRole'
import { Empty, PageHead, StockNav } from '../components/stock/ui'
import { baht } from '../lib/format'
import { rolesFor, type Role } from '../lib/roles'
import { dateTime, daysAgoIso, errorText, stockApi, todayIso, useLoad, type Movement } from '../lib/stockApi'
import { fmtNum, MOVEMENT_LABEL, type MovementType } from '../lib/stockMath'

// ประวัติ ledger (stock_history ใน 0029) / เพิ่มได้อย่างเดียว แก้ไม่ได้ ผิดให้กลับรายการ
const BADGE: Record<MovementType, string> = {
  receive: 'badge-green',
  recipe_deduct: 'badge-gray',
  recipe_return: 'badge-blue',
  count_adjust: 'badge-brand',
  legacy: 'badge-gray',
}

function Board({ restaurantId, roles }: { restaurantId: string; roles: Role[] }) {
  const canReverse = roles.includes('owner') || roles.includes('manager')
  const ings = useLoad(() => stockApi.ingredients(restaurantId, true), [restaurantId], 'stock.ingredients.all')
  const [f, setF] = useState({ from: daysAgoIso(7), to: todayIso(), ingredient_id: '', actor_id: '', type: '' })
  const list = useLoad(() => stockApi.history(restaurantId, f), [restaurantId, f.from, f.to, f.ingredient_id, f.actor_id, f.type], 'stock.history')
  // ผู้ทำรายการที่เคยเห็นในช่วงนี้ (ตัวเลือกกรอง)
  const [actors, setActors] = useState<Map<string, string>>(new Map())
  const [reversing, setReversing] = useState<Movement | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const mutation = useRef(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    const rows = list.data?.movements ?? []
    setActors((prev) => {
      const next = new Map(prev)
      for (const m of rows) if (m.actor_id) next.set(m.actor_id, m.actor_name ?? 'ไม่ทราบชื่อ')
      return next.size === prev.size ? prev : next
    })
  }, [list.data])

  async function reverse() {
    if (!reversing || !reason.trim() || mutation.current || list.loading || list.error) return
    mutation.current = true
    setMsg(null)
    setBusy(true)
    try {
      await stockApi.reverse(restaurantId, reversing.id, reason.trim())
      setMsg({ ok: true, text: `กลับรายการ ${reversing.ingredient_name} แล้ว (รายการเดิมยังอยู่ในประวัติ)` })
      setReversing(null)
      setReason('')
      void list.reload()
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) })
    } finally {
      mutation.current = false
      setBusy(false)
    }
  }

  const rows = list.data?.movements ?? []
  const pagination = useLocalPagination(rows, JSON.stringify(f), translateUi('ประวัติสต็อก'))
  const set = (patch: Partial<typeof f>) => { setReversing(null); setReason(''); setF((x) => ({ ...x, ...patch })) }

  return (
    <div className="page">
      <PageHead title={translateUi("ประวัติสต็อก")} subtitle={translateUi("ทุกการเข้า-ออก: นำเข้า / ตัดตามสูตร / คืนจากออเดอร์ยกเลิก / ปรับจากการนับ (แก้ย้อนหลังไม่ได้)")} />
      <StockNav roles={roles} />
      {msg && <p className={msg.ok ? 'alert-success' : 'alert-error'}>{msg.text}</p>}
      {(list.error || ings.error) && <p className="alert-error">{list.error ?? ings.error}</p>}

      <div className="card mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label>
          <span className="label">{translateUi("วัตถุดิบ")}</span>
          <select className="input w-full" value={f.ingredient_id} onChange={(e) => set({ ingredient_id: e.target.value })}>
            <option value="">{translateUi("ทั้งหมด")}</option>
            {(ings.data?.ingredients ?? []).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </label>
        <label>
          <span className="label">{translateUi("ตั้งแต่")}</span>
          <input className="input w-full" type="date" max={f.to} value={f.from} onChange={(e) => e.target.value && set({ from: e.target.value })} />
        </label>
        <label>
          <span className="label">{translateUi("ถึง")}</span>
          <input className="input w-full" type="date" min={f.from} max={todayIso()} value={f.to} onChange={(e) => e.target.value && set({ to: e.target.value })} />
        </label>
        <label>
          <span className="label">{translateUi("ผู้ทำรายการ")}</span>
          <select className="input w-full" value={f.actor_id} onChange={(e) => set({ actor_id: e.target.value })}>
            <option value="">{translateUi("ทุกคน")}</option>
            {[...actors].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label>
          <span className="label">{translateUi("ประเภท")}</span>
          <select className="input w-full" value={f.type} onChange={(e) => set({ type: e.target.value })}>
            <option value="">{translateUi("ทั้งหมด")}</option>
            {(Object.keys(MOVEMENT_LABEL) as MovementType[]).map((t) => <option key={t} value={t}>{MOVEMENT_LABEL[t]}</option>)}
          </select>
        </label>
      </div>

      {pagination.controls}
      {list.data && rows.length === 0 ? (
        <Empty>{translateUi("ไม่มีรายการในช่วงนี้")}</Empty>
      ) : (
        <div className="table-wrap history-scroll">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="text-left">
                <th className="px-3 py-2">{translateUi("เวลา")}</th>
                <th className="px-3 py-2">{translateUi("วัตถุดิบ")}</th>
                <th className="px-3 py-2">{translateUi("ประเภท")}</th>
                <th className="px-3 py-2 text-right">{translateUi("จำนวน")}</th>
                <th className="px-3 py-2 text-right">{translateUi("คงเหลือหลังรายการ")}</th>
                <th className="px-3 py-2 text-right">{translateUi("มูลค่า (FIFO)")}</th>
                <th className="px-3 py-2">{translateUi("ผู้ทำ / อ้างอิง")}</th>
                {canReverse && <th className="px-3 py-2"></th>}
              </tr>
            </thead>
            <tbody className="divide-y">
              {pagination.items.map((m) => (
                <tr key={m.id} className={`align-top ${m.reversed_by ? 'text-gray-400' : ''}`}>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{dateTime(m.created_at)}</td>
                  <td className="px-3 py-2">{m.ingredient_name}</td>
                  <td className="px-3 py-2">
                    <span className={`badge ${BADGE[m.type]}`}>{MOVEMENT_LABEL[m.type]}</span>
                    {m.reverses_id && <div className="hint">{translateUi("รายการกลับ")}</div>}
                    {m.reversed_by && <div className="text-xs">{translateUi("ถูกกลับรายการแล้ว")}</div>}
                  </td>
                  <td className={`px-3 py-2 text-right font-medium tabular-nums ${Number(m.change) < 0 ? 'text-gray-900' : 'text-emerald-700'}`}>
                    {Number(m.change) > 0 ? '+' : '−'}{fmtNum(Math.abs(Number(m.change)))} {m.unit}
                  </td>
                  <td className="px-3 py-2 num text-gray-600">{m.balance_after === null ? '-' : `${fmtNum(Number(m.balance_after))} ${m.unit}`}</td>
                  <td className="px-3 py-2 num text-gray-600">{m.cost === null ? '-' : baht(Number(m.cost))}</td>
                  <td className="px-3 py-2 text-gray-600">
                    {m.actor_name ?? '-'}
                    {m.order_label && <div className="text-xs">{"" + translateUi("ออเดอร์") + " "}{m.order_label}</div>}
                    {m.note && <div className="hint">{m.note}</div>}
                  </td>
                  {canReverse && (
                    <td className="px-3 py-2 text-right">
                      {(m.type === 'receive' || m.type === 'count_adjust') && !m.reverses_id && !m.reversed_by && (
                        <button disabled={list.loading || Boolean(list.error)} className="link-danger text-xs" onClick={() => { setReversing(m); setReason('') }}>{translateUi("กลับรายการ")}</button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length >= 500 && <p className="mt-2 hint">{translateUi("แสดง 500 รายการล่าสุด กรองให้แคบลงเพื่อดูเพิ่ม")}</p>}

      {reversing && (
        <Modal label={translateUi("กลับรายการ")} onClose={() => setReversing(null)} busy={busy} className="max-w-sm p-0">
          <div className="card w-full max-w-sm space-y-3 p-5" onClick={(e) => e.stopPropagation()}>
            <h2 id="rev-title" className="title-lg">{translateUi("กลับรายการ")}</h2>
            {msg && !msg.ok && <p role="alert" className="alert-error">{msg.text}</p>}
            <p className="text-sm text-gray-600">
              {MOVEMENT_LABEL[reversing.type]} {reversing.ingredient_name} {Number(reversing.change) > 0 ? '+' : '−'}{fmtNum(Math.abs(Number(reversing.change)))} {reversing.unit}
              <br />{"" + translateUi("ระบบสร้างรายการตรงข้ามคู่กัน รายการเดิมยังอยู่ในประวัติ") + " "}</p>
            <label className="block">
              <span className="label">{translateUi("เหตุผล (บังคับ)")}</span>
              <input className="input w-full" autoFocus maxLength={180} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={translateUi("เช่น คีย์ผิดวัตถุดิบ")} />
            </label>
            <div className="flex justify-end gap-2">
              <button className="btn btn-secondary" disabled={busy} onClick={() => setReversing(null)}>{translateUi("ยกเลิก")}</button>
              <button className="btn btn-danger" disabled={!reason.trim() || busy} onClick={() => void reverse()}>{busy ? 'กำลังบันทึก...' : 'กลับรายการ'}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

export default function StockHistory() {
  return <RequireRole roles={rolesFor('/stock-history')}>{(ctx) => <Board restaurantId={ctx.restaurantId} roles={ctx.roles} />}</RequireRole>
}
