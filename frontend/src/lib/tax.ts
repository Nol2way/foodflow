import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import { api } from './api'

// เอกสารภาษีตามประมวลรัษฎากร ม.86/4 (เต็มรูป) · 86/6 (อย่างย่อ) · 86/10 (ใบลดหนี้) + กะแคชเชียร์ (0031)
// เขียนผ่าน backend /api/tax หรือ RPC security definer เท่านั้น · อ่านตรงจากตารางได้ตาม RLS

export type DocType = 'ABB' | 'TAX' | 'CN'
export type DocStatus = 'draft' | 'confirmed' | 'voided'

export interface TaxDocument {
  id: string
  restaurant_id: string
  order_id: string
  ref_document_id: string | null
  doc_type: DocType
  doc_number: string | null
  status: DocStatus
  terminal_code: string | null
  pos_reg_no: string | null
  seller_tax_id: string | null
  seller_name: string | null
  seller_branch_code: string | null
  seller_address: string | null
  seller_postcode: string | null
  buyer_name: string | null
  buyer_tax_id: string | null
  buyer_branch_code: string | null
  buyer_address: string | null
  vat_rate: number
  taxable_amount: number
  exempt_amount: number
  vat_amount: number
  total_amount: number
  credit_note_reason: string | null
  issue_date: string | null
  created_at: string
  created_by_name: string | null
  confirmed_at: string | null
  confirmed_by_name: string | null
}

export const DOC_COLUMNS =
  'id,restaurant_id,order_id,ref_document_id,doc_type,doc_number,status,terminal_code,pos_reg_no,' +
  'seller_tax_id,seller_name,seller_branch_code,seller_address,seller_postcode,' +
  'buyer_name,buyer_tax_id,buyer_branch_code,buyer_address,vat_rate,taxable_amount,exempt_amount,vat_amount,total_amount,' +
  'credit_note_reason,issue_date,created_at,created_by_name,confirmed_at,confirmed_by_name'

// numeric จาก PostgREST มาเป็น string: แปลงเป็น number ทุกครั้งที่อ่าน
export function normDoc(d: Record<string, unknown>): TaxDocument {
  const doc = d as unknown as TaxDocument
  return {
    ...doc,
    vat_rate: Number(doc.vat_rate),
    taxable_amount: Number(doc.taxable_amount),
    exempt_amount: Number(doc.exempt_amount),
    vat_amount: Number(doc.vat_amount),
    total_amount: Number(doc.total_amount),
  }
}

export async function fetchDoc(id: string): Promise<TaxDocument | null> {
  const { data, error } = await supabase.from('tax_documents').select(DOC_COLUMNS).eq('id', id).maybeSingle()
  return error || !data ? null : normDoc(data as unknown as Record<string, unknown>)
}

export const DOC_TITLE: Record<DocType, string> = {
  ABB: 'ใบกำกับภาษีอย่างย่อ',
  TAX: 'ใบเสร็จรับเงิน/ใบกำกับภาษี',
  CN: 'ใบลดหนี้',
}

// เลขประจำตัวผู้เสียภาษี 13 หลัก · checksum mod 11 (ตรงกับ th_tax_id_valid ในฐานข้อมูล) · สูตรเดียวอยู่ที่ accounting.ts
export { thaiTaxIdValid } from './accounting'

export const formatTaxId = (id: string | null | undefined) =>
  id && /^\d{13}$/.test(id) ? `${id[0]}-${id.slice(1, 5)}-${id.slice(5, 10)}-${id.slice(10, 12)}-${id[12]}` : (id ?? '-')

export const branchLabel = (code: string | null | undefined) =>
  !code ? '-' : code === '00000' ? 'สำนักงานใหญ่' : `สาขาที่ ${code}`

