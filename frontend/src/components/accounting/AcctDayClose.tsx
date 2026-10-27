// ปิดวัน: ดูสรุปยอด -> นับเงินสดในลิ้นชัก -> ยืนยัน (เจ้าของ/ผู้จัดการ) -> ล็อกรายการของวัน + ส่งสรุปเข้า LINE
// หลังปิดวัน แก้ได้เฉพาะกลับรายการ (เช่น เจ้าของยกเลิกบิลพร้อมเหตุผล)
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { api, apiMessage } from '../../lib/api'
import { accountingError, metrics, normalizeSummary, type Summary } from '../../lib/accounting'
import { baht } from '../../lib/format'
import { Section, Stat } from './ui'

interface DaySummary extends Summary {
  system_cash: number
  closed: boolean
  close: { counted_cash: number; difference: number; note: string | null; confirmed_by_name: string | null; created_at: string } | null
}

interface BillRow {
  id: string
  entry_no: number
  source_id: string
  memo: string | null
  amount: number
  reversed: boolean
}

interface CloseRow {
  close_date: string
  system_cash: number
  counted_cash: number
  difference: number
  confirmed_by_name: string | null
}

const LINE_TEXT = { sent: 'ส่งสรุปเข้า LINE แล้ว', not_configured: 'ยังไม่ได้ตั้ง LINE (ตั้งที่หน้าตั้งค่าร้าน)', failed: 'ส่ง LINE ไม่สำเร็จ (ปิดวันสำเร็จแล้ว)' }

