import Modal from './Modal'
import { translateUi } from "../lib/uiText"
import { useCallback, useEffect, useRef, useState } from 'react'
import { useText } from '../lib/preferences'
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
  const text = useText()
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
  const mutation = useRef(false)
  const reportRequest = useRef(0)
  const [fields, setFields] = useState<Record<string, string>>({})
  function showFields(invalid: Record<string, string>) {
    setFields(invalid)
    const first = Object.keys(invalid).find((key) => invalid[key])
    if (first) requestAnimationFrame(() => document.getElementById(`shift-${first}`)?.focus())
  }

  const loadReport = useCallback(async () => {
    const request = ++reportRequest.current
    if (!shift) return setReport(null)
    try {
      const next = await fetchShiftReport(shift.id)
      if (request === reportRequest.current) setReport(next)
    } catch (e) {
      if (request === reportRequest.current) { setReport(null); setError(e instanceof Error ? e.message : 'โหลดยอดกะไม่สำเร็จ') }
    }
  }, [shift])

  useEffect(() => {
    setReport(null)
    void loadReport()
    return () => { reportRequest.current++ }
  }, [loadReport])

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>, ok: string, after: () => Promise<void>) {
    if (mutation.current) return false
    mutation.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const { error: e } = await fn()
      if (e) throw new Error(dbMessage(e.message))
      setNotice(ok)
      await after()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : text('ทำรายการไม่สำเร็จ กรุณาลองอีกครั้ง', 'Could not complete this action. Please try again.'))
      return false
    } finally {
      mutation.current = false
      setBusy(false)
    }
  }

  async function open() {
    const cash = round2(Number(starting))
    if (!Number.isFinite(cash) || cash < 0 || starting.trim() === '') return showFields({ starting: text('กรอกจำนวนเงินตั้งแต่ 0 บาทขึ้นไป', 'Enter an amount of zero or more.') })
    setFields({})
    await run(
      () => supabase.rpc('shift_open', { p_restaurant_id: restaurantId, p_starting_cash: cash, p_terminal_code: setup.terminal?.terminal_code ?? null }),
      'เปิดกะแล้ว',
      async () => { setStarting(''); await current.reload() },
    )
  }

  async function logCash() {
    if (!shift) return
    const amt = round2(Number(logAmount))
    const invalid: Record<string, string> = {}
    if (!Number.isFinite(amt) || amt <= 0) invalid.amount = text('จำนวนเงินต้องมากกว่า 0', 'Enter an amount greater than zero.')
    if (!logReason.trim()) invalid.reason = text('กรอกเหตุผล', 'Enter a reason.')
    showFields(invalid)
    if (Object.keys(invalid).length) return
    await run(
      () => supabase.rpc('shift_cash_log', { p_shift_id: shift.id, p_log_type: logType, p_amount: amt, p_reason: logReason.trim() }),
      `${logType === 'cash_in' ? 'นำเงินเข้า' : 'นำเงินออก'} ${money(amt)} แล้ว`,
      async () => { setLogAmount(''); setLogReason(''); await loadReport() },
    )
  }

  const counted = DENOMS.reduce((s, d) => s + d * (Number(counts[d]) || 0), 0)
  const usingCounter = DENOMS.some((d) => Number(counts[d]) > 0)
  const actual = round2(usingCounter ? counted : Number(actualManual))
  const hasActual = usingCounter || actualManual.trim() !== ''
  const expected = report?.expected_cash ?? 0
  const variance = round2(actual - expected)

  async function close() {
    if (!shift || !report) return
    const invalid: Record<string, string> = {}
    if (DENOMS.some((d) => counts[d] && (!Number.isInteger(Number(counts[d])) || Number(counts[d]) < 0))) invalid.counts = text('จำนวนธนบัตรและเหรียญต้องเป็นจำนวนเต็มตั้งแต่ 0', 'Denomination counts must be whole numbers of zero or more.')
    if (!hasActual || !Number.isFinite(actual) || actual < 0) invalid.actual = text('กรอกยอดเงินที่นับได้จริงตั้งแต่ 0 บาท', 'Enter the counted cash amount of zero or more.')
    if (variance !== 0 && !note.trim()) invalid.note = text('เงินไม่ตรง กรุณาระบุหมายเหตุ', 'Explain the cash difference before closing.')
    showFields(invalid)
    if (Object.keys(invalid).length) return
    const id = shift.id
    await run(() => supabase.rpc('shift_close', { p_shift_id: id, p_actual_cash: actual, p_note: note.trim() || null }), 'ปิดกะแล้ว', async () => { await current.reload(); onPrint(id) })
  }

  return (
    <Modal label={translateUi("จัดการกะ")} onClose={onClose} busy={busy} className="max-w-lg p-0">
      <fieldset disabled={busy} className="card mx-auto w-full min-w-0 max-w-lg p-5">
        <div className="mb-4 row-between">
          <h2 className="title-lg">{translateUi(shift ? 'กะที่เปิดอยู่' : 'เปิดกะ')}</h2>
          <button type="button" className="grid h-11 w-11 place-items-center rounded-full hover:bg-gray-100" onClick={onClose} disabled={busy} aria-label={translateUi("ปิด")}>
            <Icon name="close" className="h-4 w-4" />
          </button>
        </div>

        {error && <p className="alert-error" role="alert">{error}</p>}
        {notice && <p className="alert-success" role="status">{translateUi(notice)}</p>}

        {!shift ? (
          <form
            className="space-y-4" noValidate
            onSubmit={(e) => {
              e.preventDefault()
              void open()
            }}
          >
            <TerminalPicker setup={setup} />
            <label className="block">
              <span className="label">{translateUi("เงินทอนตั้งต้นในลิ้นชัก (บาท)")}</span>
              <input
                className="input w-full py-3 num text-2xl font-semibold"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                autoFocus
                id="shift-starting" aria-invalid={Boolean(fields.starting)} aria-describedby={fields.starting ? "shift-starting-error" : undefined}
                value={starting}
                onBlur={() => setFields((f) => ({ ...f, starting: starting.trim() !== '' && Number.isFinite(Number(starting)) && Number(starting) >= 0 ? '' : text('กรอกจำนวนเงินตั้งแต่ 0 บาทขึ้นไป', 'Enter an amount of zero or more.') }))}
                onChange={(e) => { setStarting(e.target.value); setFields((f) => ({ ...f, starting: "" })) }}
              />
              {fields.starting && <p id="shift-starting-error" className="field-error">{fields.starting}</p>}
            </label>
            <button type="submit" className="btn btn-primary btn-lg w-full" disabled={busy}>
              {translateUi(busy ? 'กำลังเปิดกะ...' : 'เปิดกะ')}
            </button>
          </form>
        ) : (
          <div className="space-y-5">
            <div className="rounded-xl bg-gray-50 p-3 text-sm">
              <div className="flex justify-between text-gray-500">
                <span>{shift.cashier_name}</span>
                <span>{"" + translateUi("เปิดเมื่อ") + " "}{thaiDateTime(shift.opened_at)}</span>
              </div>
              <Line label={translateUi("เงินทอนตั้งต้น")} value={money(shift.starting_cash)} />
              <Line label={translateUi("ขายเงินสด")} value={money(report?.cash_sales ?? 0)} />
              <Line label={translateUi("นำเงินเข้า")} value={`+${money(report?.cash_in_total ?? 0)}`} />
              <Line label={translateUi("นำเงินออก")} value={`−${money(report?.cash_out_total ?? 0)}`} />
              <Line label={translateUi("เงินที่ควรมีในลิ้นชัก")} value={money(expected)} strong />
              {report && Object.keys(report.sales_by_method).length > 0 && (
                <div className="mt-2 border-t pt-2 hint">
                  {Object.entries(report.sales_by_method)
                    .map(([m, v]) => `${m} ${v.bills} บิล ${money(v.total)}`)
                    .join(' / ')}
                </div>
              )}
              <button type="button" className="link-muted mt-2 text-xs" onClick={() => onPrint(shift.id)}>{"" + translateUi("พิมพ์ X-Report (ยอดระหว่างกะ)") + " "}</button>
            </div>

            {!closing ? (
              <>
                <section>
                  <h3 className="label">{translateUi("บันทึกเงินเข้า/ออกลิ้นชัก")}</h3>
                  <div className="mb-2 inline-flex rounded-xl border bg-white p-1">
                    {(['cash_in', 'cash_out'] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setLogType(t)}
                        aria-pressed={logType === t}
                        className={`min-h-11 rounded-lg px-3 py-2 text-sm font-medium ${logType === t ? (t === 'cash_in' ? 'bg-emerald-700 text-white' : 'bg-red-700 text-white') : 'text-gray-600'}`}
                      >
                        {t === 'cash_in' ? 'นำเงินเข้า' : 'นำเงินออก'}
                      </button>
                    ))}
                  </div>
                  <div className="grid items-start gap-2 sm:grid-cols-[120px_1fr_auto]">
                    <label><span className="label">{text("จำนวนเงิน (บาท)", "Amount (baht)")}</span><input
                      className="input num"
                      type="number"
                      inputMode="decimal"
                      min="0.01"
                      step="0.01"
                      placeholder="0.00"
                      id="shift-amount" aria-invalid={Boolean(fields.amount)} aria-describedby={fields.amount ? "shift-amount-error" : undefined}
                      value={logAmount}
                      onBlur={() => setFields((f) => ({ ...f, amount: Number.isFinite(Number(logAmount)) && Number(logAmount) > 0 ? '' : text('จำนวนเงินต้องมากกว่า 0', 'Enter an amount greater than zero.') }))}
                      onChange={(e) => { setLogAmount(e.target.value); setFields((f) => ({ ...f, amount: "" })) }}
                    />{fields.amount && <p id="shift-amount-error" className="field-error">{fields.amount}</p>}</label>
                    <label><span className="label">{text("เหตุผล", "Reason")}</span><input
                      className="input"
                      maxLength={300}
                      placeholder={logType === 'cash_in' ? 'เช่น เติมเงินทอน' : 'เช่น ซื้อน้ำแข็ง จ่ายค่าส่ง'}
                      id="shift-reason" aria-invalid={Boolean(fields.reason)} aria-describedby={fields.reason ? "shift-reason-error" : undefined}
                      value={logReason}
                      onBlur={() => setFields((f) => ({ ...f, reason: logReason.trim() ? '' : text('กรอกเหตุผล', 'Enter a reason.') }))}
                      onChange={(e) => { setLogReason(e.target.value); setFields((f) => ({ ...f, reason: "" })) }}
                    />{fields.reason && <p id="shift-reason-error" className="field-error">{fields.reason}</p>}</label>
                    <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void logCash()}>{"" + translateUi("บันทึก") + " "}</button>
                  </div>
                  {report && report.drawer_logs.length > 0 && (
                    <ul className="mt-2 divide-y text-xs text-gray-600">
                      {report.drawer_logs.map((l, i) => (
                        <li key={i} className="flex justify-between py-1">
                          <span>
                            {new Date(l.at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} / {l.reason}
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
                <button type="button" className="btn btn-danger w-full" disabled={busy || !report} onClick={() => { setFields({}); setClosing(true) }}>{"" + translateUi("ปิดกะ") + " "}</button>
              </>
            ) : (
              <section className="space-y-3">
                <h3 className="label">{translateUi("นับเงินในลิ้นชัก")}</h3>
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
                        aria-invalid={Boolean(fields.counts)} aria-describedby={fields.counts ? "shift-counts-error" : undefined}
                        value={counts[d] ?? ''}
                        onChange={(e) => setCounts((c) => ({ ...c, [d]: e.target.value }))}
                      />
                    </label>
                  ))}
                </div>
                {fields.counts && <p id="shift-counts-error" className="field-error">{fields.counts}</p>}
                <label className="block">
                  <span className="hint">{translateUi("หรือกรอกยอดรวมที่นับได้")}</span>
                  <input
                    className="input w-full py-2.5 num text-xl font-semibold"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    disabled={usingCounter}
                    id="shift-actual" aria-invalid={Boolean(fields.actual)} aria-describedby={fields.actual ? "shift-actual-error" : undefined}
                    value={usingCounter ? String(counted) : actualManual}
                    onChange={(e) => setActualManual(e.target.value)}
                  />
                  {fields.actual && <p id="shift-actual-error" className="field-error">{fields.actual}</p>}
                </label>
                <div className="rounded-xl bg-gray-50 p-3 text-sm">
                  <Line label={translateUi("เงินที่ควรมี")} value={money(expected)} />
                  <Line label={translateUi("นับได้จริง")} value={hasActual ? money(actual) : '-'} />
                  <Line
                    label={!hasActual || variance === 0 ? 'ส่วนต่าง' : variance > 0 ? 'เงินเกิน' : 'เงินขาด'}
                    value={hasActual ? `${variance > 0 ? '+' : ''}${money(variance)}` : '-'}
                    strong
                    tone={!hasActual || variance === 0 ? undefined : variance > 0 ? 'text-amber-700' : 'text-red-600'}
                  />
                </div>
                <label><span className="label">{text("หมายเหตุ", "Note")}</span><input
                  className="input w-full"
                  maxLength={300}
                  placeholder={variance !== 0 && hasActual ? 'หมายเหตุ (บังคับเมื่อเงินไม่ตรง)' : 'หมายเหตุ (ไม่บังคับ)'}
                  id="shift-note" aria-invalid={Boolean(fields.note)} aria-describedby={fields.note ? "shift-note-error" : undefined}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />{fields.note && <p id="shift-note-error" className="field-error">{fields.note}</p>}</label>
                <div className="flex gap-2">
                  <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setClosing(false)}>{"" + translateUi("ย้อนกลับ") + " "}</button>
                  <button type="button" className="btn btn-danger flex-1" disabled={busy || !report} onClick={() => void close()}>
                    <Icon name="print" className="h-4 w-4" />
                    {busy ? 'กำลังปิดกะ...' : 'ยืนยันปิดกะ + พิมพ์ Z-Report'}
                  </button>
                </div>
              </section>
            )}
          </div>
        )}
      </fieldset>
    </Modal>
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