// VAT จากยอดรวมภาษี (สูตรเดียวกับ tax_doc_split): ทำงานเป็นสตางค์เพื่อไม่ให้ปัดเศษเพี้ยน
export function splitVat(total: number, exempt = 0, rate = 7): { taxable: number; vat: number } {
  const base = Math.round((total - exempt) * 100)
  const vat = Math.round((base * rate) / (100 + rate))
  return { taxable: (base - vat) / 100, vat: vat / 100 }
}

export const money = (n: number) => n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const thaiDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) : '-'

// ข้อผิดพลาดจาก RPC ที่เรียกตรง (shift_* / tax_doc_update_draft) · เรียกผ่าน /api ได้ข้อความไทยจาก backend อยู่แล้ว
const DB_ERRORS: Record<string, string> = {
  forbidden: 'ไม่มีสิทธิ์ทำรายการนี้',
  invalid_amount: 'จำนวนเงินไม่ถูกต้อง',
  reason_required: 'กรุณาระบุเหตุผล',
  terminal_not_found: 'ไม่พบเครื่อง POS ที่เปิดใช้งาน',
  shift_already_open: 'มีกะที่เปิดอยู่แล้ว (ผู้ใช้หรือเครื่องนี้)',
  shift_closed: 'กะนี้ปิดแล้ว',
  insufficient_cash: 'เงินในลิ้นชักไม่พอให้นำออก',
  invalid_log_type: 'ประเภทต้องเป็นนำเงินเข้าหรือนำเงินออก',
  not_draft: 'เอกสารนี้ไม่ใช่ฉบับร่าง',
  invalid_buyer_tax_id: 'เลขประจำตัวผู้เสียภาษีของผู้ซื้อไม่ถูกต้อง',
  invalid_buyer_branch_code: 'รหัสสาขาผู้ซื้อต้องเป็นตัวเลข 5 หลัก',
  amounts_follow_ref: 'ยอดเงินเป็นไปตามเอกสารอ้างอิง แก้ไม่ได้',
  credit_exceeds_invoice: 'ยอดลดหนี้รวมเกินยอดใบกำกับภาษี',
  zero_amount: 'ยอดเอกสารต้องมากกว่า 0',
}
export function dbMessage(message: string): string {
  const code = message.split(':')[0].trim()
  return DB_ERRORS[code] ?? message
}

// ===== ตั้งค่าผู้ประกอบการ + เครื่อง POS =====
export interface TaxSeller {
  tax_id: string
  company_name: string
  branch_code: string
  branch_name: string | null
  registered_address: string
  postcode: string | null
}

export interface PosTerminal {
  id: string
  terminal_code: string
  name: string
  pos_reg_no: string | null
}

const terminalKey = (rid: string) => `plato.terminal.${rid}`
function readTerminal(rid: string): string | null {
  try {
    return localStorage.getItem(terminalKey(rid))
  } catch {
    return null
  }
}

