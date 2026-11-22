import { translateUi } from "../../lib/uiText"
// ตั้งค่าบัญชี: โหมดเริ่มต้น จด VAT เป้า Food/Prime Cost ใบรับของจ่ายด้วยอะไร · ยอดยกมา · รายได้ตามหมวดเมนู
// ผังบัญชี (เพิ่ม/ปิดหมวดเอง) · จ่ายเจ้าหนี้ · ข้อมูลผู้ประกอบการ (ใบกำกับภาษี) · เครื่อง POS + เลขอนุมัติกรมสรรพากร
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import {
  EMPTY_TAX_SETTINGS,
  MODE_LABEL,
  TERMINAL_CODE_RE,
  accountingError,
  taxSettingsRow,
  validatePosRegNo,
  validateTaxSettings,
  type AccountingMode,
  type AccountingSettings,
  type TaxSettingsForm,
} from '../../lib/accounting'
import { dbMessage, formatTaxId } from '../../lib/tax'
import { baht } from '../../lib/format'
import { GROUP_LABEL, Section, type AccountRow } from './ui'

const TYPE_LABEL: Record<string, string> = { asset: 'สินทรัพย์', liability: 'หนี้สิน', equity: 'ทุน', revenue: 'รายได้', expense: 'ค่าใช้จ่าย' }

interface Category {
  id: string
  name: string
  revenue_account_id: string | null
}

interface Terminal {
  id: string
  terminal_code: string
  name: string
  pos_reg_no: string | null
  is_active: boolean
}

const digits = (v: string, max: number) => v.replace(/\D/g, '').slice(0, max)