export default function AcctDayClose({
  restaurantId,
  today,
  canClose,
  isOwner,
  onChanged,
}: {
  restaurantId: string
  today: string
  canClose: boolean
  isOwner: boolean
  onChanged: () => void
}) {
  const [date, setDate] = useState(today)
  const [day, setDay] = useState<DaySummary | null>(null)
  const [bills, setBills] = useState<BillRow[]>([])
  const [history, setHistory] = useState<CloseRow[]>([])
  const [counted, setCounted] = useState('')
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [cancel, setCancel] = useState<{ orderId: string; reason: string } | null>(null)

  const load = useCallback(async () => {
    const [d, b, h] = await Promise.all([
      supabase.rpc('acct_day_summary', { p_restaurant_id: restaurantId, p_date: date }),
      supabase
        .from('journal_entries')
        .select('id,entry_no,source_id,memo,journal_lines(debit,accounts(grp))')
        .eq('restaurant_id', restaurantId)
        .eq('source_type', 'bill')
        .eq('entry_date', date)
        .order('entry_no'),
      supabase.from('day_closes').select('close_date,system_cash,counted_cash,difference,confirmed_by_name').eq('restaurant_id', restaurantId).order('close_date', { ascending: false }).limit(14),
    ])
    if (d.error) return setMsg({ ok: false, text: 'โหลดสรุปวันไม่สำเร็จ (ต้องรัน migration 0026)' })
    const raw = d.data as Record<string, unknown>
    setDay({ ...normalizeSummary(raw), system_cash: Number(raw.system_cash), closed: Boolean(raw.closed), close: raw.close as DaySummary['close'] })
    const entries = (b.data ?? []) as unknown as { id: string; entry_no: number; source_id: string; memo: string | null; journal_lines: { debit: number; accounts: { grp: string } | null }[] }[]
    const ids = entries.map((e) => e.id)
    const rev = ids.length
      ? ((await supabase.from('journal_entries').select('reverses_entry_id').in('reverses_entry_id', ids)).data ?? []).map((r) => r.reverses_entry_id as string)
      : []
    setBills(
      entries.map((e) => ({
        id: e.id,
        entry_no: e.entry_no,
        source_id: e.source_id,
        memo: e.memo,
        amount: e.journal_lines.filter((l) => l.accounts?.grp === 'cash' || l.accounts?.grp === 'bank').reduce((s, l) => s + Number(l.debit), 0),
        reversed: rev.includes(e.id),
      })),
    )
    setHistory(((h.data ?? []) as CloseRow[]).map((r) => ({ ...r, system_cash: Number(r.system_cash), counted_cash: Number(r.counted_cash), difference: Number(r.difference) })))
  }, [restaurantId, date])

  useEffect(() => {
    void load()
  }, [load])

  const diff = counted === '' || !day ? null : Number(counted) - day.system_cash

  async function close() {
    if (!day || counted === '' || !(Number(counted) >= 0)) return setMsg({ ok: false, text: 'กรอกยอดเงินสดที่นับได้' })
    setBusy(true)
    try {
      const r = await api<{ line: keyof typeof LINE_TEXT }>('/accounting/day-close', {
        body: { restaurant_id: restaurantId, date, counted_cash: Number(counted), note: note.trim() || null },
      })
      setMsg({ ok: true, text: `ปิดวัน ${date} แล้ว · ${LINE_TEXT[r.line]}` })
      setCounted('')
      setNote('')
      void load()
      onChanged()
    } catch (e) {
      setMsg({ ok: false, text: accountingError(apiMessage(e)) })
    } finally {
      setBusy(false)
    }
  }

  async function cancelBill() {
    if (!cancel) return
    if (!cancel.reason.trim()) return setMsg({ ok: false, text: 'ต้องใส่เหตุผลที่ยกเลิกบิล' })
    const { error, count } = await supabase
      .from('orders')
      .update({ status: 'cancelled', cancel_reason: cancel.reason.trim() }, { count: 'exact' })
      .eq('id', cancel.orderId)
      .eq('status', 'paid')
    if (error) return setMsg({ ok: false, text: accountingError(error.message) })
    if (!count) return setMsg({ ok: false, text: 'ไม่พบบิลที่จ่ายแล้ว' })
    setCancel(null)
    setMsg({ ok: true, text: 'ยกเลิกบิลแล้ว: กลับรายการรายได้ และย้ายต้นทุนเป็นส่วนต่างสต็อก' })
    void load()
    onChanged()
  }

  const m = day ? metrics(day) : null

  return (
    <div>
      {msg && <p className={msg.ok ? 'alert-success' : 'alert-error'}>{msg.text}</p>}
      <div className="mb-4 flex items-center gap-2">
        <label className="label mb-0" htmlFor="dc-date">
          วันที่
        </label>
        <input id="dc-date" className="input" type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} />
        {day?.closed && <span className="badge badge-green">ปิดวันแล้ว</span>}
      </div>

      {day && m && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="ยอดขายสุทธิ" value={baht(m.netSales)} hint={`${day.bills} บิล${day.cancelled_bills ? ` · ยกเลิก ${day.cancelled_bills}` : ''}`} />
            <Stat label="ต้นทุนอาหาร" value={baht(m.foodCost)} hint={m.foodCostPct === null ? undefined : `${m.foodCostPct}% ของยอดขาย`} />
            <Stat label="ค่าใช้จ่าย" value={baht(m.expenses)} />
            <Stat label="กำไรวันนี้" value={baht(m.netProfit)} tone={m.netProfit < 0 ? 'bad' : 'good'} />
          </div>

          <div className="card mt-4">
            <h2 className="section-title">นับเงินสดในลิ้นชัก</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <div className="stat-label">เงินสดตามระบบ</div>
                <div className="stat-value">{baht(day.system_cash)}</div>
                <div className="text-xs text-gray-500">ยอดยกมา + ขายเงินสด − จ่ายเงินสด</div>
              </div>
              {day.closed && day.close ? (
                <>
                  <div>
                    <div className="stat-label">นับได้จริง</div>
                    <div className="stat-value">{baht(Number(day.close.counted_cash))}</div>
                  </div>
                  <div>
                    <div className="stat-label">ส่วนต่าง</div>
                    <div className={`stat-value ${Number(day.close.difference) < 0 ? 'text-red-600' : ''}`}>{baht(Number(day.close.difference))}</div>
                    <div className="text-xs text-gray-500">
                      ยืนยันโดย {day.close.confirmed_by_name ?? '-'} · {new Date(day.close.created_at).toLocaleString('th-TH')}
                    </div>
                  </div>
                </>
              ) : canClose ? (
                <>
                  <div>
                    <label className="label" htmlFor="dc-count">
                      นับได้จริง (บาท)
                    </label>
                    <input id="dc-count" className="input w-full text-lg" type="number" inputMode="decimal" min="0" step="0.01" value={counted} onChange={(e) => setCounted(e.target.value)} />
                  </div>
                  <div>
                    <div className="stat-label">ส่วนต่าง</div>
                    <div className={`stat-value ${diff !== null && diff < 0 ? 'text-red-600' : ''}`}>
                      {diff === null ? '–' : diff === 0 ? 'ตรงยอด' : `${diff > 0 ? 'เกิน' : 'ขาด'} ${baht(Math.abs(diff))}`}
                    </div>
                  </div>
                </>
              ) : (
                <p className="text-sm text-gray-500 sm:col-span-2">เจ้าของร้านหรือผู้จัดการเป็นผู้นับเงินและยืนยันปิดวัน</p>
              )}
            </div>
            {!day.closed && canClose && (
              <div className="mt-3 flex flex-wrap gap-2">
                <input className="input min-w-0 flex-1" placeholder="หมายเหตุ (ไม่บังคับ)" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
                <button className="btn btn-primary" disabled={busy || counted === ''} onClick={() => void close()}>
                  {busy ? 'กำลังปิดวัน...' : 'ยืนยันและปิดวัน'}
                </button>
              </div>
            )}
            <p className="mt-2 text-xs text-gray-500">
              ปิดวันแล้วจะล็อกรายการของวันนั้น บันทึกเพิ่มไม่ได้ (บิลที่จ่ายหลังปิดวันเข้าวันถัดไป) แก้ได้เฉพาะกลับรายการ · ส่วนต่างลงบัญชีเงินสดขาด/เกิน
            </p>
          </div>
        </>
      )}

      <Section title={`บิลที่จ่ายแล้ว (${bills.length})`}>
        <ul className="card-flush divide-y text-sm">
          {bills.map((b) => (
            <li key={b.id} className={`p-3 ${b.reversed ? 'text-gray-400' : ''}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  #{b.entry_no} · {b.memo}
                  {b.reversed && <span className="badge badge-red ml-2">ยกเลิกแล้ว</span>}
                </span>
                <span className="flex items-center gap-3">
                  <span className={`tabular-nums ${b.reversed ? 'line-through' : ''}`}>{baht(b.amount)}</span>
                  {isOwner && !b.reversed && (
                    <button className="link-danger" onClick={() => setCancel({ orderId: b.source_id, reason: '' })}>
                      ยกเลิกบิล
                    </button>
                  )}
                </span>
              </div>
              {cancel?.orderId === b.source_id && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <input
                    className="input min-w-0 flex-1"
                    placeholder="เหตุผลที่ยกเลิกบิล (บังคับ)"
                    maxLength={200}
                    value={cancel.reason}
                    onChange={(e) => setCancel({ ...cancel, reason: e.target.value })}
                    autoFocus
                  />
                  <button className="btn btn-danger btn-sm" onClick={() => void cancelBill()}>
                    ยืนยันยกเลิกบิล
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setCancel(null)}>
                    ไม่ยกเลิก
                  </button>
                </div>
              )}
            </li>
          ))}
          {bills.length === 0 && <li className="p-6 text-center text-gray-400">ยังไม่มีบิลที่จ่ายแล้วในวันนี้</li>}
        </ul>
        {isOwner && <p className="mt-2 text-xs text-gray-500">ยกเลิกบิลหลังจ่ายได้เฉพาะเจ้าของร้าน ต้องใส่เหตุผล ระบบกลับรายการรายได้และย้ายต้นทุนเป็นส่วนต่างสต็อก</p>}
      </Section>

      {history.length > 0 && (
        <Section title="ประวัติปิดวัน">
          <div className="card-flush overflow-x-auto">
            <table className="w-full text-sm [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2">
              <thead>
                <tr>
                  <th className="text-left">วันที่</th>
                  <th className="text-right">ระบบ</th>
                  <th className="text-right">นับจริง</th>
                  <th className="text-right">ส่วนต่าง</th>
                  <th className="text-left">ยืนยันโดย</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.close_date} className="border-t">
                    <td>{h.close_date}</td>
                    <td className="text-right tabular-nums">{baht(h.system_cash)}</td>
                    <td className="text-right tabular-nums">{baht(h.counted_cash)}</td>
                    <td className={`text-right tabular-nums ${h.difference < 0 ? 'text-red-600' : ''}`}>{baht(h.difference)}</td>
                    <td>{h.confirmed_by_name ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </div>
  )
}