export function useTaxSetup(restaurantId: string) {
  const [seller, setSeller] = useState<TaxSeller | null>(null)
  const [terminals, setTerminals] = useState<PosTerminal[]>([])
  const [vatRegistered, setVatRegistered] = useState(false)
  const [vatRate, setVatRate] = useState(7)
  const [terminalCode, setTerminalCode] = useState<string | null>(() => readTerminal(restaurantId))
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(async () => {
    const [s, t, v] = await Promise.all([
      supabase.from('tax_settings').select('tax_id,company_name,branch_code,branch_name,registered_address,postcode').eq('restaurant_id', restaurantId).maybeSingle(),
      supabase.from('pos_terminals').select('id,terminal_code,name,pos_reg_no').eq('restaurant_id', restaurantId).eq('is_active', true).order('terminal_code'),
      supabase.from('shop_settings').select('vat_registered,vat_rate').eq('restaurant_id', restaurantId).maybeSingle(),
    ])
    setSeller(s.error ? null : ((s.data as TaxSeller | null) ?? null))
    setTerminals(t.error ? [] : ((t.data ?? []) as PosTerminal[]))
    setVatRegistered(!v.error && Boolean(v.data?.vat_registered))
    setVatRate(v.data?.vat_rate != null ? Number(v.data.vat_rate) : 7)
    setLoaded(true)
  }, [restaurantId])

  useEffect(() => {
    void reload()
  }, [reload])

  const chooseTerminal = useCallback(
    (code: string | null) => {
      try {
        if (code) localStorage.setItem(terminalKey(restaurantId), code)
        else localStorage.removeItem(terminalKey(restaurantId))
      } catch {
        /* เบราว์เซอร์ไม่ให้เก็บ: ใช้ได้จนรีเฟรช */
      }
      setTerminalCode(code)
    },
    [restaurantId],
  )

  const terminal = terminals.find((x) => x.terminal_code === terminalCode) ?? null
  const canIssue = vatRegistered && seller !== null && terminal !== null
  return {
    loaded,
    seller,
    terminals,
    terminal,
    vatRegistered,
    vatRate,
    canIssue,
    // ใบอย่างย่อต้องมีเลขอนุมัติเครื่อง POS (pos_reg_no) จากกรมสรรพากร
    canIssueAbb: canIssue && Boolean(terminal?.pos_reg_no),
    chooseTerminal,
    reload,
  }
}
export type TaxSetup = ReturnType<typeof useTaxSetup>

// ===== backend /api/tax =====
export interface DraftInput {
  restaurant_id: string
  doc_type: DocType
  order_id?: string | null
  ref_document_id?: string | null
  buyer_name?: string | null
  buyer_tax_id?: string | null
  buyer_branch_code?: string | null
  buyer_address?: string | null
  amount?: number | null
  credit_note_reason?: string | null
}

export const createDraft = (input: DraftInput) =>
  api<{ document: Record<string, unknown> }>('/tax/documents', { body: input }).then((r) => normDoc(r.document))

export const confirmDocument = (restaurantId: string, id: string, terminalCode: string) =>
  api<{ document: Record<string, unknown> }>(`/tax/documents/${id}/confirm`, {
    body: { restaurant_id: restaurantId, terminal_code: terminalCode },
  }).then((r) => normDoc(r.document))

// ออกใบอย่างย่อทันทีหลังรับชำระ (ร่าง + ยืนยันในคำขอเดียว)
export const issueAbb = (restaurantId: string, orderId: string, terminalCode: string) =>
  api<{ document: Record<string, unknown> }>('/tax/documents', {
    body: { restaurant_id: restaurantId, doc_type: 'ABB', order_id: orderId, confirm: true, terminal_code: terminalCode },
  }).then((r) => normDoc(r.document))

// แก้ฉบับร่าง (backend ไม่มี route แก้ร่าง: เรียก RPC ตรง ฐานข้อมูลตรวจสิทธิ์เอง)
export async function updateDraft(id: string, input: Omit<DraftInput, 'restaurant_id' | 'doc_type' | 'order_id' | 'ref_document_id'>) {
  const { error } = await supabase.rpc('tax_doc_update_draft', {
    p_document_id: id,
    p_buyer_name: input.buyer_name ?? null,
    p_buyer_tax_id: input.buyer_tax_id ?? null,
    p_buyer_branch_code: input.buyer_branch_code ?? null,
    p_buyer_address: input.buyer_address ?? null,
    p_exempt_amount: null,
    p_amount: input.amount ?? null,
    p_credit_note_reason: input.credit_note_reason ?? null,
  })
  if (error) throw new Error(dbMessage(error.message))
  const doc = await fetchDoc(id)
  if (!doc) throw new Error('โหลดเอกสารไม่สำเร็จ')
  return doc
}

// ===== ข้อมูลผู้ซื้อ: ค้นจากเอกสารเดิม (เลขผู้เสียภาษี) หรือสมาชิก/ที่จำไว้ในเครื่อง (เบอร์โทร) =====
export interface Buyer {
  name: string
  tax_id: string
  branch_code: string
  address: string
}

