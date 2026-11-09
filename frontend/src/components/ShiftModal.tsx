import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getSession } from '../lib/session'
import { dbMessage, fetchShiftReport, money, normShift, thaiDateTime, type CashierShift, type ShiftReport, type TaxSetup } from '../lib/tax'
import TerminalPicker from './TerminalPicker'
import Icon from './Icon'

// กะแคชเชียร์ (0031): เปิดกะ (เงินทอนตั้งต้น) → นำเงินเข้า/ออก → ปิดกะ (นับเงินจริง ดูส่วนต่าง) → พิมพ์ Z-Report
// บิลที่รับชำระระหว่างกะผูกกับกะอัตโนมัติในฐานข้อมูล (orders_assign_shift)

export function useCurrentShift(restaurantId: string) {
  const [shift, setShift] = useState<CashierShift | null>(null)
  const [loaded, setLoaded] = useState(false)
  const reload = useCallback(async () => {
    const uid = getSession()?.user.id
    if (!uid) return setLoaded(true)
    const { data, error } = await supabase
      .from('cashier_shifts')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .eq('cashier_id', uid)
      .eq('status', 'open')
      .maybeSingle()
    setShift(error || !data ? null : normShift(data as Record<string, unknown>))
    setLoaded(true)
  }, [restaurantId])
  useEffect(() => {
    void reload()
  }, [reload])
  return { shift, loaded, reload }
}
export type CurrentShift = ReturnType<typeof useCurrentShift>

const DENOMS = [1000, 500, 100, 50, 20, 10, 5, 2, 1] as const
const round2 = (n: number) => Math.round(n * 100) / 100