export default function AcctSettings({
  restaurantId,
  settings,
  isOwner,
  canWrite,
  onSaved,
}: {
  restaurantId: string
  settings: AccountingSettings
  isOwner: boolean
  canWrite: boolean
  onSaved: () => void
}) {
  const [f, setF] = useState(settings)
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [balances, setBalances] = useState<Record<string, number>>({})
  const [cats, setCats] = useState<Category[]>([])
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [opening, setOpening] = useState({ cash: '', bank: '' })
  const [pay, setPay] = useState({ amount: '', method: 'bank', supplier: '' })
  const [tax, setTax] = useState<TaxSettingsForm>(EMPTY_TAX_SETTINGS)
  const [taxSaved, setTaxSaved] = useState(false)
  const [terminals, setTerminals] = useState<Terminal[]>([])
  const [regDraft, setRegDraft] = useState<Record<string, string>>({})
  const [newTerm, setNewTerm] = useState({ code: '', name: '', reg: '' })
  const canEditTax = canWrite // RLS tax_settings: owner / accountant · pos_terminals: owner / manager

  useEffect(() => setF(settings), [settings])

  const load = useCallback(async () => {
    const today = new Date().toLocaleDateString('sv-SE')
    const [a, c, t, ts, pt] = await Promise.all([
      supabase.from('accounts').select('id,code,name,type,grp,system_key,is_active').eq('restaurant_id', restaurantId).order('code'),
      supabase.from('menu_categories').select('id,name,revenue_account_id').eq('restaurant_id', restaurantId).order('sort_order'),
      supabase.rpc('acct_trial_balance_export', { p_restaurant_id: restaurantId, p_from: today, p_to: today }),
      supabase
        .from('tax_settings')
        .select('tax_id,company_name,branch_code,branch_name,registered_address,postcode')
        .eq('restaurant_id', restaurantId)
        .maybeSingle(),
      supabase.from('pos_terminals').select('id,terminal_code,name,pos_reg_no,is_active').eq('restaurant_id', restaurantId).order('terminal_code'),
    ])
    setAccounts((a.data ?? []) as AccountRow[])
    setCats((c.data ?? []) as Category[])
    setBalances(Object.fromEntries(((t.data ?? []) as { account_id: string; closing: number }[]).map((r) => [r.account_id, Number(r.closing)])))
    const tsRow = ts.error ? null : (ts.data as Record<string, string | null> | null)
    setTaxSaved(Boolean(tsRow))
    setTax(
      tsRow
        ? {
            tax_id: tsRow.tax_id ?? '',
            company_name: tsRow.company_name ?? '',
            branch_code: tsRow.branch_code ?? '00000',
            branch_name: tsRow.branch_name ?? '',
            registered_address: tsRow.registered_address ?? '',
            postcode: tsRow.postcode ?? '',
          }
        : EMPTY_TAX_SETTINGS,
    )
    const terms = pt.error ? [] : ((pt.data ?? []) as Terminal[])
    setTerminals(terms)
    setRegDraft(Object.fromEntries(terms.map((x) => [x.id, x.pos_reg_no ?? ''])))
  }, [restaurantId])

  useEffect(() => {
    void load()
  }, [load])

  const salesAccounts = useMemo(() => accounts.filter((a) => a.grp === 'sales' && a.is_active), [accounts])
  const ap = accounts.find((a) => a.system_key === 'ap')
  const apBalance = ap ? -(balances[ap.id] ?? 0) : 0

  async function save(e: FormEvent) {
    e.preventDefault()
    if (f.food_cost_target_min > f.food_cost_target_max || f.prime_cost_target_min > f.prime_cost_target_max) {
      return setMsg({ ok: false, text: 'เป้าต่ำสุดต้องไม่เกินเป้าสูงสุด' })
    }
    const { error } = await supabase.from('shop_settings').upsert({
      restaurant_id: restaurantId,
      accounting_mode: f.accounting_mode,
      business_type: f.business_type,
      vat_registered: f.vat_registered,
      vat_rate: f.vat_rate,
      receipt_payment_default: f.receipt_payment_default,
      food_cost_target_min: f.food_cost_target_min,
      food_cost_target_max: f.food_cost_target_max,
      prime_cost_target_min: f.prime_cost_target_min,
      prime_cost_target_max: f.prime_cost_target_max,
      updated_at: new Date().toISOString(),
    })
    setMsg(error ? { ok: false, text: error.message } : { ok: true, text: 'บันทึกตั้งค่าบัญชีแล้ว' })
    if (!error) onSaved()
  }

  async function saveOpening(e: FormEvent) {
    e.preventDefault()
    const { error } = await supabase.rpc('acct_set_opening', { p_restaurant_id: restaurantId, p_cash: Number(opening.cash || 0), p_bank: Number(opening.bank || 0) })
    setMsg(error ? { ok: false, text: accountingError(error.message) } : { ok: true, text: 'ลงยอดยกมาแล้ว (Cr ทุนเจ้าของ)' })
    if (!error) {
      setOpening({ cash: '', bank: '' })
      void load()
      onSaved()
    }
  }

  async function paySupplier(e: FormEvent) {
    e.preventDefault()
    const { error } = await supabase.rpc('acct_pay_supplier', {
      p_restaurant_id: restaurantId,
      p_amount: Number(pay.amount),
      p_payment_method: pay.method,
      p_supplier: pay.supplier.trim() || null,
    })
    setMsg(error ? { ok: false, text: accountingError(error.message) } : { ok: true, text: `จ่ายเจ้าหนี้ ${baht(Number(pay.amount))} แล้ว` })
    if (!error) {
      setPay({ ...pay, amount: '', supplier: '' })
      void load()
      onSaved()
    }
  }

  async function saveTax(e: FormEvent) {
    e.preventDefault()
    const invalid = validateTaxSettings(tax)
    if (invalid) return setMsg({ ok: false, text: invalid })
    const row = taxSettingsRow(restaurantId, tax)
    const { restaurant_id: _rid, ...patch } = row
    void _rid
    const { error } = taxSaved
      ? await supabase.from('tax_settings').update(patch).eq('restaurant_id', restaurantId)
      : await supabase.from('tax_settings').insert(row)
    if (error) return setMsg({ ok: false, text: dbMessage(error.message) })
    setMsg({ ok: true, text: 'บันทึกข้อมูลผู้ประกอบการแล้ว (มีผลกับเอกสารที่ยืนยันหลังจากนี้)' })
    void load()
  }

  async function saveRegNo(term: Terminal) {
    const value = (regDraft[term.id] ?? '').trim()
    const invalid = validatePosRegNo(value)
    if (invalid) return setMsg({ ok: false, text: invalid })
    const { error } = await supabase.from('pos_terminals').update({ pos_reg_no: value || null }).eq('id', term.id)
    if (error) return setMsg({ ok: false, text: error.code === '23505' ? 'เลขอนุมัตินี้ใช้กับเครื่องอื่นแล้ว' : dbMessage(error.message) })
    setMsg({ ok: true, text: `บันทึกเลขอนุมัติเครื่อง ${term.terminal_code} แล้ว` })
    void load()
  }

  async function toggleTerminal(term: Terminal) {
    const { error } = await supabase.from('pos_terminals').update({ is_active: !term.is_active }).eq('id', term.id)
    if (error) return setMsg({ ok: false, text: dbMessage(error.message) })
    void load()
  }

  async function addTerminal(e: FormEvent) {
    e.preventDefault()
    const code = newTerm.code.trim().toUpperCase()
    if (!TERMINAL_CODE_RE.test(code)) return setMsg({ ok: false, text: 'รหัสเครื่องใช้ A-Z 0-9 ไม่เกิน 10 ตัว (เช่น POS01)' })
    if (!newTerm.name.trim()) return setMsg({ ok: false, text: 'กรอกชื่อเครื่อง' })
    const invalid = validatePosRegNo(newTerm.reg)
    if (invalid) return setMsg({ ok: false, text: invalid })
    const { error } = await supabase
      .from('pos_terminals')
      .insert({ restaurant_id: restaurantId, terminal_code: code, name: newTerm.name.trim().slice(0, 80), pos_reg_no: newTerm.reg.trim() || null })
    if (error) return setMsg({ ok: false, text: error.code === '23505' ? 'รหัสเครื่องหรือเลขอนุมัตินี้มีอยู่แล้ว' : dbMessage(error.message) })
    setNewTerm({ code: '', name: '', reg: '' })
    setMsg({ ok: true, text: `เพิ่มเครื่อง ${code} แล้ว` })
    void load()
  }

  async function setRevenue(catId: string, accountId: string) {
    const { error } = await supabase.from('menu_categories').update({ revenue_account_id: accountId || null }).eq('id', catId)
    if (error) return setMsg({ ok: false, text: error.message })
    setCats((cs) => cs.map((c) => (c.id === catId ? { ...c, revenue_account_id: accountId || null } : c)))
  }

  async function toggle(a: AccountRow) {
    const { error } = await supabase.from('accounts').update({ is_active: !a.is_active }).eq('id', a.id)
    if (error) return setMsg({ ok: false, text: accountingError(error.message) })
    void load()
  }

  const numIn = (k: keyof AccountingSettings, label: string) => (
    <label className="block">
      <span className="label">{label}</span>
      <input
        className="input w-full"
        type="number"
        min="0"
        max="100"
        step="0.5"
        value={f[k] as number}
        disabled={!isOwner}
        onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })}
      />
    </label>
  )

  return (
    <div>
      {msg && <p className={msg.ok ? 'alert-success' : 'alert-error'}>{msg.text}</p>}
      {!isOwner && <p className="note mb-4">{translateUi("แก้ตั้งค่าบัญชีได้เฉพาะเจ้าของร้าน")}</p>}

      <form onSubmit={(e) => void save(e)} className="card grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="label">{translateUi("โหมดแสดงผลเริ่มต้นของร้าน")}</span>
          <select className="input w-full" value={f.accounting_mode} disabled={!isOwner} onChange={(e) => setF({ ...f, accounting_mode: e.target.value as AccountingMode })}>
            {(Object.keys(MODE_LABEL) as AccountingMode[]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">{translateUi("รูปแบบธุรกิจ")}</span>
          <select className="input w-full" value={f.business_type} disabled={!isOwner} onChange={(e) => setF({ ...f, business_type: e.target.value as AccountingSettings['business_type'] })}>
            <option value="individual">{translateUi("บุคคลธรรมดา")}</option>
            <option value="company">{translateUi("นิติบุคคล (บริษัท/หจก.)")}</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={f.vat_registered} disabled={!isOwner} onChange={(e) => setF({ ...f, vat_registered: e.target.checked })} />
          <span className="text-sm">{translateUi("จดทะเบียนภาษีมูลค่าเพิ่ม (ราคาขายรวม VAT แล้ว)")}</span>
        </label>
        {f.vat_registered && numIn('vat_rate', 'อัตรา VAT (%)')}
        <label className="block sm:col-span-2">
          <span className="label">{translateUi("ใบรับของ (ซื้อวัตถุดิบ) จ่ายด้วย")}</span>
          <select
            className="input w-full"
            value={f.receipt_payment_default}
            disabled={!isOwner}
            onChange={(e) => setF({ ...f, receipt_payment_default: e.target.value as AccountingSettings['receipt_payment_default'] })}
          >
            <option value="cash">{translateUi("เงินสด")}</option>
            <option value="bank">{translateUi("โอน/QR")}</option>
            <option value="credit">{translateUi("ค้างจ่าย (เจ้าหนี้การค้า)")}</option>
          </select>
        </label>
        {numIn('food_cost_target_min', 'เป้า Food Cost ต่ำสุด (%)')}
        {numIn('food_cost_target_max', 'เป้า Food Cost สูงสุด (%)')}
        {numIn('prime_cost_target_min', 'เป้า Prime Cost ต่ำสุด (%)')}
        {numIn('prime_cost_target_max', 'เป้า Prime Cost สูงสุด (%)')}
        {isOwner && <button className="btn btn-primary sm:col-span-2">{translateUi("บันทึกตั้งค่า")}</button>}
      </form>

      <Section title={translateUi("ข้อมูลผู้ประกอบการ (พิมพ์บนใบกำกับภาษีและรายงานภาษี)")}>
        {!f.vat_registered && <p className="note mb-3">{translateUi("ร้านยังไม่ได้ตั้งค่าจด VAT · ออกใบกำกับภาษีได้หลังเปิด \"จดทะเบียนภาษีมูลค่าเพิ่ม\" ด้านบน")}</p>}
        <form onSubmit={(e) => void saveTax(e)} className="card grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="label">{"" + translateUi("เลขประจำตัวผู้เสียภาษีอากร (13 หลัก)") + " "}<span className="text-red-600">*</span>
            </span>
            <input
              className="input w-full tabular-nums"
              inputMode="numeric"
              autoComplete="off"
              maxLength={13}
              value={tax.tax_id}
              disabled={!canEditTax}
              onChange={(e) => setTax({ ...tax, tax_id: digits(e.target.value, 13) })}
              required
            />
            <span className="mt-1 block hint">{tax.tax_id.length === 13 ? formatTaxId(tax.tax_id) : `${tax.tax_id.length}/13 หลัก`}</span>
          </label>
          <label className="block">
            <span className="label">{"" + translateUi("ชื่อผู้ประกอบการ / บริษัท") + " "}<span className="text-red-600">*</span>
            </span>
            <input className="input w-full" maxLength={200} value={tax.company_name} disabled={!canEditTax} onChange={(e) => setTax({ ...tax, company_name: e.target.value })} required />
          </label>
          <label className="block">
            <span className="label">{"" + translateUi("รหัสสาขา (5 หลัก)") + " "}<span className="text-red-600">*</span>
            </span>
            <input
              className="input w-full tabular-nums"
              inputMode="numeric"
              maxLength={5}
              value={tax.branch_code}
              disabled={!canEditTax}
              onChange={(e) => setTax({ ...tax, branch_code: digits(e.target.value, 5) })}
              required
            />
            <span className="mt-1 block hint">{translateUi("00000 = สำนักงานใหญ่")}</span>
          </label>
          <label className="block">
            <span className="label">{translateUi("ชื่อสาขา (ถ้ามี)")}</span>
            <input className="input w-full" maxLength={100} value={tax.branch_name} disabled={!canEditTax} onChange={(e) => setTax({ ...tax, branch_name: e.target.value })} />
          </label>
          <label className="block sm:col-span-2">
            <span className="label">{"" + translateUi("ที่อยู่ตามที่จดทะเบียน") + " "}<span className="text-red-600">*</span>
            </span>
            <textarea
              className="input w-full"
              rows={2}
              maxLength={500}
              value={tax.registered_address}
              disabled={!canEditTax}
              onChange={(e) => setTax({ ...tax, registered_address: e.target.value })}
              required
            />
          </label>
          <label className="block">
            <span className="label">{translateUi("รหัสไปรษณีย์")}</span>
            <input
              className="input w-full tabular-nums"
              inputMode="numeric"
              maxLength={5}
              value={tax.postcode}
              disabled={!canEditTax}
              onChange={(e) => setTax({ ...tax, postcode: digits(e.target.value, 5) })}
            />
          </label>
          {canEditTax ? (
            <button className="btn btn-primary self-end">{taxSaved ? 'บันทึกข้อมูลผู้ประกอบการ' : 'เพิ่มข้อมูลผู้ประกอบการ'}</button>
          ) : (
            <p className="self-end hint">{translateUi("แก้ได้เฉพาะเจ้าของร้านและพนักงานบัญชี")}</p>
          )}
        </form>
        <p className="mt-2 hint">{translateUi("เอกสารที่ยืนยันแล้วเก็บข้อมูลผู้ขาย ณ วันที่ออก การแก้ที่นี่ไม่เปลี่ยนเอกสารเก่า")}</p>
      </Section>

      <Section title={translateUi("เครื่อง POS และเลขอนุมัติจากกรมสรรพากร")}>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th className="text-left">{translateUi("รหัส")}</th>
                <th className="text-left">{translateUi("ชื่อเครื่อง")}</th>
                <th className="text-left">{translateUi("เลขอนุมัติเครื่อง POS (RD)")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {terminals.map((x) => (
                <tr key={x.id} className={`border-t ${x.is_active ? '' : 'text-gray-400'}`}>
                  <td className="font-mono">{x.terminal_code}</td>
                  <td>
                    {x.name}
                    {!x.is_active && <span className="badge badge-gray ml-2">{translateUi("ปิดใช้")}</span>}
                  </td>
                  <td>
                    {isOwner ? (
                      <div className="flex gap-2">
                        <input
                          className="input min-w-0 flex-1 font-mono"
                          maxLength={30}
                          placeholder={translateUi("ยังไม่มีเลขอนุมัติ")}
                          value={regDraft[x.id] ?? ''}
                          onChange={(e) => setRegDraft({ ...regDraft, [x.id]: e.target.value })}
                          aria-label={`เลขอนุมัติเครื่อง ${x.terminal_code}`}
                        />
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={(regDraft[x.id] ?? '').trim() === (x.pos_reg_no ?? '')}
                          onClick={() => void saveRegNo(x)}
                        >{"" + translateUi("บันทึก") + " "}</button>
                      </div>
                    ) : (
                      <span className="font-mono">{x.pos_reg_no ?? '—'}</span>
                    )}
                  </td>
                  <td className="text-right">
                    {isOwner && (
                      <button type="button" className="link-muted" onClick={() => void toggleTerminal(x)}>
                        {x.is_active ? 'ปิดใช้' : 'เปิดใช้'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {terminals.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty-cell">{"" + translateUi("ยังไม่มีเครื่อง POS") + " "}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {isOwner && (
          <form onSubmit={(e) => void addTerminal(e)} className="card mt-3 grid gap-2 sm:grid-cols-[8rem_1fr_1fr_auto]">
            <input
              className="input font-mono uppercase"
              placeholder={translateUi("รหัส เช่น POS01")}
              maxLength={10}
              value={newTerm.code}
              onChange={(e) => setNewTerm({ ...newTerm, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })}
              aria-label={translateUi("รหัสเครื่อง")}
              required
            />
            <input
              className="input"
              placeholder={translateUi("ชื่อเครื่อง เช่น แคชเชียร์หน้าร้าน")}
              maxLength={80}
              value={newTerm.name}
              onChange={(e) => setNewTerm({ ...newTerm, name: e.target.value })}
              aria-label={translateUi("ชื่อเครื่อง")}
              required
            />
            <input
              className="input font-mono"
              placeholder={translateUi("เลขอนุมัติ RD (ถ้ามี)")}
              maxLength={30}
              value={newTerm.reg}
              onChange={(e) => setNewTerm({ ...newTerm, reg: e.target.value })}
              aria-label={translateUi("เลขอนุมัติเครื่อง POS")}
            />
            <button className="btn btn-secondary">{translateUi("+ เพิ่มเครื่อง")}</button>
          </form>
        )}
        <p className="mt-2 hint">{"" + translateUi("ใบกำกับภาษีอย่างย่อ (ABB) ออกได้เฉพาะเครื่องที่มีเลขอนุมัติ · รหัสเครื่องใช้ในเลขที่เอกสาร เปลี่ยนไม่ได้หลังออกเอกสารแล้ว") + " "}</p>
      </Section>

      <Section title={translateUi("รายได้ตามหมวดเมนู")}>
        <ul className="list-card">
          {cats.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span>{c.name}</span>
              <select className="input" value={c.revenue_account_id ?? ''} disabled={!isOwner} onChange={(e) => void setRevenue(c.id, e.target.value)} aria-label={`บัญชีรายได้ของ ${c.name}`}>
                <option value="">{translateUi("รายได้ขายอาหาร (ค่าเริ่มต้น)")}</option>
                {salesAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </li>
          ))}
          {cats.length === 0 && <li className="empty-cell">{translateUi("ยังไม่มีหมวดเมนู")}</li>}
        </ul>
      </Section>

      {isOwner && (
        <Section title={translateUi("ยอดยกมา (เงินสด / ธนาคาร ตอนเริ่มใช้ระบบ)")}>
          <form onSubmit={(e) => void saveOpening(e)} className="card grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <input className="input" type="number" min="0" step="0.01" placeholder={translateUi("เงินสดในลิ้นชัก")} value={opening.cash} onChange={(e) => setOpening({ ...opening, cash: e.target.value })} />
            <input className="input" type="number" min="0" step="0.01" placeholder={translateUi("เงินในบัญชีธนาคาร")} value={opening.bank} onChange={(e) => setOpening({ ...opening, bank: e.target.value })} />
            <button className="btn btn-secondary" disabled={!opening.cash && !opening.bank}>{"" + translateUi("ลงยอดยกมา") + " "}</button>
          </form>
          <p className="mt-2 hint">{translateUi("สต็อกวัตถุดิบที่มีอยู่ลงเป็นยอดยกมาให้อัตโนมัติแล้ว")}</p>
        </Section>
      )}

      {canWrite && (
        <Section title={`เจ้าหนี้การค้าคงค้าง ${baht(apBalance)}`}>
          <form onSubmit={(e) => void paySupplier(e)} className="card grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
            <input className="input" placeholder={translateUi("ผู้ขาย")} maxLength={100} value={pay.supplier} onChange={(e) => setPay({ ...pay, supplier: e.target.value })} />
            <input className="input" type="number" min="0" step="0.01" placeholder={translateUi("จำนวนเงิน")} value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} required />
            <select className="input" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })} aria-label={translateUi("จ่ายด้วย")}>
              <option value="bank">{translateUi("โอน/QR")}</option>
              <option value="cash">{translateUi("เงินสด")}</option>
            </select>
            <button className="btn btn-secondary">{translateUi("จ่ายเจ้าหนี้")}</button>
          </form>
        </Section>
      )}

      <Section title={translateUi("ผังบัญชี")}>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th className="text-left">{translateUi("รหัส")}</th>
                <th className="text-left">{translateUi("ชื่อบัญชี")}</th>
                <th className="text-left">{translateUi("ประเภท")}</th>
                <th className="text-right">{translateUi("คงเหลือวันนี้")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className={`border-t ${a.is_active ? '' : 'text-gray-400'}`}>
                  <td className="tabular-nums">{a.code}</td>
                  <td>
                    {a.name}
                    {a.system_key && <span className="badge badge-gray ml-2">{translateUi("ระบบ")}</span>}
                  </td>
                  <td>
                    {TYPE_LABEL[a.type]}
                    {GROUP_LABEL[a.grp] && ` · ${GROUP_LABEL[a.grp]}`}
                  </td>
                  <td className="num">{baht(Math.abs(balances[a.id] ?? 0))}</td>
                  <td className="text-right">
                    {canWrite && !a.system_key && (
                      <button className="link-muted" onClick={() => void toggle(a)}>
                        {a.is_active ? 'ปิดใช้' : 'เปิดใช้'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 hint">{translateUi("เพิ่มหมวดรายจ่ายของร้านเองได้ที่แท็บ \"รายจ่าย\" (ปุ่ม + หมวด)")}</p>
      </Section>
    </div>
  )
}
