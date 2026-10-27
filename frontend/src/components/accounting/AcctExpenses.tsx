// รายจ่าย: บังคับเลือกหมวด · วิธีจ่าย · แนบรูปใบเสร็จ (bucket expense-receipts) · ลงบัญชีอัตโนมัติ
// ลงแล้วแก้ยอดไม่ได้ ต้อง "ยกเลิกรายจ่าย" (กลับรายการ) แล้วบันทึกใหม่
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import { accountingError } from '../../lib/accounting'
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
}

const SOURCE_NOTE: Record<string, string> = { stock_receipt: 'จากใบรับของ (ลงเป็นสต็อก)', legacy: 'ก่อนเปิดโมดูลบัญชี' }

export default function AcctExpenses({
  restaurantId,
  today,
  canWrite,
  vatRegistered,
  onChanged,
}: {
  restaurantId: string
  today: string
  canWrite: boolean
  vatRegistered: boolean
  onChanged: () => void
}) {
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [rows, setRows] = useState<Expense[]>([])
  const [from, setFrom] = useState(monthStart(today))
  const [to, setTo] = useState(today)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [f, setF] = useState({ account_id: '', amount: '', vat: '', payment: 'cash', date: today, note: '' })
  const [file, setFile] = useState<File | null>(null)
  const [voiding, setVoiding] = useState<{ id: string; reason: string } | null>(null)
  const [newCat, setNewCat] = useState<{ name: string; grp: string } | null>(null)

  const load = useCallback(async () => {
    const [a, e] = await Promise.all([
      supabase.from('accounts').select('id,code,name,type,grp,system_key,is_active').eq('restaurant_id', restaurantId).order('code'),
      supabase
        .from('expenses')
        .select('id,spent_on,amount,vat_amount,payment_method,note,receipt_url,source,voided_at,void_reason,account_id')
        .eq('restaurant_id', restaurantId)
        .gte('spent_on', from)
        .lte('spent_on', to)
        .order('spent_on', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(500),
    ])
    if (a.error || e.error) return setMsg({ ok: false, text: 'โหลดรายจ่ายไม่สำเร็จ (ต้องรัน migration 0026)' })
    setAccounts((a.data ?? []) as AccountRow[])
    setRows(((e.data ?? []) as Expense[]).map((x) => ({ ...x, amount: Number(x.amount), vat_amount: Number(x.vat_amount) })))
  }, [restaurantId, from, to])

  useEffect(() => {
    void load()
  }, [load])

  const cats = useMemo(() => expenseCategories(accounts), [accounts])
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
  const total = rows.filter((r) => !r.voided_at).reduce((s, r) => s + r.amount, 0)

  async function save(e: FormEvent) {
    e.preventDefault()
    const amount = Number(f.amount)
    const vat = Number(f.vat || 0)
    if (!f.account_id) return setMsg({ ok: false, text: 'ต้องเลือกหมวดรายจ่าย' })
    if (!(amount > 0)) return setMsg({ ok: false, text: 'กรอกจำนวนเงินที่มากกว่า 0' })
    if (vat < 0 || vat > amount) return setMsg({ ok: false, text: 'ภาษีซื้อต้องไม่เกินยอดที่จ่าย' })
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
    const { error } = await supabase.from('expenses').insert({
      restaurant_id: restaurantId,
      category: 'other', // ฐานข้อมูลตั้งหมวดแบบเดิมจากบัญชีให้
      account_id: f.account_id,
      amount,
      vat_amount: vat,
      payment_method: f.payment,
      spent_on: f.date,
      note: f.note.trim() || null,
      receipt_url: path,
    })
    setBusy(false)
    if (error) {
      if (path) void supabase.storage.from(RECEIPT_BUCKET).remove([path])
      return setMsg({ ok: false, text: accountingError(error.message) })
    }
    setMsg({ ok: true, text: `บันทึก ${byId.get(f.account_id)?.name ?? 'รายจ่าย'} ${baht(amount)} แล้ว` })
    setF({ ...f, amount: '', vat: '', note: '' })
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
            <label className="label" htmlFor="ex-cat">
              หมวดรายจ่าย <span className="text-red-600">*</span>
            </label>
            <div className="flex gap-2">
              <select id="ex-cat" className="input w-full" value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value })} required>
                <option value="">— เลือกหมวด —</option>
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
              <button type="button" className="btn btn-secondary" onClick={() => setNewCat({ name: '', grp: 'opex' })}>
                + หมวด
              </button>
            </div>
          </div>
          <div>
            <label className="label" htmlFor="ex-amt">
              จำนวนเงินที่จ่าย (บาท) <span className="text-red-600">*</span>
            </label>
            <input id="ex-amt" className="input w-full" type="number" inputMode="decimal" min="0" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required />
          </div>
          <div>
            <label className="label" htmlFor="ex-pay">
              จ่ายด้วย
            </label>
            <select id="ex-pay" className="input w-full" value={f.payment} onChange={(e) => setF({ ...f, payment: e.target.value })}>
              {Object.entries(PAYMENT_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="ex-date">
              วันที่จ่าย
            </label>
            <input id="ex-date" className="input w-full" type="date" max={today} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} required />
          </div>
          {vatRegistered && (
            <div>
              <label className="label" htmlFor="ex-vat">
                ภาษีซื้อในใบกำกับ (บาท)
              </label>
              <input id="ex-vat" className="input w-full" type="number" inputMode="decimal" min="0" step="0.01" value={f.vat} onChange={(e) => setF({ ...f, vat: e.target.value })} />
            </div>
          )}
          <div className={vatRegistered ? 'sm:col-span-2' : ''}>
            <label className="label" htmlFor="ex-note">
              หมายเหตุ
            </label>
            <input id="ex-note" className="input w-full" maxLength={300} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="ex-file">
              รูปใบเสร็จ (ไม่บังคับ)
            </label>
            <input id="ex-file" type="file" accept="image/*,application/pdf" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
          <button className="btn btn-primary sm:col-span-2" disabled={busy}>
            {busy ? 'กำลังบันทึก...' : 'บันทึกรายจ่าย'}
          </button>
        </form>
      ) : (
        <p className="note">ผู้จัดการดูรายจ่ายได้อย่างเดียว · บันทึกได้เฉพาะเจ้าของร้านและพนักงานบัญชี</p>
      )}

      {newCat && (
        <form onSubmit={(e) => void addCategory(e)} className="card mt-3 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
          <input className="input" placeholder="ชื่อหมวดใหม่ เช่น ค่าซ่อมบำรุง" maxLength={80} value={newCat.name} onChange={(e) => setNewCat({ ...newCat, name: e.target.value })} autoFocus required />
          <select className="input" value={newCat.grp} onChange={(e) => setNewCat({ ...newCat, grp: e.target.value })} aria-label="กลุ่ม">
            {Object.entries(GROUP_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <button className="btn btn-primary">เพิ่มหมวด</button>
          <button type="button" className="btn btn-ghost" onClick={() => setNewCat(null)}>
            ยกเลิก
          </button>
        </form>
      )}

      <Section
        title={`รายจ่าย ${baht(total)}`}
        action={
          <div className="flex items-center gap-2 text-sm">
            <input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="ตั้งแต่" />
            <span>ถึง</span>
            <input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="ถึง" />
          </div>
        }
      >
        <ul className="card-flush divide-y text-sm">
          {rows.map((x) => (
            <li key={x.id} className={`p-3 ${x.voided_at ? 'bg-gray-50 text-gray-400' : ''}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900">
                    <span className={x.voided_at ? 'line-through' : ''}>{byId.get(x.account_id ?? '')?.name ?? 'ไม่ระบุหมวด'}</span>
                    {x.voided_at && <span className="badge badge-red ml-2">ยกเลิก: {x.void_reason}</span>}
                    {x.source !== 'manual' && <span className="badge badge-gray ml-2">{SOURCE_NOTE[x.source]}</span>}
                  </div>
                  <div className="text-xs text-gray-500">
                    {x.spent_on} · {PAYMENT_LABEL[x.payment_method] ?? x.payment_method}
                    {x.vat_amount > 0 && ` · ภาษีซื้อ ${baht(x.vat_amount)}`}
                    {x.note && ` · ${x.note}`}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`tabular-nums ${x.voided_at ? 'line-through' : 'font-semibold text-gray-900'}`}>{baht(x.amount)}</span>
                  {x.receipt_url && (
                    <button className="link" onClick={() => void openReceipt(x.receipt_url!)}>
                      ใบเสร็จ
                    </button>
                  )}
                  {canWrite && x.source === 'manual' && !x.voided_at && (
                    <button className="link-danger" onClick={() => setVoiding({ id: x.id, reason: '' })}>
                      ยกเลิก
                    </button>
                  )}
                </div>
              </div>
              {voiding?.id === x.id && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <input
                    className="input min-w-0 flex-1"
                    placeholder="เหตุผลที่ยกเลิก (บังคับ)"
                    value={voiding.reason}
                    maxLength={300}
                    onChange={(e) => setVoiding({ ...voiding, reason: e.target.value })}
                    autoFocus
                  />
                  <button className="btn btn-danger btn-sm" onClick={() => void voidExpense()}>
                    ยืนยันยกเลิก
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setVoiding(null)}>
                    ไม่ยกเลิก
                  </button>
                </div>
              )}
            </li>
          ))}
          {rows.length === 0 && <li className="p-6 text-center text-gray-400">ยังไม่มีรายจ่ายในช่วงนี้</li>}
        </ul>
        <p className="mt-2 text-xs text-gray-500">
          ซื้อวัตถุดิบเข้าสต็อกให้บันทึกที่ "ใบรับของ" (ลงเป็นสต็อก แล้วตัดเป็นต้นทุนเมื่อใช้ตามสูตร) · ของที่ไม่ได้นับสต็อก เช่น น้ำแข็ง ใช้หมวด "วัตถุดิบนอกสต็อก"
        </p>
      </Section>
    </div>
  )
}