const BUYER_KEY = 'plato.taxBuyers'
function readBuyers(): Record<string, Buyer> {
  try {
    return JSON.parse(localStorage.getItem(BUYER_KEY) ?? '{}') as Record<string, Buyer>
  } catch {
    return {}
  }
}
export function rememberBuyer(phone: string, buyer: Buyer) {
  if (!/^0\d{8,9}$/.test(phone)) return
  try {
    localStorage.setItem(BUYER_KEY, JSON.stringify({ ...readBuyers(), [phone]: buyer }))
  } catch {
    /* ไม่เป็นไร */
  }
}

export async function findBuyerByTaxId(restaurantId: string, taxId: string): Promise<Buyer | null> {
  const { data } = await supabase
    .from('tax_documents')
    .select('buyer_name,buyer_tax_id,buyer_branch_code,buyer_address')
    .eq('restaurant_id', restaurantId)
    .eq('buyer_tax_id', taxId)
    .not('buyer_address', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
  const d = data?.[0]
  return d
    ? { name: d.buyer_name ?? '', tax_id: d.buyer_tax_id ?? taxId, branch_code: d.buyer_branch_code ?? '00000', address: d.buyer_address ?? '' }
    : null
}

export async function findBuyerByPhone(restaurantId: string, phone: string): Promise<Partial<Buyer> | null> {
  const saved = readBuyers()[phone]
  if (saved) return saved
  const { data } = await supabase.from('members').select('name').eq('restaurant_id', restaurantId).eq('phone', phone).maybeSingle()
  return data?.name ? { name: data.name } : null
}

// ===== กะแคชเชียร์ =====
export interface CashierShift {
  id: string
  restaurant_id: string
  terminal_id: string | null
  cashier_id: string
  cashier_name: string
  status: 'open' | 'closed'
  opened_at: string
  closed_at: string | null
  starting_cash: number
  cash_sales: number | null
  cash_in_total: number | null
  cash_out_total: number | null
  expected_cash: number | null
  actual_cash: number | null
  variance_cash: number | null
  close_note: string | null
  closed_by_name: string | null
}

export interface ShiftReport {
  shift: CashierShift
  cash_sales: number
  cash_in_total: number
  cash_out_total: number
  expected_cash: number
  sales_by_method: Record<string, { bills: number; total: number }>
  cancelled_after_paid: number
  drawer_logs: { type: 'cash_in' | 'cash_out'; amount: number; reason: string; by: string | null; at: string }[]
}

const num = (v: unknown) => (v == null ? null : Number(v))
export function normShift(s: Record<string, unknown>): CashierShift {
  const x = s as unknown as CashierShift
  return {
    ...x,
    starting_cash: Number(x.starting_cash),
    cash_sales: num(x.cash_sales),
    cash_in_total: num(x.cash_in_total),
    cash_out_total: num(x.cash_out_total),
    expected_cash: num(x.expected_cash),
    actual_cash: num(x.actual_cash),
    variance_cash: num(x.variance_cash),
  }
}

export async function fetchShiftReport(shiftId: string): Promise<ShiftReport> {
  const { data, error } = await supabase.rpc('shift_report', { p_shift_id: shiftId })
  if (error || !data) throw new Error(dbMessage(error?.message ?? 'โหลดรายงานกะไม่สำเร็จ'))
  const r = data as ShiftReport
  return {
    ...r,
    shift: normShift(r.shift as unknown as Record<string, unknown>),
    cash_sales: Number(r.cash_sales),
    cash_in_total: Number(r.cash_in_total),
    cash_out_total: Number(r.cash_out_total),
    expected_cash: Number(r.expected_cash),
    sales_by_method: Object.fromEntries(
      Object.entries(r.sales_by_method ?? {}).map(([k, v]) => [k, { bills: Number(v.bills), total: Number(v.total) }]),
    ),
    drawer_logs: (r.drawer_logs ?? []).map((l) => ({ ...l, amount: Number(l.amount) })),
  }
}