export default function ShiftModal({
  restaurantId,
  setup,
  current,
  onClose,
  onPrint,
}: {
  restaurantId: string
  setup: TaxSetup
  current: CurrentShift
  onClose: () => void
  onPrint: (shiftId: string) => void
}) {
  const { shift } = current
  const [report, setReport] = useState<ShiftReport | null>(null)
  const [starting, setStarting] = useState('')
  const [logType, setLogType] = useState<'cash_in' | 'cash_out'>('cash_in')
  const [logAmount, setLogAmount] = useState('')
  const [logReason, setLogReason] = useState('')
  const [counts, setCounts] = useState<Record<number, string>>({})
  const [actualManual, setActualManual] = useState('')
  const [note, setNote] = useState('')
  const [closing, setClosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const loadReport = useCallback(async () => {
    if (!shift) return setReport(null)
    try {
      setReport(await fetchShiftReport(shift.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'โหลดยอดกะไม่สำเร็จ')
    }
  }, [shift])

  useEffect(() => {
    void loadReport()
  }, [loadReport])

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>, ok: string) {
    setBusy(true)
    setError(null)
    setNotice(null)
    const { error: e } = await fn()
    setBusy(false)
    if (e) {
      setError(dbMessage(e.message))
      return false
    }
    setNotice(ok)
    return true
  }

  async function open() {
    const cash = round2(Number(starting))
    if (!(cash >= 0) || starting.trim() === '') return setError('กรอกเงินทอนตั้งต้น')
    const ok = await run(
      () => supabase.rpc('shift_open', { p_restaurant_id: restaurantId, p_starting_cash: cash, p_terminal_code: setup.terminal?.terminal_code ?? null }),
      'เปิดกะแล้ว',
    )
    if (ok) {
      setStarting('')
      await current.reload()
    }
  }

  async function logCash() {
    if (!shift) return
    const amt = round2(Number(logAmount))
    if (!(amt > 0)) return setError('จำนวนเงินต้องมากกว่า 0')
    if (!logReason.trim()) return setError('กรอกเหตุผล')
    const ok = await run(
      () => supabase.rpc('shift_cash_log', { p_shift_id: shift.id, p_log_type: logType, p_amount: amt, p_reason: logReason.trim() }),
      `${logType === 'cash_in' ? 'นำเงินเข้า' : 'นำเงินออก'} ${money(amt)} แล้ว`,
    )
    if (ok) {
      setLogAmount('')
      setLogReason('')
      await loadReport()
    }
  }

  const counted = DENOMS.reduce((s, d) => s + d * (Number(counts[d]) || 0), 0)
  const usingCounter = DENOMS.some((d) => Number(counts[d]) > 0)
  const actual = round2(usingCounter ? counted : Number(actualManual))
  const hasActual = usingCounter || actualManual.trim() !== ''
  const expected = report?.expected_cash ?? 0
  const variance = round2(actual - expected)

  async function close() {
    if (!shift || !hasActual || !(actual >= 0)) return setError('กรอกยอดเงินที่นับได้จริง')
    if (variance !== 0 && !note.trim()) return setError('เงินไม่ตรง กรุณาระบุหมายเหตุ')
    const id = shift.id
    const ok = await run(() => supabase.rpc('shift_close', { p_shift_id: id, p_actual_cash: actual, p_note: note.trim() || null }), 'ปิดกะแล้ว')
    if (ok) {
      await current.reload()
      onPrint(id)
    }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-gray-900/50 p-4" role="dialog" aria-modal="true" aria-label="จัดการกะ">
      <div className="card mx-auto w-full max-w-lg p-5">
        <div className="mb-4 row-between">
          <h2 className="title-lg">{shift ? 'กะที่เปิดอยู่' : 'เปิดกะ'}</h2>
          <button className="grid h-8 w-8 place-items-center rounded-full hover:bg-gray-100" onClick={onClose} aria-label="ปิด">
            <Icon name="close" className="h-4 w-4" />
          </button>
        </div>

        {error && <p className="alert-error">{error}</p>}
        {notice && <p className="alert-success">{notice}</p>}

        {!shift ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              void open()
            }}
          >
            <TerminalPicker setup={setup} />
            <label className="block">
              <span className="label">เงินทอนตั้งต้นในลิ้นชัก (บาท)</span>
              <input
                className="input w-full py-3 num text-2xl font-semibold"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                autoFocus
                value={starting}
                onChange={(e) => setStarting(e.target.value)}
              />
            </label>
            <button className="btn btn-primary btn-lg w-full" disabled={busy || starting.trim() === ''}>
              {busy ? 'กำลังเปิดกะ...' : 'เปิดกะ'}
            </button>
          </form>
        ) : (
          <div className="space-y-5">
            <div className="rounded-xl bg-gray-50 p-3 text-sm">
              <div className="flex justify-between text-gray-500">
                <span>{shift.cashier_name}</span>
                <span>เปิดเมื่อ {thaiDateTime(shift.opened_at)}</span>
              </div>
              <Line label="เงินทอนตั้งต้น" value={money(shift.starting_cash)} />
              <Line label="ขายเงินสด" value={money(report?.cash_sales ?? 0)} />
              <Line label="นำเงินเข้า" value={`+${money(report?.cash_in_total ?? 0)}`} />
              <Line label="นำเงินออก" value={`−${money(report?.cash_out_total ?? 0)}`} />
              <Line label="เงินที่ควรมีในลิ้นชัก" value={money(expected)} strong />
              {report && Object.keys(report.sales_by_method).length > 0 && (
                <div className="mt-2 border-t pt-2 hint">
                  {Object.entries(report.sales_by_method)
                    .map(([m, v]) => `${m} ${v.bills} บิล ${money(v.total)}`)
                    .join(' · ')}
                </div>
              )}
              <button className="link-muted mt-2 text-xs" onClick={() => onPrint(shift.id)}>
                พิมพ์ X-Report (ยอดระหว่างกะ)
              </button>
            </div>

            {!closing ? (
              <>
                <section>
                  <h3 className="label">บันทึกเงินเข้า/ออกลิ้นชัก</h3>
                  <div className="mb-2 inline-flex rounded-xl border bg-white p-1">
                    {(['cash_in', 'cash_out'] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setLogType(t)}
                        className={`rounded-lg px-3 py-1.5 text-sm font-medium ${logType === t ? (t === 'cash_in' ? 'bg-emerald-500 text-white' : 'bg-red-500 text-white') : 'text-gray-600'}`}
                      >
                        {t === 'cash_in' ? 'นำเงินเข้า' : 'นำเงินออก'}
                      </button>
                    ))}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[120px_1fr_auto]">
                    <input
                      className="input num"
                      type="number"
                      inputMode="decimal"
                      min="0.01"
                      step="0.01"
                      placeholder="0.00"
                      value={logAmount}
                      onChange={(e) => setLogAmount(e.target.value)}
                    />
                    <input
                      className="input"
                      maxLength={300}
                      placeholder={logType === 'cash_in' ? 'เช่น เติมเงินทอน' : 'เช่น ซื้อน้ำแข็ง จ่ายค่าส่ง'}
                      value={logReason}
                      onChange={(e) => setLogReason(e.target.value)}
                    />
                    <button className="btn btn-secondary" disabled={busy} onClick={() => void logCash()}>
                      บันทึก
                    </button>
                  </div>
                  {report && report.drawer_logs.length > 0 && (
                    <ul className="mt-2 divide-y text-xs text-gray-600">
                      {report.drawer_logs.map((l, i) => (
                        <li key={i} className="flex justify-between py-1">
                          <span>
                            {new Date(l.at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} · {l.reason}
                          </span>
                          <span className={`tabular-nums ${l.type === 'cash_in' ? 'text-emerald-700' : 'text-red-600'}`}>
                            {l.type === 'cash_in' ? '+' : '−'}
                            {money(l.amount)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <button className="btn btn-danger w-full" onClick={() => setClosing(true)}>
                  ปิดกะ
                </button>
              </>
            ) : (
              <section className="space-y-3">
                <h3 className="label">นับเงินในลิ้นชัก</h3>
                <div className="grid grid-cols-3 gap-2">
                  {DENOMS.map((d) => (
                    <label key={d} className="flex items-center gap-1.5 text-sm">
                      <span className="w-12 num text-gray-500">{d}×</span>
                      <input
                        className="input w-full py-1.5 num"
                        type="number"
                        inputMode="numeric"
                        min="0"
                        step="1"
                        value={counts[d] ?? ''}
                        onChange={(e) => setCounts((c) => ({ ...c, [d]: e.target.value }))}
                      />
                    </label>
                  ))}
                </div>
                <label className="block">
                  <span className="hint">หรือกรอกยอดรวมที่นับได้</span>
                  <input
                    className="input w-full py-2.5 num text-xl font-semibold"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    disabled={usingCounter}
                    value={usingCounter ? String(counted) : actualManual}
                    onChange={(e) => setActualManual(e.target.value)}
                  />
                </label>
                <div className="rounded-xl bg-gray-50 p-3 text-sm">
                  <Line label="เงินที่ควรมี" value={money(expected)} />
                  <Line label="นับได้จริง" value={hasActual ? money(actual) : '-'} />
                  <Line
                    label={!hasActual || variance === 0 ? 'ส่วนต่าง' : variance > 0 ? 'เงินเกิน' : 'เงินขาด'}
                    value={hasActual ? `${variance > 0 ? '+' : ''}${money(variance)}` : '-'}
                    strong
                    tone={!hasActual || variance === 0 ? undefined : variance > 0 ? 'text-amber-700' : 'text-red-600'}
                  />
                </div>
                <input
                  className="input w-full"
                  maxLength={300}
                  placeholder={variance !== 0 && hasActual ? 'หมายเหตุ (บังคับเมื่อเงินไม่ตรง)' : 'หมายเหตุ (ไม่บังคับ)'}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <div className="flex gap-2">
                  <button className="btn btn-secondary" disabled={busy} onClick={() => setClosing(false)}>
                    ย้อนกลับ
                  </button>
                  <button className="btn btn-danger flex-1" disabled={busy || !hasActual} onClick={() => void close()}>
                    <Icon name="print" className="h-4 w-4" />
                    {busy ? 'กำลังปิดกะ...' : 'ยืนยันปิดกะ + พิมพ์ Z-Report'}
                  </button>
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Line({ label, value, strong = false, tone }: { label: string; value: string; strong?: boolean; tone?: string }) {
  return (
    <div className={`flex justify-between ${strong ? 'mt-1 border-t pt-1 font-semibold text-gray-900' : ''} ${tone ?? ''}`}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}
