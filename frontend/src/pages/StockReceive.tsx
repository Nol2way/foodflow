import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { rolesFor, type Role } from '../lib/roles'
import { baht } from '../lib/format'
import RequireRole from '../components/RequireRole'
import Icon from '../components/Icon'
import { PageHead, StockNav } from '../components/stock/ui'
import { errorText, stockApi, todayIso, useLoad, type LastPurchase, type ReceiveWarning } from '../lib/stockApi'
import { fmtNum, round } from '../lib/stockMath'

// รับเข้า (stock_receive / submit_stock_receipt ใน 0029)
//   เลือกผู้ขาย -> กรอกจำนวน (แพ็ค) ขนาดบรรจุ ราคาต่อแพ็ค วันหมดอายุ -> สร้างล็อต (FEFO/FIFO)
//   เตือนตั้งแต่ก่อนบันทึก เมื่อราคาต่อหน่วยหรือขนาดบรรจุเปลี่ยนจากครั้งก่อน · ราคาเปลี่ยน = ต้นทุนสูตรที่ใช้คำนวณใหม่
//   ได้ของไม่ครบบิล: กรอก "ตามบิล" ส่วนที่ขาดเป็นยอดรอทวง (ติดตามที่ใบรับของย้อนหลัง)

interface Line {
  key: number
  ingredient_id: string
  packs: string // จำนวนแพ็คที่รับจริง
  packSize: string // 1 แพ็ค = ? หน่วยฐาน
  packPrice: string // ราคาต่อแพ็ค
  expiry: string
  billPacks: string // ตามบิล (ว่าง = เท่ารับจริง)
}

type ClaimStatus = 'none' | 'pending' | 'credited' | 'accepted'
type LineStatus = 'ok' | 'short' | 'over' | 'rejected'

interface Receipt {
  id: string
  supplier: string | null
  invoice_no: string | null
  received_on: string
  note: string | null
  item_count: number
  total_cost: number
  invoice_total: number
  claim_total: number
  expense_id: string | null
  received_by_name: string | null
  created_at: string
}

interface ReceiptLine {
  ingredient_id: string
  ingredient_name: string
  unit: string
  quantity: number
  unit_cost: number
  line_total: number
  invoice_qty: number | null
  invoice_unit: string | null
  invoice_unit_qty: number | null
  gross_qty: number | null
  status: LineStatus
  claim_value: number
  claim_status: ClaimStatus
  prev_unit_cost: number | null
  line_note: string | null
  pack_qty: number | null
  pack_size: number | null
  pack_price: number | null
  expiry_date: string | null
  price_change_pct: number | null
  pack_changed: boolean
}

const STATUS: Record<LineStatus, { label: string; badge: string }> = {
  ok: { label: 'ตรงบิล', badge: 'badge-green' },
  short: { label: 'ขาด', badge: 'badge-red' },
  over: { label: 'เกิน', badge: 'badge-amber' },
  rejected: { label: 'ตีกลับ', badge: 'badge-red' },
}
const CLAIM: Record<Exclude<ClaimStatus, 'none'>, string> = { pending: 'รอทวง', credited: 'ได้ลดหนี้แล้ว', accepted: 'ยอมรับ ไม่ทวง' }

const today = todayIso
const monthStart = () => today().slice(0, 8) + '01'
let seq = 1
const blank = (): Line => ({ key: seq++, ingredient_id: '', packs: '', packSize: '', packPrice: '', expiry: '', billPacks: '' })
const pct = (n: number) => `${n.toLocaleString('th-TH', { maximumFractionDigits: 1 })}%`

function useReceiveSettings(restaurantId: string) {
  const [s, setS] = useState({ tolerance: 2, glazeMax: 12 })
  useEffect(() => {
    void supabase
      .from('shop_settings')
      .select('receive_tolerance_pct,glaze_max_pct')
      .eq('restaurant_id', restaurantId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setS({ tolerance: Number(data.receive_tolerance_pct), glazeMax: Number(data.glaze_max_pct) })
      })
  }, [restaurantId])
  return s
}

