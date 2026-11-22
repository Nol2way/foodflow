import { translateUi } from "../../lib/uiText"
// รายจ่าย: บังคับเลือกหมวด · วิธีจ่าย · แนบรูปใบเสร็จ (bucket expense-receipts) · ลงบัญชีอัตโนมัติ
// ใบกำกับภาษีซื้อ (ขอคืนภาษีซื้อ) คิด VAT จากยอดรวมอัตโนมัติ · ภาษีหัก ณ ที่จ่าย (ภ.ง.ด.3 / ภ.ง.ด.53) คิดจากฐานก่อน VAT
// ลงแล้วแก้ยอดไม่ได้ ต้อง "ยกเลิกรายจ่าย" (กลับรายการ) แล้วบันทึกใหม่
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import {
  EMPTY_EXPENSE_TAX,
  WHT_FORM_LABEL,
  WHT_FORM_SHORT,
  WHT_RATES,
  accountingError,
  expenseTax,
  expenseTaxError,
  expenseTaxFields,
  needsSupplier,
  thaiTaxIdValid,
  validateExpenseTax,
  whtFormFor,
  type ExpenseTaxForm,
  type WhtForm,
  type WhtRate,
} from '../../lib/accounting'
import { branchLabel, formatTaxId } from '../../lib/tax'
import { baht } from '../../lib/format'
import { GROUP_LABEL, PAYMENT_LABEL, Section, expenseCategories, monthStart, type AccountRow } from './ui'

export const RECEIPT_BUCKET = 'expense-receipts'
const MAX_MB = 10

interface Expense {
  id: string
  spent_on: string
  amount: number
  vat_amount: number
  payment_method: string
  note: string | null
  receipt_url: string | null
  source: 'manual' | 'stock_receipt' | 'legacy'
  voided_at: string | null
  void_reason: string | null
  account_id: string | null
  supplier_name: string | null
  supplier_tax_id: string | null
  supplier_branch_code: string | null
  tax_invoice_no: string | null
  tax_invoice_date: string | null
  wht_rate: number | null
  wht_amount: number
  wht_type: WhtForm | null
}

const EXPENSE_COLUMNS =
  'id,spent_on,amount,vat_amount,payment_method,note,receipt_url,source,voided_at,void_reason,account_id,' +
  'supplier_name,supplier_tax_id,supplier_branch_code,tax_invoice_no,tax_invoice_date,wht_rate,wht_amount,wht_type'

const SOURCE_NOTE: Record<string, string> = { stock_receipt: 'จากใบรับของ (ลงเป็นสต็อก)', legacy: 'ก่อนเปิดโมดูลบัญชี' }
const digits = (v: string, max: number) => v.replace(/\D/g, '').slice(0, max)

