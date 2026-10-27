// ตั้งค่าบัญชี: โหมดเริ่มต้น จด VAT เป้า Food/Prime Cost ใบรับของจ่ายด้วยอะไร · ยอดยกมา · รายได้ตามหมวดเมนู
// ผังบัญชี (เพิ่ม/ปิดหมวดเอง) · จ่ายเจ้าหนี้
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import { MODE_LABEL, accountingError, type AccountingMode, type AccountingSettings } from '../../lib/accounting'
import { baht } from '../../lib/format'
import { GROUP_LABEL, Section, type AccountRow } from './ui'

const TYPE_LABEL: Record<string, string> = { asset: 'สินทรัพย์', liability: 'หนี้สิน', equity: 'ทุน', revenue: 'รายได้', expense: 'ค่าใช้จ่าย' }

interface Category {
  id: string
  name: string
  revenue_account_id: string | null
}

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

  useEffect(() => setF(settings), [settings])

  const load = useCallback(async () => {
    const today = new Date().toLocaleDateString('sv-SE')
    const [a, c, t] = await Promise.all([
      supabase.from('accounts').select('id,code,name,type,grp,system_key,is_active').eq('restaurant_id', restaurantId).order('code'),
      supabase.from('menu_categories').select('id,name,revenue_account_id').eq('restaurant_id', restaurantId).order('sort_order'),
      supabase.rpc('acct_trial_balance', { p_restaurant_id: restaurantId, p_from: today, p_to: today }),
    ])
    setAccounts((a.data ?? []) as AccountRow[])
    setCats((c.data ?? []) as Category[])
    setBalances(Object.fromEntries(((t.data ?? []) as { account_id: string; closing: number }[]).map((r) => [r.account_id, Number(r.closing)])))
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
      {!isOwner && <p className="note mb-4">แก้ตั้งค่าบัญชีได้เฉพาะเจ้าของร้าน</p>}

      <form onSubmit={(e) => void save(e)} className="card grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="label">โหมดแสดงผลเริ่มต้นของร้าน</span>
          <select className="input w-full" value={f.accounting_mode} disabled={!isOwner} onChange={(e) => setF({ ...f, accounting_mode: e.target.value as AccountingMode })}>
            {(Object.keys(MODE_LABEL) as AccountingMode[]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">รูปแบบธุรกิจ</span>
          <select className="input w-full" value={f.business_type} disabled={!isOwner} onChange={(e) => setF({ ...f, business_type: e.target.value as AccountingSettings['business_type'] })}>
            <option value="individual">บุคคลธรรมดา</option>
            <option value="company">นิติบุคคล (บริษัท/หจก.)</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={f.vat_registered} disabled={!isOwner} onChange={(e) => setF({ ...f, vat_registered: e.target.checked })} />
          <span className="text-sm">จดทะเบียนภาษีมูลค่าเพิ่ม (ราคาขายรวม VAT แล้ว)</span>
        </label>
        {f.vat_registered && numIn('vat_rate', 'อัตรา VAT (%)')}
        <label className="block sm:col-span-2">
          <span className="label">ใบรับของ (ซื้อวัตถุดิบ) จ่ายด้วย</span>
          <select
            className="input w-full"
            value={f.receipt_payment_default}
            disabled={!isOwner}
            onChange={(e) => setF({ ...f, receipt_payment_default: e.target.value as AccountingSettings['receipt_payment_default'] })}
          >
            <option value="cash">เงินสด</option>
            <option value="bank">โอน/QR</option>
            <option value="credit">ค้างจ่าย (เจ้าหนี้การค้า)</option>
          </select>
        </label>
        {numIn('food_cost_target_min', 'เป้า Food Cost ต่ำสุด (%)')}
        {numIn('food_cost_target_max', 'เป้า Food Cost สูงสุด (%)')}
        {numIn('prime_cost_target_min', 'เป้า Prime Cost ต่ำสุด (%)')}
        {numIn('prime_cost_target_max', 'เป้า Prime Cost สูงสุด (%)')}
        {isOwner && <button className="btn btn-primary sm:col-span-2">บันทึกตั้งค่า</button>}
      </form>

      <Section title="รายได้ตามหมวดเมนู">
        <ul className="card-flush divide-y text-sm">
          {cats.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span>{c.name}</span>
              <select className="input" value={c.revenue_account_id ?? ''} disabled={!isOwner} onChange={(e) => void setRevenue(c.id, e.target.value)} aria-label={`บัญชีรายได้ของ ${c.name}`}>
                <option value="">รายได้ขายอาหาร (ค่าเริ่มต้น)</option>
                {salesAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </li>
          ))}
          {cats.length === 0 && <li className="p-6 text-center text-gray-400">ยังไม่มีหมวดเมนู</li>}
        </ul>
      </Section>

      {isOwner && (
        <Section title="ยอดยกมา (เงินสด / ธนาคาร ตอนเริ่มใช้ระบบ)">
          <form onSubmit={(e) => void saveOpening(e)} className="card grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <input className="input" type="number" min="0" step="0.01" placeholder="เงินสดในลิ้นชัก" value={opening.cash} onChange={(e) => setOpening({ ...opening, cash: e.target.value })} />
            <input className="input" type="number" min="0" step="0.01" placeholder="เงินในบัญชีธนาคาร" value={opening.bank} onChange={(e) => setOpening({ ...opening, bank: e.target.value })} />
            <button className="btn btn-secondary" disabled={!opening.cash && !opening.bank}>
              ลงยอดยกมา
            </button>
          </form>
          <p className="mt-2 text-xs text-gray-500">สต็อกวัตถุดิบที่มีอยู่ลงเป็นยอดยกมาให้อัตโนมัติแล้ว</p>
        </Section>
      )}

      {canWrite && (
        <Section title={`เจ้าหนี้การค้าคงค้าง ${baht(apBalance)}`}>
          <form onSubmit={(e) => void paySupplier(e)} className="card grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
            <input className="input" placeholder="ผู้ขาย" maxLength={100} value={pay.supplier} onChange={(e) => setPay({ ...pay, supplier: e.target.value })} />
            <input className="input" type="number" min="0" step="0.01" placeholder="จำนวนเงิน" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} required />
            <select className="input" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })} aria-label="จ่ายด้วย">
              <option value="bank">โอน/QR</option>
              <option value="cash">เงินสด</option>
            </select>
            <button className="btn btn-secondary">จ่ายเจ้าหนี้</button>
          </form>
        </Section>
      )}

      <Section title="ผังบัญชี">
        <div className="card-flush overflow-x-auto">
          <table className="w-full text-sm [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2">
            <thead>
              <tr>
                <th className="text-left">รหัส</th>
                <th className="text-left">ชื่อบัญชี</th>
                <th className="text-left">ประเภท</th>
                <th className="text-right">คงเหลือวันนี้</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className={`border-t ${a.is_active ? '' : 'text-gray-400'}`}>
                  <td className="tabular-nums">{a.code}</td>
                  <td>
                    {a.name}
                    {a.system_key && <span className="badge badge-gray ml-2">ระบบ</span>}
                  </td>
                  <td>
                    {TYPE_LABEL[a.type]}
                    {GROUP_LABEL[a.grp] && ` · ${GROUP_LABEL[a.grp]}`}
                  </td>
                  <td className="text-right tabular-nums">{baht(Math.abs(balances[a.id] ?? 0))}</td>
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
        <p className="mt-2 text-xs text-gray-500">เพิ่มหมวดรายจ่ายของร้านเองได้ที่แท็บ "รายจ่าย" (ปุ่ม + หมวด)</p>
      </Section>
    </div>
  )
}