// คำเตือนก่อนบันทึก: เทียบกับครั้งก่อน (ผู้ขายเดียวกันก่อน)
function lineWarnings(l: Line, last: LastPurchase | undefined): string[] {
  if (!last) return []
  const size = Number(l.packSize)
  const price = Number(l.packPrice)
  const out: string[] = []
  if (size > 0 && price >= 0 && Number(last.unit_cost) > 0) {
    const change = ((price / size - Number(last.unit_cost)) / Number(last.unit_cost)) * 100
    if (Math.abs(change) >= 0.5) out.push(`ราคาต่อหน่วย${change > 0 ? 'ขึ้น' : 'ลง'} ${pct(Math.abs(change))} จากครั้งก่อน`)
  }
  if (size > 0 && last.pack_size && Number(last.pack_size) !== size) out.push(`ขนาดบรรจุเปลี่ยน (ครั้งก่อน ${fmtNum(Number(last.pack_size))})`)
  return out
}

function ReceiveForm({ restaurantId, onSaved }: { restaurantId: string; onSaved: (id: string) => void }) {
  const base = useLoad(async () => {
    const [i, s] = await Promise.all([stockApi.ingredients(restaurantId), stockApi.suppliers(restaurantId)])
    return { ingredients: i.ingredients, suppliers: s.suppliers.filter((x) => x.is_active) }
  }, [restaurantId])
  const [supplierId, setSupplierId] = useState('')
  const lastQ = useLoad(() => stockApi.lastPurchases(restaurantId, supplierId || null), [restaurantId, supplierId])
  const [invoice, setInvoice] = useState('')
  const [date, setDate] = useState(today)
  const [note, setNote] = useState('')
  const [expense, setExpense] = useState(true)
  const [lines, setLines] = useState<Line[]>([blank()])
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ id: string; warnings: ReceiveWarning[]; recosted: number } | null>(null)
  const [saving, setSaving] = useState(false)

  const ingredients = useMemo(() => base.data?.ingredients ?? [], [base.data])
  const byId = useMemo(() => new Map(ingredients.map((i) => [i.id, i])), [ingredients])
  const last = useMemo(() => new Map((lastQ.data?.last ?? []).map((l) => [l.ingredient_id, l])), [lastQ.data])
  // วัตถุดิบของผู้ขายที่เลือกขึ้นก่อน
  const options = useMemo(
    () => [...ingredients].sort((a, b) => Number(b.supplier_id === supplierId) - Number(a.supplier_id === supplierId) || a.name.localeCompare(b.name, 'th')),
    [ingredients, supplierId],
  )

  const set = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  function pick(key: number, id: string) {
    const ing = byId.get(id)
    const lp = last.get(id)
    const size = lp?.pack_size ?? ing?.conversion_factor ?? 1
    const price = lp?.pack_price ?? (lp ? round(Number(lp.unit_cost) * Number(size), 2) : '')
    set(key, { ingredient_id: id, packSize: String(size), packPrice: price === '' ? '' : String(price) })
  }

  const filled = lines.filter((l) => l.ingredient_id)
  const total = filled.reduce((s, l) => s + (Number(l.packs) || 0) * (Number(l.packPrice) || 0), 0)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!filled.length) return setError('เพิ่มอย่างน้อย 1 รายการ')
    if (new Set(filled.map((l) => l.ingredient_id)).size !== filled.length) return setError('มีวัตถุดิบซ้ำ รวมเป็นบรรทัดเดียว')
    for (const l of filled) {
      const name = byId.get(l.ingredient_id)?.name
      if (!(Number(l.packs) >= 0) || l.packs === '') return setError(`${name}: กรอกจำนวนที่รับ (0 = ตีกลับ)`)
      if (!(Number(l.packSize) > 0)) return setError(`${name}: ขนาดบรรจุต้องมากกว่า 0`)
      if (!(Number(l.packPrice) >= 0) || l.packPrice === '') return setError(`${name}: กรอกราคาต่อแพ็ค`)
      if (l.expiry && l.expiry < date) return setError(`${name}: วันหมดอายุต้องไม่ก่อนวันรับ`)
    }
    setSaving(true)
    try {
      const r = await stockApi.receive(restaurantId, {
        supplier_id: supplierId || null,
        invoice_no: invoice,
        received_on: date,
        note,
        record_expense: expense,
        lines: filled.map((l) => ({
          ingredient_id: l.ingredient_id,
          pack_qty: Number(l.packs),
          pack_size: Number(l.packSize),
          pack_price: Number(l.packPrice),
          ...(l.expiry ? { expiry_date: l.expiry } : {}),
          ...(l.billPacks !== '' && Number(l.billPacks) !== Number(l.packs) ? { invoice_qty: round(Number(l.billPacks) * Number(l.packSize), 3) } : {}),
        })),
      })
      setError(null)
      setResult({ id: r.receipt_id, warnings: r.warnings, recosted: r.recosted_recipes })
      setLines([blank()])
      setInvoice('')
      setNote('')
      void lastQ.reload()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  if (base.error) return <p className="alert-error">{base.error}</p>
  const suppliers = base.data?.suppliers ?? []

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <p className="alert-error">{error}</p>}
      {result && (
        <div className="alert-success">
          บันทึกใบรับของแล้ว
          {result.recosted > 0 && <> · คำนวณต้นทุนสูตรใหม่ {result.recosted} สูตร (รวมสูตรแม่)</>}
          {result.warnings.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-amber-900">
              {result.warnings.map((w) => (
                <li key={w.ingredient_id}>
                  {w.ingredient_name}:{' '}
                  {w.price_change_pct ? `ราคาต่อหน่วย ${Number(w.price_change_pct) > 0 ? '+' : ''}${pct(Number(w.price_change_pct))}` : ''}
                  {w.pack_changed ? ` ขนาดบรรจุ ${fmtNum(Number(w.prev_pack_size))} -> ${fmtNum(Number(w.pack_size))}` : ''}
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="link ml-2" onClick={() => onSaved(result.id)}>ดูใบรับของ</button>
        </div>
      )}

      <div className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="sm:col-span-2">
          <span className="label">ผู้ขาย</span>
          <select className="input w-full" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">ไม่ระบุ</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label>
          <span className="label">เลขที่บิล</span>
          <input className="input w-full" maxLength={50} value={invoice} onChange={(e) => setInvoice(e.target.value)} />
        </label>
        <label>
          <span className="label">วันที่รับ</span>
          <input className="input w-full" type="date" max={today()} value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
      </div>

      <div className="space-y-3">
        {lines.map((l) => {
          const ing = byId.get(l.ingredient_id)
          const warns = lineWarnings(l, last.get(l.ingredient_id))
          const baseQty = (Number(l.packs) || 0) * (Number(l.packSize) || 0)
          return (
            <div key={l.key} className="card space-y-3">
              <div className="flex gap-2">
                <label className="flex-1">
                  <span className="label">วัตถุดิบ</span>
                  <select className="input w-full" value={l.ingredient_id} onChange={(e) => pick(l.key, e.target.value)}>
                    <option value="">เลือก...</option>
                    {options.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                  </select>
                </label>
                {lines.length > 1 && (
                  <button type="button" className="link-danger self-end pb-2" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>ลบ</button>
                )}
              </div>
              {ing && (
                <>
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                    <label>
                      <span className="label">จำนวนที่รับ ({ing.purchase_unit})</span>
                      <input className="input w-full text-right" type="number" min="0" step="any" inputMode="decimal" value={l.packs} onChange={(e) => set(l.key, { packs: e.target.value })} required />
                    </label>
                    <label>
                      <span className="label">1 {ing.purchase_unit} = ? {ing.unit}</span>
                      <input className="input w-full text-right" type="number" min="0" step="any" inputMode="decimal" value={l.packSize} onChange={(e) => set(l.key, { packSize: e.target.value })} required />
                    </label>
                    <label>
                      <span className="label">ราคาต่อ {ing.purchase_unit} (บาท)</span>
                      <input className="input w-full text-right" type="number" min="0" step="any" inputMode="decimal" value={l.packPrice} onChange={(e) => set(l.key, { packPrice: e.target.value })} required />
                    </label>
                    <label>
                      <span className="label">วันหมดอายุ</span>
                      <input className="input w-full" type="date" min={date} value={l.expiry} onChange={(e) => set(l.key, { expiry: e.target.value })} />
                    </label>
                    <label>
                      <span className="label">ตามบิล ({ing.purchase_unit}) ถ้าได้ไม่ครบ</span>
                      <input className="input w-full text-right" type="number" min="0" step="any" inputMode="decimal" placeholder={l.packs || '-'} value={l.billPacks} onChange={(e) => set(l.key, { billPacks: e.target.value })} />
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                    <span>เข้าสต็อก {fmtNum(baseQty)} {ing.unit}</span>
                    {Number(l.packSize) > 0 && l.packPrice !== '' && (
                      <span>
                        {baht(Number(l.packPrice) / Number(l.packSize))}/{ing.unit} · หลัง yield {baht((Number(l.packPrice) / Number(l.packSize)) * 10000 / (ing.trim_yield_pct * ing.cook_yield_pct))}/{ing.unit}
                      </span>
                    )}
                    {last.get(ing.id) && <span>ครั้งก่อน {baht(Number(last.get(ing.id)!.unit_cost))}/{ing.unit}</span>}
                    <span className="ml-auto font-medium text-gray-700">{baht((Number(l.packs) || 0) * (Number(l.packPrice) || 0))}</span>
                  </div>
                  {warns.length > 0 && <p className="note">⚠ {warns.join(' · ')}</p>}
                </>
              )}
            </div>
          )
        })}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setLines((ls) => [...ls, blank()])}>+ เพิ่มรายการ</button>
      </div>

      <div className="card flex flex-wrap items-center gap-3">
        <input className="input min-w-48 flex-1" maxLength={300} placeholder="หมายเหตุ" value={note} onChange={(e) => setNote(e.target.value)} />
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={expense} onChange={(e) => setExpense(e.target.checked)} />
          บันทึกเป็นรายจ่าย
        </label>
        <span className="text-sm">รวม <strong className="tabular-nums">{baht(total)}</strong></span>
        <button className="btn btn-primary" disabled={saving}>{saving ? 'กำลังบันทึก...' : 'บันทึกรับเข้า'}</button>
      </div>
    </form>
  )
}

function ReceiptSheet({ receipt, canClaim, onBack }: { receipt: Receipt; canClaim: boolean; onBack: () => void }) {
  const [lines, setLines] = useState<ReceiptLine[]>([])
  const [error, setError] = useState<string | null>(null)
  const [head, setHead] = useState(receipt)

  const load = useCallback(async () => {
    const [ls, h] = await Promise.all([
      supabase
        .from('stock_receipt_lines')
        .select('ingredient_id,ingredient_name,unit,quantity,unit_cost,line_total,invoice_qty,invoice_unit,invoice_unit_qty,gross_qty,status,claim_value,claim_status,prev_unit_cost,line_note,pack_qty,pack_size,pack_price,expiry_date,price_change_pct,pack_changed')
        .eq('receipt_id', receipt.id)
        .order('ingredient_name'),
      supabase.from('stock_receipts').select('claim_total').eq('id', receipt.id).single(),
    ])
    setLines((ls.data ?? []) as ReceiptLine[])
    if (h.data) setHead((prev) => ({ ...prev, claim_total: Number(h.data.claim_total) }))
  }, [receipt.id])

  useEffect(() => {
    void load()
  }, [load])

  async function setClaim(l: ReceiptLine, status: ClaimStatus) {
    const { error: err } = await supabase.rpc('set_receipt_claim', { p_receipt_id: receipt.id, p_ingredient_id: l.ingredient_id, p_status: status })
    if (err) return setError(err.message)
    setError(null)
    void load()
  }

  return (
    <div>
      <div className="mb-4 flex gap-2 print:hidden">
        <button className="btn btn-secondary btn-sm" onClick={onBack}>← กลับ</button>
        <button className="btn btn-secondary btn-sm ml-auto" onClick={() => window.print()}>
          <Icon name="print" className="h-4 w-4" />
          พิมพ์
        </button>
      </div>
      {error && <p className="alert-error">{error}</p>}
      <div className="print-sheet card">
        <div className="flex flex-wrap justify-between gap-2 border-b pb-3">
          <div>
            <h2 className="text-lg font-bold text-gray-900">ใบรับของ (ตรวจรับเทียบบิล)</h2>
            <p className="text-sm text-gray-500">
              วันที่รับ {new Date(receipt.received_on).toLocaleDateString('th-TH', { dateStyle: 'medium' })} · ผู้รับ {receipt.received_by_name ?? '-'}
            </p>
            {receipt.note && <p className="text-sm text-gray-700">หมายเหตุ: {receipt.note}</p>}
          </div>
          <div className="text-right text-sm">
            <div>ผู้ขาย: <strong>{receipt.supplier ?? '-'}</strong></div>
            <div>เลขที่บิล: {receipt.invoice_no ?? '-'}</div>
            {receipt.expense_id && <div className="text-xs text-emerald-700">บันทึกเป็นรายจ่ายแล้ว</div>}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="mt-3 w-full min-w-[720px] text-sm">
            <thead>
              <tr className="text-left">
                <th className="px-2 py-1.5">วัตถุดิบ</th>
                <th className="px-2 py-1.5 text-right">ตามบิล</th>
                <th className="px-2 py-1.5 text-right">รับจริง</th>
                <th className="px-2 py-1.5 text-right">ราคา</th>
                <th className="px-2 py-1.5">ผล</th>
                <th className="px-2 py-1.5 text-right">รอทวง</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {lines.map((l) => {
                const glaze = l.gross_qty && Number(l.gross_qty) > 0 ? ((Number(l.gross_qty) - Number(l.quantity)) / Number(l.gross_qty)) * 100 : null
                return (
                  <tr key={l.ingredient_id} className="align-top">
                    <td className="px-2 py-1.5">
                      {l.ingredient_name}
                      {l.line_note && <div className="text-xs text-gray-500">{l.line_note}</div>}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {l.invoice_unit ? `${fmtNum(Number(l.invoice_unit_qty))} ${l.invoice_unit}` : `${fmtNum(Number(l.invoice_qty ?? l.quantity))} ${l.unit}`}
                      {l.invoice_unit && <div className="text-xs text-gray-500">= {fmtNum(Number(l.invoice_qty))} {l.unit}</div>}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {fmtNum(l.quantity)} {l.unit}
                      {l.pack_qty !== null && l.pack_size !== null && (
                        <div className="text-xs text-gray-500">{fmtNum(Number(l.pack_qty))} × {fmtNum(Number(l.pack_size))} {l.unit}</div>
                      )}
                      {l.expiry_date && <div className="text-xs text-gray-500">หมดอายุ {new Date(l.expiry_date).toLocaleDateString('th-TH', { dateStyle: 'medium' })}</div>}
                      {glaze !== null && <div className="text-xs text-gray-500">รวม {fmtNum(Number(l.gross_qty))} · น้ำแข็ง {pct(glaze)}</div>}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {l.pack_price !== null ? `${baht(Number(l.pack_price))}/แพ็ค` : `${baht(Number(l.unit_cost))}/${l.unit}`}
                      {l.price_change_pct !== null && Number(l.price_change_pct) !== 0 && (
                        <div className="text-xs text-amber-800">
                          ราคา{Number(l.price_change_pct) > 0 ? 'ขึ้น' : 'ลง'} {pct(Math.abs(Number(l.price_change_pct)))} จากครั้งก่อน
                        </div>
                      )}
                      {l.pack_changed && <div className="text-xs text-amber-800">ขนาดบรรจุเปลี่ยน</div>}
                    </td>
                    <td className="px-2 py-1.5"><span className={`badge ${STATUS[l.status].badge}`}>{STATUS[l.status].label}</span></td>
                    <td className="px-2 py-1.5 text-right">
                      {Number(l.claim_value) > 0 ? (
                        <>
                          <div className={`tabular-nums font-semibold ${l.claim_status === 'pending' ? 'text-red-700' : 'text-gray-500'}`}>{baht(Number(l.claim_value))}</div>
                          {canClaim ? (
                            <select className="input mt-1 py-1 text-xs print:hidden" value={l.claim_status} onChange={(e) => void setClaim(l, e.target.value as ClaimStatus)}>
                              {(Object.keys(CLAIM) as (keyof typeof CLAIM)[]).map((k) => <option key={k} value={k}>{CLAIM[k]}</option>)}
                            </select>
                          ) : (
                            <div className="text-xs text-gray-500">{CLAIM[l.claim_status as keyof typeof CLAIM]}</div>
                          )}
                          <div className="hidden text-xs print:block">{CLAIM[l.claim_status as keyof typeof CLAIM]}</div>
                        </>
                      ) : (
                        <span className="text-gray-300">-</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className="border-t text-right">
                <td colSpan={6} className="px-2 py-2">
                  ยอดตามบิล <strong>{baht(Number(head.invoice_total))}</strong> · รับจริง <strong>{baht(Number(head.total_cost))}</strong> · รอทวง{' '}
                  <strong className={Number(head.claim_total) > 0 ? 'text-red-700' : ''}>{baht(Number(head.claim_total))}</strong>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="mt-8 hidden grid-cols-2 gap-8 text-sm print:grid">
          <div className="border-t pt-1 text-center text-gray-500">ผู้ส่งของ</div>
          <div className="border-t pt-1 text-center text-gray-500">ผู้รับของ</div>
        </div>
      </div>
    </div>
  )
}

function ReceiptList({ restaurantId, openId, canClaim, onOpen }: { restaurantId: string; openId: string | null; canClaim: boolean; onOpen: (id: string | null) => void }) {
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [onlyClaims, setOnlyClaims] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('stock_receipts')
      .select('id,supplier,invoice_no,received_on,note,item_count,total_cost,invoice_total,claim_total,expense_id,received_by_name,created_at')
      .eq('restaurant_id', restaurantId)
      .order('created_at', { ascending: false })
      .limit(100)
    if (err) setError('โหลดใบรับของไม่ได้ (ต้องรัน migration 0025 ก่อน)')
    else setReceipts((data ?? []) as Receipt[])
  }, [restaurantId])

  useEffect(() => {
    void load()
  }, [load, openId])

  const open = receipts.find((r) => r.id === openId)
  if (open) return <ReceiptSheet receipt={open} canClaim={canClaim} onBack={() => onOpen(null)} />
  const shown = onlyClaims ? receipts.filter((r) => Number(r.claim_total) > 0) : receipts
  const pending = receipts.reduce((s, r) => s + Number(r.claim_total), 0)

  return (
    <div>
      {error && <p className="alert-error">{error}</p>}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="text-sm text-gray-600">
          รอทวงทั้งหมด <strong className={pending > 0 ? 'text-red-700' : ''}>{baht(pending)}</strong>
        </span>
        <label className="ml-auto flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={onlyClaims} onChange={(e) => setOnlyClaims(e.target.checked)} />
          เฉพาะใบที่ยังมียอดรอทวง
        </label>
      </div>
      <ul className="card-flush divide-y text-sm">
        {shown.map((r) => (
          <li key={r.id}>
            <button className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 p-3 text-left hover:bg-gray-50" onClick={() => onOpen(r.id)}>
              <span className="min-w-40 flex-1">
                <span className="block font-medium text-gray-900">{r.supplier ?? 'ไม่ระบุผู้ขาย'}{r.invoice_no && ` · ${r.invoice_no}`}</span>
                <span className="text-xs text-gray-500">
                  {new Date(r.received_on).toLocaleDateString('th-TH', { dateStyle: 'medium' })} · {r.received_by_name ?? '-'} · {r.item_count} รายการ
                </span>
              </span>
              {Number(r.claim_total) > 0 && <span className="badge badge-red">รอทวง {baht(Number(r.claim_total))}</span>}
              <span className="w-28 text-right font-semibold tabular-nums">{baht(Number(r.invoice_total || r.total_cost))}</span>
            </button>
          </li>
        ))}
        {shown.length === 0 && !error && <li className="p-6 text-center text-gray-400">ไม่มีใบรับของ</li>}
      </ul>
    </div>
  )
}

interface SupplierRow {
  supplier: string
  receipts: number
  lines: number
  invoice_value: number
  received_value: number
  claim_pending: number
  claim_credited: number
  claim_accepted: number
  gap_pct: number | null
  short_lines: number
  rejected_lines: number
  glaze_pct: number | null
  glaze_over_lines: number
  price_up_lines: number
}

function SupplierReport({ restaurantId }: { restaurantId: string }) {
  const [from, setFrom] = useState(monthStart)
  const [to, setTo] = useState(today)
  const [rows, setRows] = useState<SupplierRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const settings = useReceiveSettings(restaurantId)

  useEffect(() => {
    void supabase.rpc('supplier_receiving_report', { p_restaurant_id: restaurantId, p_from: from, p_to: to }).then(({ data, error: err }) => {
      if (err) return setError('โหลดรายงานไม่ได้ (ต้องรัน migration 0025 ก่อน)')
      setError(null)
      setRows((data ?? []) as SupplierRow[])
    })
  }, [restaurantId, from, to])

  return (
    <div>
      <div className="card mb-4 flex flex-wrap items-end gap-3">
        <label>
          <span className="label">ตั้งแต่</span>
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          <span className="label">ถึง</span>
          <input className="input" type="date" value={to} max={today()} onChange={(e) => setTo(e.target.value)} />
        </label>
        <p className="text-xs text-gray-500">เป้าหมาย: ยอดขาด/ตีกลับต่ำกว่า 1% ของยอดบิล · น้ำแข็งไม่เกิน {settings.glazeMax}%</p>
      </div>
      {error && <p className="alert-error">{error}</p>}
      <div className="card-flush overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="text-right">
              <th className="px-3 py-2 text-left">ผู้ขาย</th>
              <th className="px-3 py-2">ใบ</th>
              <th className="px-3 py-2">ยอดบิล</th>
              <th className="px-3 py-2">ขาด/ตีกลับ</th>
              <th className="px-3 py-2">% ของบิล</th>
              <th className="px-3 py-2">รอทวง</th>
              <th className="px-3 py-2">ได้ลดหนี้</th>
              <th className="px-3 py-2">น้ำแข็งเฉลี่ย</th>
              <th className="px-3 py-2">ราคาขึ้น &gt;10%</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => {
              const gap = r.gap_pct === null ? null : Number(r.gap_pct)
              const glaze = r.glaze_pct === null ? null : Number(r.glaze_pct)
              return (
                <tr key={r.supplier} className="text-right tabular-nums">
                  <td className="px-3 py-2 text-left font-medium text-gray-900">{r.supplier}</td>
                  <td className="px-3 py-2">{r.receipts}</td>
                  <td className="px-3 py-2">{baht(Number(r.invoice_value))}</td>
                  <td className="px-3 py-2">{Number(r.short_lines) + Number(r.rejected_lines)} ครั้ง</td>
                  <td className={`px-3 py-2 font-semibold ${gap !== null && gap >= 1 ? 'text-red-700' : 'text-emerald-700'}`}>{gap === null ? '-' : pct(gap)}</td>
                  <td className={`px-3 py-2 ${Number(r.claim_pending) > 0 ? 'text-red-700' : 'text-gray-500'}`}>{baht(Number(r.claim_pending))}</td>
                  <td className="px-3 py-2 text-gray-600">{baht(Number(r.claim_credited))}</td>
                  <td className={`px-3 py-2 ${glaze !== null && glaze > settings.glazeMax ? 'font-semibold text-red-700' : ''}`}>
                    {glaze === null ? '-' : pct(glaze)}
                    {Number(r.glaze_over_lines) > 0 && <div className="text-xs">เกินเกณฑ์ {r.glaze_over_lines} ครั้ง</div>}
                  </td>
                  <td className={`px-3 py-2 ${Number(r.price_up_lines) > 0 ? 'text-amber-800' : 'text-gray-500'}`}>{r.price_up_lines} ครั้ง</td>
                </tr>
              )
            })}
            {rows.length === 0 && !error && (
              <tr><td colSpan={9} className="p-6 text-center text-gray-400">ไม่มีใบรับของในช่วงนี้</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Board({ restaurantId, myRoles }: { restaurantId: string; myRoles: Role[] }) {
  const canReceive = myRoles.some((r) => ['owner', 'manager', 'stock'].includes(r))
  const [tab, setTab] = useState<'new' | 'list' | 'suppliers'>(canReceive ? 'new' : 'list')
  const [openId, setOpenId] = useState<string | null>(null)
  const chip = (on: boolean) =>
    `rounded-full border px-3.5 py-1.5 text-sm transition ${on ? 'border-gray-900 bg-gray-900 text-white' : 'bg-white text-gray-600 hover:border-gray-300'}`

  return (
    <div className="page">
      <PageHead
        title="รับเข้า"
        subtitle="เลือกผู้ขาย กรอกจำนวน ราคา วันหมดอายุ · ทุกการรับเป็นล็อตใหม่ (หยิบแบบ FEFO คิดต้นทุนแบบ FIFO)"
        action={
          <>
            {canReceive && <button className={chip(tab === 'new')} onClick={() => setTab('new')}>รับของใหม่</button>}
            <button className={chip(tab === 'list')} onClick={() => { setTab('list'); setOpenId(null) }}>ใบรับของย้อนหลัง</button>
            <button className={chip(tab === 'suppliers')} onClick={() => setTab('suppliers')}>รายงานผู้ขาย</button>
          </>
        }
      />
      <StockNav roles={myRoles} />
      {tab === 'new' && canReceive ? (
        <ReceiveForm restaurantId={restaurantId} onSaved={(id) => { setOpenId(id); setTab('list') }} />
      ) : tab === 'suppliers' ? (
        <SupplierReport restaurantId={restaurantId} />
      ) : (
        <ReceiptList restaurantId={restaurantId} openId={openId} canClaim={myRoles.some((r) => ['owner', 'manager', 'stock', 'accountant'].includes(r))} onOpen={setOpenId} />
      )}
    </div>
  )
}

export default function StockReceive() {
  return <RequireRole roles={rolesFor('/stock-receive')}>{(ctx) => <Board restaurantId={ctx.restaurantId} myRoles={ctx.roles} />}</RequireRole>
}