export default function AcctExpenses({
  restaurantId,
  today,
  canWrite,
  vatRegistered,
  vatRate = 7,
  onChanged,
}: {
  restaurantId: string
  today: string
  canWrite: boolean
  vatRegistered: boolean
  vatRate?: number
  onChanged: () => void
}) {
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [rows, setRows] = useState<Expense[]>([])
  const [from, setFrom] = useState(monthStart(today))
  const [to, setTo] = useState(today)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [f, setF] = useState({ account_id: '', amount: '', payment: 'cash', date: today, note: '' })
  const [tax, setTax] = useState<ExpenseTaxForm>({ ...EMPTY_EXPENSE_TAX, invoiceDate: today })
  const [file, setFile] = useState<File | null>(null)
  const [voiding, setVoiding] = useState<{ id: string; reason: string } | null>(null)
  const [newCat, setNewCat] = useState<{ name: string; grp: string } | null>(null)

  const load = useCallback(async () => {
    const [a, e] = await Promise.all([
      supabase.from('accounts').select('id,code,name,type,grp,system_key,is_active').eq('restaurant_id', restaurantId).order('code'),
      supabase
        .from('expenses')
        .select(EXPENSE_COLUMNS)
        .eq('restaurant_id', restaurantId)
        .gte('spent_on', from)
        .lte('spent_on', to)
        .order('spent_on', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(500),
    ])
    if (a.error || e.error) return setMsg({ ok: false, text: 'โหลดรายจ่ายไม่สำเร็จ (ต้องรัน migration 0026 และ 0031)' })
    setAccounts((a.data ?? []) as AccountRow[])
    setRows(
      ((e.data ?? []) as unknown as Expense[]).map((x) => ({
        ...x,
        amount: Number(x.amount),
        vat_amount: Number(x.vat_amount),
        wht_amount: Number(x.wht_amount ?? 0),
        wht_rate: x.wht_rate == null ? null : Number(x.wht_rate),
      })),
    )
  }, [restaurantId, from, to])

  useEffect(() => {
    void load()
  }, [load])

  const cats = useMemo(() => expenseCategories(accounts), [accounts])
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
  const live = rows.filter((r) => !r.voided_at)
  const total = live.reduce((s, r) => s + r.amount, 0)
  const totalVat = live.filter((r) => r.tax_invoice_no).reduce((s, r) => s + r.vat_amount, 0)
  const totalWht = live.reduce((s, r) => s + r.wht_amount, 0)

  const amount = Number(f.amount || 0)
  const inputTax = vatRegistered && tax.inputTax
  const calc = expenseTax(amount, inputTax, tax.whtRate, vatRate)
  const showSupplier = needsSupplier({ inputTax, whtRate: tax.whtRate })
  const taxIdOk = thaiTaxIdValid(tax.supplierTaxId)
  const suggestedForm = taxIdOk ? whtFormFor(tax.supplierTaxId) : null

  function setTaxId(v: string) {
    const id = digits(v, 13)
    // เลือกแบบ ภ.ง.ด. ให้ตรงกับประเภทผู้ขายอัตโนมัติ (0 = นิติบุคคล → ภ.ง.ด.53)
    setTax((t) => ({ ...t, supplierTaxId: id, whtForm: thaiTaxIdValid(id) ? whtFormFor(id) : t.whtForm }))
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!f.account_id) return setMsg({ ok: false, text: 'ต้องเลือกหมวดรายจ่าย' })
    if (!(amount > 0)) return setMsg({ ok: false, text: 'กรอกจำนวนเงินที่มากกว่า 0' })
    const effective: ExpenseTaxForm = { ...tax, inputTax }
    const invalid = validateExpenseTax(effective, amount, today)
    if (invalid) return setMsg({ ok: false, text: invalid })
    if (file && file.size > MAX_MB * 1024 * 1024) return setMsg({ ok: false, text: `รูปใบเสร็จใหญ่เกิน ${MAX_MB} MB` })
    setBusy(true)
    let path: string | null = null
    if (file) {
      const ext = (file.name.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg'
      path = `${restaurantId}/${f.date}/${crypto.randomUUID()}.${ext}`
      const up = await supabase.storage.from(RECEIPT_BUCKET).upload(path, file, { contentType: file.type })
      if (up.error) {
        setBusy(false)
        return setMsg({ ok: false, text: 'อัปโหลดรูปใบเสร็จไม่สำเร็จ: ' + up.error.message })
      }
    }
    const taxFields = expenseTaxFields(effective, amount, vatRate)
    const { error } = await supabase.from('expenses').insert({
      ...Object.fromEntries(Object.entries(taxFields).filter(([k, v]) => k === 'vat_amount' || v !== null)),
      restaurant_id: restaurantId,
      category: 'other', // ฐานข้อมูลตั้งหมวดแบบเดิมจากบัญชีให้
      account_id: f.account_id,
      amount,
      payment_method: f.payment,
      spent_on: f.date,
      note: f.note.trim() || null,
      receipt_url: path,
    })
    setBusy(false)
    if (error) {
      if (path) void supabase.storage.from(RECEIPT_BUCKET).remove([path])
      return setMsg({ ok: false, text: expenseTaxError(error.message) ?? accountingError(error.message) })
    }
    const extra = [calc.vat > 0 && `ภาษีซื้อ ${baht(calc.vat)}`, calc.wht > 0 && `หัก ณ ที่จ่าย ${baht(calc.wht)}`].filter(Boolean).join(' · ')
    setMsg({ ok: true, text: `บันทึก ${byId.get(f.account_id)?.name ?? 'รายจ่าย'} ${baht(amount)} แล้ว${extra ? ` (${extra})` : ''}` })
    setF({ ...f, amount: '', note: '' })
    // เก็บข้อมูลผู้ขายไว้ (มักบันทึกหลายใบจากผู้ขายรายเดิม) ล้างเฉพาะเลขที่ใบกำกับ
    setTax((t) => ({ ...t, invoiceNo: '' }))
    setFile(null)
    void load()
    onChanged()
  }

  async function voidExpense() {
    if (!voiding) return
    if (!voiding.reason.trim()) return setMsg({ ok: false, text: 'ต้องใส่เหตุผลที่ยกเลิก' })
    const { error } = await supabase.rpc('acct_void_expense', { p_expense_id: voiding.id, p_reason: voiding.reason.trim() })
    if (error) return setMsg({ ok: false, text: accountingError(error.message) })
    setVoiding(null)
    setMsg({ ok: true, text: 'ยกเลิกรายจ่ายแล้ว (ลงกลับรายการในสมุดรายวัน)' })
    void load()
    onChanged()
  }

  async function openReceipt(path: string) {
    const { data, error } = await supabase.storage.from(RECEIPT_BUCKET).createSignedUrl(path, 300)
    if (error || !data) return setMsg({ ok: false, text: 'เปิดรูปใบเสร็จไม่ได้' })
    window.open(data.signedUrl, '_blank', 'noopener')
  }

  // หมวดที่ร้านเพิ่มเอง: รหัสถัดไปในช่วงของกลุ่ม (ต้นทุนอาหาร 50xx · ค่าแรง 51xx · ค่าใช้จ่ายอื่น 53xx-58xx)
  async function addCategory(e: FormEvent) {
    e.preventDefault()
    if (!newCat || !newCat.name.trim()) return
    const start = newCat.grp === 'food_cost' ? 5050 : newCat.grp === 'labor' ? 5150 : 5300
    const end = newCat.grp === 'food_cost' ? 5099 : newCat.grp === 'labor' ? 5199 : 5899
    const used = new Set(accounts.map((a) => Number(a.code)))
    let code = start
    while (used.has(code) && code <= end) code++
    if (code > end) return setMsg({ ok: false, text: 'หมวดในกลุ่มนี้เต็มแล้ว' })
    const { data, error } = await supabase
      .from('accounts')
      .insert({ restaurant_id: restaurantId, code: String(code), name: newCat.name.trim(), type: 'expense', grp: newCat.grp })
      .select('id')
      .single()
    if (error) return setMsg({ ok: false, text: error.code === '23505' ? 'ชื่อ/รหัสซ้ำ' : accountingError(error.message) })
    setNewCat(null)
    await load()
    setF((x) => ({ ...x, account_id: (data as { id: string }).id }))
  }

  return (
    <div>
      {msg && <p className={msg.ok ? 'alert-success' : 'alert-error'}>{msg.text}</p>}

      {canWrite ? (
        <form onSubmit={(e) => void save(e)} className="card grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="ex-cat">{"" + translateUi("หมวดรายจ่าย") + " "}<span className="text-red-600">*</span>
            </label>
            <div className="flex gap-2">
              <select id="ex-cat" className="input w-full" value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value })} required>
                <option value="">{translateUi("— เลือกหมวด —")}</option>
                {(['food_cost', 'labor', 'opex'] as const).map((g) => (
                  <optgroup key={g} label={GROUP_LABEL[g]}>
                    {cats
                      .filter((c) => c.grp === g)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
              <button type="button" className="btn btn-secondary" onClick={() => setNewCat({ name: '', grp: 'opex' })}>{"" + translateUi("+ หมวด") + " "}</button>
            </div>
          </div>
          <div>
            <label className="label" htmlFor="ex-amt">{"" + translateUi("จำนวนเงินตามใบเสร็จ (รวม VAT)") + " "}<span className="text-red-600">*</span>
            </label>
            <input id="ex-amt" className="input w-full" type="number" inputMode="decimal" min="0" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required />
          </div>
          <div>
            <label className="label" htmlFor="ex-pay">{"" + translateUi("จ่ายด้วย") + " "}</label>
            <select id="ex-pay" className="input w-full" value={f.payment} onChange={(e) => setF({ ...f, payment: e.target.value })}>
              {Object.entries(PAYMENT_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="ex-date">{"" + translateUi("วันที่จ่าย") + " "}</label>
            <input id="ex-date" className="input w-full" type="date" max={today} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} required />
          </div>
          <div>
            <label className="label" htmlFor="ex-note">{"" + translateUi("หมายเหตุ") + " "}</label>
            <input id="ex-note" className="input w-full" maxLength={300} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </div>

          {/* ----- ภาษีซื้อ / หัก ณ ที่จ่าย ----- */}
          <fieldset className="grid gap-3 rounded-xl border border-gray-200 p-3 sm:col-span-2 sm:grid-cols-2">
            <legend className="px-1 text-sm font-semibold text-gray-800">{translateUi("ภาษี")}</legend>
            {vatRegistered ? (
              <label className="flex items-start gap-2 sm:col-span-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={tax.inputTax}
                  onChange={(e) => setTax({ ...tax, inputTax: e.target.checked })}
                  aria-describedby="ex-input-tax-hint"
                />
                <span>
                  <span className="text-sm font-medium">{translateUi("มีใบกำกับภาษีเต็มรูป (ขอคืนภาษีซื้อ)")}</span>
                  <span id="ex-input-tax-hint" className="block hint">{"" + translateUi("คิด VAT") + " "}{vatRate}{"" + translateUi("% จากยอดรวมให้อัตโนมัติ · ไม่มีใบกำกับภาษีเต็มรูป = นำภาษีซื้อมาหักไม่ได้") + " "}</span>
                </span>
              </label>
            ) : (
              <p className="hint sm:col-span-2">{translateUi("ร้านยังไม่จด VAT จึงไม่มีการขอคืนภาษีซื้อ")}</p>
            )}

            <div>
              <label className="label" htmlFor="ex-wht">{"" + translateUi("หักภาษี ณ ที่จ่าย") + " "}</label>
              <select
                id="ex-wht"
                className="input w-full"
                value={tax.whtRate ?? ''}
                onChange={(e) => setTax({ ...tax, whtRate: e.target.value ? (Number(e.target.value) as WhtRate) : null })}
              >
                <option value="">{translateUi("ไม่หัก")}</option>
                {WHT_RATES.map((r) => (
                  <option key={r} value={r}>
                    {r}%{r === 1 ? ' (ค่าขนส่ง)' : r === 2 ? ' (ค่าโฆษณา)' : r === 3 ? ' (ค่าบริการ/จ้างทำของ)' : ' (ค่าเช่า)'}
                  </option>
                ))}
              </select>
            </div>
            {tax.whtRate !== null && (
              <div>
                <span className="label">{translateUi("แบบยื่น")}</span>
                <div className="flex gap-2" role="radiogroup" aria-label={translateUi("แบบยื่นภาษีหัก ณ ที่จ่าย")}>
                  {(['pnd3', 'pnd53'] as const).map((form) => (
                    <button
                      key={form}
                      type="button"
                      role="radio"
                      aria-checked={tax.whtForm === form}
                      onClick={() => setTax({ ...tax, whtForm: form })}
                      className={`flex-1 rounded-lg border px-2 py-2 text-sm ${tax.whtForm === form ? 'border-brand-500 bg-brand-50 font-semibold text-brand-700' : 'border-gray-300 bg-white text-gray-600'}`}
                    >
                      {WHT_FORM_LABEL[form]}
                    </button>
                  ))}
                </div>
                {suggestedForm && suggestedForm !== tax.whtForm && (
                  <span className="mt-1 block text-xs text-amber-700">{"" + translateUi("เลขผู้เสียภาษีนี้ต้องใช้") + " "}{WHT_FORM_SHORT[suggestedForm]}</span>
                )}
              </div>
            )}

            {showSupplier && (
              <>
                <div className="sm:col-span-2">
                  <label className="label" htmlFor="ex-sup-name">{"" + translateUi("ชื่อผู้ขาย / ผู้รับเงิน") + " "}<span className="text-red-600">*</span>
                  </label>
                  <input id="ex-sup-name" className="input w-full" maxLength={200} value={tax.supplierName} onChange={(e) => setTax({ ...tax, supplierName: e.target.value })} required />
                </div>
                <div>
                  <label className="label" htmlFor="ex-sup-tax">{"" + translateUi("เลขประจำตัวผู้เสียภาษี (13 หลัก)") + " "}<span className="text-red-600">*</span>
                  </label>
                  <input
                    id="ex-sup-tax"
                    className="input w-full tabular-nums"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={13}
                    value={tax.supplierTaxId}
                    onChange={(e) => setTaxId(e.target.value)}
                    aria-invalid={tax.supplierTaxId.length === 13 && !taxIdOk}
                    required
                  />
                  <span className={`mt-1 block text-xs ${tax.supplierTaxId.length === 13 && !taxIdOk ? 'text-red-600' : 'text-gray-500'}`}>
                    {tax.supplierTaxId.length < 13
                      ? `${tax.supplierTaxId.length}/13 หลัก`
                      : taxIdOk
                        ? `${formatTaxId(tax.supplierTaxId)} · ${whtFormFor(tax.supplierTaxId) === 'pnd53' ? 'นิติบุคคล' : 'บุคคลธรรมดา'}`
                        : 'เลขผู้เสียภาษีไม่ถูกต้อง (ตรวจหลักสุดท้าย)'}
                  </span>
                </div>
                <div>
                  <label className="label" htmlFor="ex-sup-branch">{"" + translateUi("รหัสสาขาผู้ขาย (5 หลัก)") + " "}</label>
                  <input
                    id="ex-sup-branch"
                    className="input w-full tabular-nums"
                    inputMode="numeric"
                    maxLength={5}
                    value={tax.supplierBranch}
                    onChange={(e) => setTax({ ...tax, supplierBranch: digits(e.target.value, 5) })}
                    required
                  />
                  <span className="mt-1 block hint">{branchLabel(tax.supplierBranch)}</span>
                </div>
              </>
            )}

            {inputTax && (
              <>
                <div>
                  <label className="label" htmlFor="ex-inv-no">{"" + translateUi("เลขที่ใบกำกับภาษี") + " "}<span className="text-red-600">*</span>
                  </label>
                  <input id="ex-inv-no" className="input w-full" maxLength={50} value={tax.invoiceNo} onChange={(e) => setTax({ ...tax, invoiceNo: e.target.value })} required />
                </div>
                <div>
                  <label className="label" htmlFor="ex-inv-date">{"" + translateUi("วันที่ในใบกำกับภาษี") + " "}<span className="text-red-600">*</span>
                  </label>
                  <input id="ex-inv-date" className="input w-full" type="date" max={today} value={tax.invoiceDate} onChange={(e) => setTax({ ...tax, invoiceDate: e.target.value })} required />
                </div>
              </>
            )}

            {(inputTax || tax.whtRate !== null) && (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-gray-50 p-3 text-sm sm:col-span-2" aria-live="polite">
                <dt className="text-gray-500">{translateUi("มูลค่าก่อน VAT")}</dt>
                <dd className="num">{baht(calc.base)}</dd>
                {inputTax && (
                  <>
                    <dt className="text-gray-500">{"" + translateUi("ภาษีซื้อ") + " "}{vatRate}%</dt>
                    <dd className="num">{baht(calc.vat)}</dd>
                  </>
                )}
                {tax.whtRate !== null && (
                  <>
                    <dt className="text-gray-500">{"" + translateUi("หัก ณ ที่จ่าย") + " "}{tax.whtRate}% ({WHT_FORM_SHORT[tax.whtForm]})
                    </dt>
                    <dd className="num text-red-600">−{baht(calc.wht)}</dd>
                  </>
                )}
                <dt className="font-semibold">{translateUi("จ่ายผู้ขายจริง")}</dt>
                <dd className="num font-semibold">{baht(calc.netPaid)}</dd>
              </dl>
            )}
          </fieldset>

          <div className="sm:col-span-2">
            <label className="label" htmlFor="ex-file">{"" + translateUi("รูปใบเสร็จ / ใบกำกับภาษี (ไม่บังคับ)") + " "}</label>
            <input id="ex-file" type="file" accept="image/*,application/pdf" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
          <button className="btn btn-primary sm:col-span-2" disabled={busy}>
            {busy ? 'กำลังบันทึก...' : 'บันทึกรายจ่าย'}
          </button>
        </form>
      ) : (
        <p className="note">{translateUi("ผู้จัดการดูรายจ่ายได้อย่างเดียว · บันทึกได้เฉพาะเจ้าของร้านและพนักงานบัญชี")}</p>
      )}

      {newCat && (
        <form onSubmit={(e) => void addCategory(e)} className="card mt-3 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
          <input className="input" placeholder={translateUi("ชื่อหมวดใหม่ เช่น ค่าซ่อมบำรุง")} maxLength={80} value={newCat.name} onChange={(e) => setNewCat({ ...newCat, name: e.target.value })} autoFocus required />
          <select className="input" value={newCat.grp} onChange={(e) => setNewCat({ ...newCat, grp: e.target.value })} aria-label={translateUi("กลุ่ม")}>
            {Object.entries(GROUP_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <button className="btn btn-primary">{translateUi("เพิ่มหมวด")}</button>
          <button type="button" className="btn btn-ghost" onClick={() => setNewCat(null)}>{"" + translateUi("ยกเลิก") + " "}</button>
        </form>
      )}

      <Section
        title={`รายจ่าย ${baht(total)}`}
        action={
          <div className="flex items-center gap-2 text-sm">
            <input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label={translateUi("ตั้งแต่")} />
            <span>{translateUi("ถึง")}</span>
            <input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label={translateUi("ถึง")} />
          </div>
        }
      >
        {(totalVat > 0 || totalWht > 0) && (
          <p className="mb-2 text-xs text-gray-600">{"" + translateUi("ภาษีซื้อที่มีใบกำกับ") + " "}{baht(totalVat)}{" " + translateUi("· ภาษีหัก ณ ที่จ่ายค้างนำส่ง") + " "}{baht(totalWht)}
          </p>
        )}
        <ul className="list-card">
          {rows.map((x) => (
            <li key={x.id} className={`p-3 ${x.voided_at ? 'bg-gray-50 text-gray-400' : ''}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900">
                    <span className={x.voided_at ? 'line-through' : ''}>{byId.get(x.account_id ?? '')?.name ?? 'ไม่ระบุหมวด'}</span>
                    {x.voided_at && <span className="badge badge-red ml-2">{"" + translateUi("ยกเลิก:") + " "}{x.void_reason}</span>}
                    {x.source !== 'manual' && <span className="badge badge-gray ml-2">{SOURCE_NOTE[x.source]}</span>}
                    {x.tax_invoice_no && <span className="badge badge-green ml-2">{translateUi("ใบกำกับภาษีซื้อ")}</span>}
                    {x.wht_type && <span className="badge badge-amber ml-2">{WHT_FORM_SHORT[x.wht_type]} {x.wht_rate}%</span>}
                  </div>
                  <div className="hint">
                    {x.spent_on} · {PAYMENT_LABEL[x.payment_method] ?? x.payment_method}
                    {x.vat_amount > 0 && ` · ภาษีซื้อ ${baht(x.vat_amount)}`}
                    {x.wht_amount > 0 && ` · หัก ณ ที่จ่าย ${baht(x.wht_amount)}`}
                    {x.note && ` · ${x.note}`}
                  </div>
                  {x.supplier_name && (
                    <div className="hint">
                      {x.supplier_name} · {formatTaxId(x.supplier_tax_id)} · {branchLabel(x.supplier_branch_code)}
                      {x.tax_invoice_no && ` · ใบกำกับ ${x.tax_invoice_no} (${x.tax_invoice_date})`}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className={`tabular-nums ${x.voided_at ? 'line-through' : 'font-semibold text-gray-900'}`}>{baht(x.amount)}</span>
                  {x.receipt_url && (
                    <button className="link" onClick={() => void openReceipt(x.receipt_url!)}>{"" + translateUi("ใบเสร็จ") + " "}</button>
                  )}
                  {canWrite && x.source === 'manual' && !x.voided_at && (
                    <button className="link-danger" onClick={() => setVoiding({ id: x.id, reason: '' })}>{"" + translateUi("ยกเลิก") + " "}</button>
                  )}
                </div>
              </div>
              {voiding?.id === x.id && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <input
                    className="input min-w-0 flex-1"
                    placeholder={translateUi("เหตุผลที่ยกเลิก (บังคับ)")}
                    value={voiding.reason}
                    maxLength={300}
                    onChange={(e) => setVoiding({ ...voiding, reason: e.target.value })}
                    autoFocus
                  />
                  <button className="btn btn-danger btn-sm" onClick={() => void voidExpense()}>{"" + translateUi("ยืนยันยกเลิก") + " "}</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setVoiding(null)}>{"" + translateUi("ไม่ยกเลิก") + " "}</button>
                </div>
              )}
            </li>
          ))}
          {rows.length === 0 && <li className="empty-cell">{translateUi("ยังไม่มีรายจ่ายในช่วงนี้")}</li>}
        </ul>
        <p className="mt-2 hint">{"" + translateUi("ซื้อวัตถุดิบเข้าสต็อกให้บันทึกที่ \"ใบรับของ\" (ลงเป็นสต็อก แล้วตัดเป็นต้นทุนเมื่อใช้ตามสูตร) · ของที่ไม่ได้นับสต็อก เช่น น้ำแข็ง ใช้หมวด \"วัตถุดิบนอกสต็อก\" · ภาษีหัก ณ ที่จ่ายต้องออกหนังสือรับรอง (50 ทวิ) ให้ผู้รับเงินและนำส่งภายในวันที่ 7 ของเดือนถัดไป (ยื่นออนไลน์ภายในวันที่ 15)") + " "}</p>
      </Section>
    </div>
  )
}
