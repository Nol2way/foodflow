// API โมดูลบัญชี (0026) · ทุก endpoint เรียกฐานข้อมูลด้วย JWT ของผู้ใช้ (RLS + has_role ตรวจซ้ำ)
// สูตร Food/Prime Cost กำไร งบดุล และไฟล์ส่งออกใช้ร่วมกับหน้าเว็บ (frontend/src/lib/accounting.ts)
import type { Context, Hono, MiddlewareHandler } from 'hono'
import type { AppEnv, Role } from './env.ts'
import { asUser, type Db } from './supabase.ts'
import { LineError, pushLine } from './reports.ts'
import {
  PURCHASE_TAX_HEADER,
  SALES_TAX_HEADER,
  WHT_HEADER,
  monthRange,
  pp30Summary,
  purchaseTaxCells,
  purchaseTaxReport,
  reportCsv,
  salesTaxCells,
  salesTaxReport,
  whtCells,
  whtReport,
  type PurchaseExpenseRow,
  type TaxDocRow,
  type WhtExpenseRow,
} from './csv.ts'
import {
  alerts,
  balanceSheet,
  cashFlow,
  cashView,
  dayCloseText,
  metrics,
  normalizeDashboard,
  normalizeSummary,
  stockCheck,
  taxDeductionCompare,
  toCsv,
  toExcelXml,
  vatThreshold,
  SOURCE_LABEL,
  type Cell,
  type DayClose,
  type TrialRow,
} from '../../frontend/src/lib/accounting.ts'

type Ctx = Context<AppEnv>
type Status = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 502 | 503

export interface Helpers {
  auth: MiddlewareHandler<AppEnv>
  requireRole: (c: Ctx, restaurantId: unknown, roles: Role[]) => Promise<string | Response>
  fail: (c: Ctx, status: Status, error: string, extra?: object) => Response
  body: (c: Ctx) => Promise<Record<string, unknown>>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/
export const MAX_RANGE_DAYS = 3660

// ใครทำอะไรได้ (ฐานข้อมูลบังคับซ้ำ)
export const READ: Role[] = ['owner', 'manager', 'accountant'] // ดูบัญชี รายงาน ส่งออก
export const WRITE: Role[] = ['owner', 'accountant'] // รายจ่าย หมวดบัญชี จ่ายเจ้าหนี้
export const CLOSE: Role[] = ['owner', 'manager'] // นับเงินสด ปิดวัน
export const OWNER: Role[] = ['owner'] // ยกเลิกบิล กลับรายการ ตั้งค่า ยอดยกมา

const validDate = (s: unknown): s is string => typeof s === 'string' && DATE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000

function range(c: Ctx): { from: string; to: string } | null {
  const from = c.req.query('from')
  const to = c.req.query('to')
  if (!validDate(from) || !validDate(to) || from > to || days(from, to) > MAX_RANGE_DAYS) return null
  return { from, to }
}

const num = (v: unknown) => Number(v ?? 0)

const SETTINGS_FIELDS = [
  'accounting_mode', 'business_type', 'vat_registered', 'vat_rate', 'receipt_payment_default',
  'food_cost_target_min', 'food_cost_target_max', 'prime_cost_target_min', 'prime_cost_target_max',
] as const

export function pickSettings(b: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  for (const k of SETTINGS_FIELDS) if (b[k] !== undefined) out[k] = b[k]
  if (out.accounting_mode !== undefined && !['simple', 'standard', 'pro'].includes(String(out.accounting_mode))) return null
  if (out.business_type !== undefined && !['individual', 'company'].includes(String(out.business_type))) return null
  if (out.receipt_payment_default !== undefined && !['cash', 'bank', 'credit'].includes(String(out.receipt_payment_default))) return null
  if (out.vat_registered !== undefined && typeof out.vat_registered !== 'boolean') return null
  for (const k of ['vat_rate', 'food_cost_target_min', 'food_cost_target_max', 'prime_cost_target_min', 'prime_cost_target_max'] as const) {
    if (out[k] !== undefined && (typeof out[k] !== 'number' || (out[k] as number) < 0 || (out[k] as number) > 100)) return null
  }
  if (b.onboarded === true) out.accounting_onboarded_at = new Date().toISOString()
  return out
}

interface JournalRow {
  entry_no: number
  entry_date: string
  source_type: string
  memo: string | null
  reason: string | null
  created_by_name: string | null
  account_code: string
  account_name: string
  debit: number
  credit: number
  line_memo: string | null
}

// ตารางสำหรับส่งออก (หัวตาราง + แถว)
export async function exportTable(
  db: ReturnType<typeof asUser>,
  rid: string,
  report: string,
  from: string,
  to: string,
): Promise<{ title: string; header: string[]; rows: Cell[][] } | null> {
  const args = { p_restaurant_id: rid, p_from: from, p_to: to }
  switch (report) {
    case 'journal': {
      const rows = await db.rpc<JournalRow[]>('acct_journal_rows', { ...args, p_account_id: null, p_limit: 50000 })
      return {
        title: 'สมุดรายวัน',
        header: ['วันที่', 'เลขที่', 'ประเภท', 'คำอธิบาย', 'รหัสบัญชี', 'ชื่อบัญชี', 'เดบิต', 'เครดิต', 'หมายเหตุบรรทัด', 'เหตุผล', 'ผู้บันทึก'],
        rows: rows.map((r) => [
          r.entry_date, r.entry_no, SOURCE_LABEL[r.source_type] ?? r.source_type, r.memo, r.account_code, r.account_name,
          num(r.debit), num(r.credit), r.line_memo, r.reason, r.created_by_name,
        ]),
      }
    }
    case 'trial_balance': {
      const rows = await db.rpc<TrialRow[]>('acct_trial_balance', args)
      return {
        title: 'งบทดลอง',
        header: ['รหัสบัญชี', 'ชื่อบัญชี', 'ประเภท', 'ยอดยกมา', 'เดบิต', 'เครดิต', 'ยอดคงเหลือ (เดบิต+)'],
        rows: rows.map((r) => [r.code, r.name, r.type, num(r.opening), num(r.debit), num(r.credit), num(r.closing)]),
      }
    }
    case 'summary': {
      const s = normalizeSummary(await db.rpc<Record<string, unknown>>('acct_summary', args))
      const m = metrics(s)
      const k = stockCheck(s)
      return {
        title: 'งบกำไรขาดทุน',
        header: ['รายการ', 'จำนวนเงิน'],
        rows: [
          ...s.sales_by_account.map((r): Cell[] => [r.name, r.amount]),
          ['หัก ส่วนลด', -s.discounts],
          ['ยอดขายสุทธิ', m.netSales],
          ['ต้นทุนตามสูตร', s.cogs_recipe],
          ['ส่วนต่างสต็อก', s.stock_variance],
          ['ต้นทุนอาหารรวม', m.foodCost],
          ['กำไรขั้นต้น', m.grossProfit],
          ...s.expenses_by_account.filter((r) => r.grp !== 'food_cost').map((r): Cell[] => [r.name, r.amount]),
          ['กำไรสุทธิ', m.netProfit],
          ['Food Cost %', m.foodCostPct],
          ['Prime Cost %', m.primeCostPct],
          ['สต็อกต้นงวด', k.opening],
          ['รับเข้า', k.purchases],
          ['สต็อกปลายงวด', k.closing],
          ['ภาษีขาย', s.vat_output],
          ['ภาษีซื้อ', s.vat_input],
        ],
      }
    }
    case 'menu_profit': {
      const rows = await db.rpc<Record<string, unknown>[]>('acct_menu_profit', args)
      return {
        title: 'กำไรต่อเมนู',
        header: ['เมนู', 'จำนวน', 'ยอดขาย', 'ต้นทุนตามสูตร', 'กำไรขั้นต้น'],
        rows: rows.map((r) => [String(r.name), num(r.quantity), num(r.revenue), num(r.cost), num(r.gross_profit)]),
      }
    }
    case 'expenses': {
      const rows = await db.select<Record<string, unknown>>(
        `expenses?select=spent_on,amount,vat_amount,payment_method,note,voided_at,void_reason,accounts(code,name)` +
          `&restaurant_id=eq.${rid}&source=eq.manual&spent_on=gte.${from}&spent_on=lte.${to}&order=spent_on`,
      )
      return {
        title: 'รายจ่าย',
        header: ['วันที่', 'รหัสบัญชี', 'หมวด', 'จำนวนเงิน', 'ภาษีซื้อ', 'วิธีจ่าย', 'หมายเหตุ', 'ยกเลิกเมื่อ', 'เหตุผลยกเลิก'],
        rows: rows.map((r) => {
          const a = (r.accounts ?? {}) as { code?: string; name?: string }
          return [String(r.spent_on), a.code, a.name, num(r.amount), num(r.vat_amount), String(r.payment_method), r.note as Cell, r.voided_at as Cell, r.void_reason as Cell]
        }),
      }
    }
    default:
      return null
  }
}

// ===== รายงานภาษี (ภาษีขาย / ภาษีซื้อ / ภ.พ.30 / หัก ณ ที่จ่าย) =====
// PostgREST จำกัดแถวต่อครั้ง (Supabase ค่าเริ่มต้น 1,000) จึงอ่านทีละหน้าจนครบ
export async function selectAll<T>(db: Db, path: string, page = 1000, max = 200_000): Promise<T[]> {
  const out: T[] = []
  for (let offset = 0; offset < max; offset += page) {
    const rows = await db.select<T>(`${path}&limit=${page}&offset=${offset}`)
    out.push(...rows)
    if (rows.length < page) break
  }
  return out
}

interface Seller {
  company_name: string
  tax_id: string
  branch_code: string
  registered_address: string
}

async function sellerOf(db: Db, rid: string): Promise<Seller | null> {
  const [s] = await db.select<Seller>(`tax_settings?select=company_name,tax_id,branch_code,registered_address&restaurant_id=eq.${rid}`)
  return s ?? null
}

const sellerMeta = (s: Seller | null, label: string): [string, Cell][] => [
  ['ชื่อผู้ประกอบการ', s?.company_name ?? ''],
  ['เลขประจำตัวผู้เสียภาษีอากร', s?.tax_id ?? ''],
  ['สถานประกอบการ', s ? (s.branch_code === '00000' ? 'สำนักงานใหญ่' : `สาขาที่ ${s.branch_code}`) : ''],
  ['ที่อยู่', s?.registered_address ?? ''],
  ['เดือนภาษี', label],
]

const TAX_DOC_COLUMNS =
  'id,doc_type,doc_number,issue_date,terminal_code,ref_document_id,buyer_name,buyer_tax_id,buyer_branch_code,' +
  'taxable_amount,exempt_amount,vat_amount,total_amount,credit_note_reason'

export async function salesTaxData(db: Db, rid: string, from: string, to: string) {
  const docs = await selectAll<TaxDocRow>(
    db,
    `tax_documents?select=${TAX_DOC_COLUMNS}&restaurant_id=eq.${rid}&status=eq.confirmed&issue_date=gte.${from}&issue_date=lte.${to}&order=issue_date,doc_number`,
  )
  // เอกสารอ้างอิงที่อยู่นอกเดือน (CN / TAX ที่แปลงจาก ABB)
  const refs = new Map(docs.map((d) => [d.id, { doc_number: d.doc_number, doc_type: d.doc_type as string }]))
  const missing = [...new Set(docs.map((d) => d.ref_document_id).filter((x): x is string => !!x && !refs.has(x)))]
  for (let i = 0; i < missing.length; i += 100) {
    const rows = await db.select<{ id: string; doc_number: string; doc_type: string }>(
      `tax_documents?select=id,doc_number,doc_type&id=in.(${missing.slice(i, i + 100).join(',')})`,
    )
    for (const r of rows) refs.set(r.id, { doc_number: r.doc_number, doc_type: r.doc_type })
  }
  return salesTaxReport(docs, refs)
}

export async function purchaseTaxData(db: Db, rid: string, from: string, to: string) {
  const base = `restaurant_id=eq.${rid}&voided_at=is.null&spent_on=gte.${from}&spent_on=lte.${to}`
  const rows = await selectAll<PurchaseExpenseRow>(
    db,
    `expenses?select=tax_invoice_date,tax_invoice_no,supplier_name,supplier_tax_id,supplier_branch_code,amount,vat_amount,spent_on` +
      `&${base}&tax_invoice_no=not.is.null&order=tax_invoice_date,id`,
  )
  // มีภาษีซื้อแต่ไม่มีใบกำกับ = นำมาหักไม่ได้ (แจ้งเตือน)
  const noInvoice = await selectAll<{ vat_amount: number }>(db, `expenses?select=vat_amount&${base}&tax_invoice_no=is.null&vat_amount=gt.0&order=id`)
  return {
    ...purchaseTaxReport(rows),
    without_invoice: { count: noInvoice.length, vat: Math.round(noInvoice.reduce((s, r) => s + Number(r.vat_amount) * 100, 0)) / 100 },
  }
}

// ===== กะแคชเชียร์: Z-Report =====
interface ShiftReport {
  shift: Record<string, unknown>
  cash_sales: number | string
  cash_in_total: number | string
  cash_out_total: number | string
  expected_cash: number | string
  sales_by_method: Record<string, { bills: number; total: number | string }>
  cancelled_after_paid: number
  drawer_logs: unknown[]
}

export interface ShiftTaxDoc {
  doc_type: string
  doc_number: string
  ref_document_id: string | null
  vat_amount: number | string
  total_amount: number | string
}

export function zReport(r: ShiftReport, docs: ShiftTaxDoc[]) {
  const s = r.shift
  const methods = Object.entries(r.sales_by_method ?? {}).map(([method, v]) => ({ method, bills: Number(v.bills), total: num(v.total) }))
  const cents = (v: unknown) => Math.round(num(v) * 100)
  const variance = num(s.variance_cash)
  const byType = (t: string) => docs.filter((d) => d.doc_type === t).map((d) => d.doc_number).sort()
  const range = (t: string) => {
    const n = byType(t)
    return n.length ? { count: n.length, first: n[0], last: n[n.length - 1] } : { count: 0, first: null, last: null }
  }
  // ใบเต็มรูปที่แปลงจาก ABB (มี ref) ไม่นับยอดซ้ำ · ใบลดหนี้ติดลบ
  const sign = (d: ShiftTaxDoc) => (d.doc_type === 'CN' ? -1 : d.doc_type === 'TAX' && d.ref_document_id ? 0 : 1)
  const signed = (d: ShiftTaxDoc, k: 'vat_amount' | 'total_amount') => sign(d) * cents(d[k])
  return {
    shift_id: s.id,
    cashier: s.cashier_name,
    closed_by: s.closed_by_name ?? null,
    opened_at: s.opened_at,
    closed_at: s.closed_at,
    starting_cash: num(s.starting_cash),
    cash_sales: num(r.cash_sales),
    cash_in: num(r.cash_in_total),
    cash_out: num(r.cash_out_total),
    expected_cash: num(r.expected_cash),
    actual_cash: s.actual_cash === null || s.actual_cash === undefined ? null : num(s.actual_cash),
    variance_cash: variance,
    cash_status: variance === 0 ? 'balanced' : variance > 0 ? 'over' : 'short',
    sales_by_method: methods,
    total_bills: methods.reduce((a, m) => a + m.bills, 0),
    total_sales: methods.reduce((a, m) => a + Math.round(m.total * 100), 0) / 100,
    cancelled_after_paid: Number(r.cancelled_after_paid ?? 0),
    // เอกสารภาษีที่ยืนยันระหว่างกะ (ช่วงเลขที่ต่อประเภท + VAT สุทธิ)
    tax_documents: {
      abb: range('ABB'),
      tax: range('TAX'),
      cn: range('CN'),
      vat_total: docs.reduce((a, d) => a + signed(d, 'vat_amount'), 0) / 100,
      gross_total: docs.reduce((a, d) => a + signed(d, 'total_amount'), 0) / 100,
    },
    drawer_logs: r.drawer_logs ?? [],
    note: s.close_note ?? null,
  }
}

export const SHIFT: Role[] = ['owner', 'manager', 'staff'] // เปิด/ปิดกะ เงินเข้าออกลิ้นชัก (staff เฉพาะกะตัวเอง ฐานข้อมูลตรวจ)
const WHT_RATES = [1, 2, 3, 5]
export const WHT_TYPES = ['pnd3', 'pnd53'] as const
export type WhtType = (typeof WHT_TYPES)[number]
// ตรงกับ constraint expenses_wht_check: เลขผู้เสียภาษีขึ้นต้น 0 (นิติบุคคล) = ภ.ง.ด.53
export const whtTypeFor = (taxId: string): WhtType => (taxId.startsWith('0') ? 'pnd53' : 'pnd3')
const TAX_ID = /^[0-9]{13}$/

export function registerAccounting(app: Hono<AppEnv>, h: Helpers) {
  const { auth, requireRole, fail, body } = h
  const db = (c: Ctx) => asUser(c.env, c.var.token)

  // ----- แดชบอร์ด 3 โหมด (ข้อมูลชุดเดียวกัน) -----
  app.get('/accounting/dashboard', auth, async (c) => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), READ)
    if (typeof rid !== 'string') return rid
    const d = normalizeDashboard(await db(c).rpc<Record<string, unknown>>('acct_dashboard', { p_restaurant_id: rid }))
    const ytd = d.periods.ytd
    return c.json({
      ...d,
      metrics: Object.fromEntries(Object.entries(d.periods).map(([k, s]) => [k, { ...metrics(s), cash: cashView(s) }])),
      vat_threshold: vatThreshold(ytd.sales - ytd.discounts, d.settings.vat_registered),
      tax_compare: taxDeductionCompare(ytd),
      alerts: alerts(d),
    })
  })

  app.get('/accounting/summary', auth, async (c) => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), READ)
    if (typeof rid !== 'string') return rid
    const r = range(c)
    if (!r) return fail(c, 400, 'invalid_range', { message: 'ใส่ from/to เป็น YYYY-MM-DD (ไม่เกิน 10 ปี)' })
    const s = normalizeSummary(await db(c).rpc<Record<string, unknown>>('acct_summary', { p_restaurant_id: rid, p_from: r.from, p_to: r.to }))
    return c.json({ summary: s, metrics: metrics(s), stock_check: stockCheck(s), cash: cashView(s), cash_flow: cashFlow(s) })
  })

  app.get('/accounting/menu-profit', auth, async (c) => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), READ)
    if (typeof rid !== 'string') return rid
    const r = range(c)
    if (!r) return fail(c, 400, 'invalid_range')
    const items = await db(c).rpc('acct_menu_profit', { p_restaurant_id: rid, p_from: r.from, p_to: r.to })
    return c.json({ items })
  })

  app.get('/accounting/trial-balance', auth, async (c) => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), READ)
    if (typeof rid !== 'string') return rid
    const r = range(c)
    if (!r) return fail(c, 400, 'invalid_range')
    const rows = (await db(c).rpc<TrialRow[]>('acct_trial_balance', { p_restaurant_id: rid, p_from: r.from, p_to: r.to })).map((x) => ({
      ...x, opening: num(x.opening), debit: num(x.debit), credit: num(x.credit), closing: num(x.closing),
    }))
    return c.json({ rows, balance_sheet: balanceSheet(rows) })
  })

  app.get('/accounting/journal', auth, async (c) => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), READ)
    if (typeof rid !== 'string') return rid
    const r = range(c)
    if (!r) return fail(c, 400, 'invalid_range')
    const account = c.req.query('account_id')
    if (account !== undefined && !UUID.test(account)) return fail(c, 400, 'invalid_account_id')
    const rows = await db(c).rpc('acct_journal_rows', {
      p_restaurant_id: rid, p_from: r.from, p_to: r.to, p_account_id: account ?? null, p_limit: 5000,
    })
    return c.json({ rows })
  })

  app.get('/accounting/reconcile', auth, async (c) => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), [...READ, 'stock'])
    if (typeof rid !== 'string') return rid
    return c.json(await db(c).rpc('acct_stock_reconcile', { p_restaurant_id: rid }))
  })

  // ----- ผังบัญชี (ร้านเพิ่มหมวดเองได้) -----
  app.get('/accounting/accounts', auth, async (c) => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), READ)
    if (typeof rid !== 'string') return rid
    const accounts = await db(c).select(`accounts?select=id,code,name,type,grp,system_key,is_active&restaurant_id=eq.${rid}&order=code`)
    return c.json({ accounts })
  })

  app.post('/accounting/accounts', auth, async (c) => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, WRITE)
    if (typeof rid !== 'string') return rid
    const code = String(b.code ?? '')
    const name = String(b.name ?? '').trim()
    if (!/^[0-9]{4}$/.test(code) || !name || name.length > 80) return fail(c, 400, 'invalid_request', { message: 'รหัสบัญชี 4 หลัก และชื่อ 1-80 ตัวอักษร' })
    const [row] = await db(c).insert('accounts', { restaurant_id: rid, code, name, type: b.type, grp: b.grp })
    return c.json({ account: row }, 201)
  })

  // ----- รายจ่าย (บังคับเลือกหมวด) -----
  app.get('/accounting/expenses', auth, async (c) => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), READ)
    if (typeof rid !== 'string') return rid
    const r = range(c)
    if (!r) return fail(c, 400, 'invalid_range')
    const expenses = await db(c).select(
      `expenses?select=id,spent_on,amount,vat_amount,payment_method,note,receipt_url,source,voided_at,void_reason,created_at,account_id,` +
        `supplier_name,supplier_tax_id,supplier_branch_code,tax_invoice_no,tax_invoice_date,wht_rate,wht_amount,wht_type` +
        `&restaurant_id=eq.${rid}&spent_on=gte.${r.from}&spent_on=lte.${r.to}&order=spent_on.desc,created_at.desc&limit=1000`,
    )
    return c.json({ expenses })
  })

  app.post('/accounting/expenses', auth, async (c) => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, WRITE)
    if (typeof rid !== 'string') return rid
    const amount = Number(b.amount)
    const vat = Number(b.vat_amount ?? 0)
    if (typeof b.account_id !== 'string' || !UUID.test(b.account_id)) {
      return fail(c, 400, 'category_required', { message: 'ต้องเลือกหมวดรายจ่าย' })
    }
    if (!(amount > 0) || amount > 100_000_000 || !(vat >= 0) || vat > amount) return fail(c, 400, 'invalid_amount', { message: 'จำนวนเงินไม่ถูกต้อง' })
    if (!['cash', 'bank', 'credit'].includes(String(b.payment_method ?? 'cash'))) return fail(c, 400, 'invalid_payment_method')
    if (b.spent_on !== undefined && !validDate(b.spent_on)) return fail(c, 400, 'invalid_date')
    // ผู้ขาย / ใบกำกับภาษีซื้อ / หัก ณ ที่จ่าย (0031) · ฐานข้อมูลคิดยอดหัก ณ ที่จ่ายและแบบ ภ.ง.ด. เอง
    const opt = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
    const tax = {
      supplier_name: opt(b.supplier_name, 200),
      supplier_tax_id: opt(b.supplier_tax_id, 13),
      supplier_branch_code: opt(b.supplier_branch_code, 5),
      tax_invoice_no: opt(b.tax_invoice_no, 50),
      tax_invoice_date: b.tax_invoice_date ?? null,
      wht_rate: b.wht_rate ?? null,
      wht_type: b.wht_type ?? null,
    }
    if (tax.supplier_tax_id && !TAX_ID.test(tax.supplier_tax_id)) return fail(c, 400, 'invalid_supplier_tax_id', { message: 'เลขผู้เสียภาษี 13 หลัก' })
    if (tax.supplier_branch_code && !/^[0-9]{5}$/.test(tax.supplier_branch_code)) return fail(c, 400, 'invalid_supplier_branch_code')
    if (tax.tax_invoice_date !== null && !validDate(tax.tax_invoice_date)) return fail(c, 400, 'invalid_date')
    if ((tax.tax_invoice_no === null) !== (tax.tax_invoice_date === null) || (tax.tax_invoice_no && (!tax.supplier_name || !tax.supplier_tax_id))) {
      return fail(c, 400, 'invalid_tax_invoice', { message: 'ใบกำกับภาษีซื้อต้องมีเลขที่ วันที่ ชื่อและเลขผู้เสียภาษีของผู้ขาย' })
    }
    if (tax.wht_rate !== null && (!WHT_RATES.includes(Number(tax.wht_rate)) || !tax.supplier_name || !tax.supplier_tax_id)) {
      return fail(c, 400, 'invalid_wht', { message: 'หัก ณ ที่จ่าย: อัตรา 1, 2, 3 หรือ 5% และต้องมีชื่อ/เลขผู้เสียภาษีของผู้ขาย' })
    }
    // แบบ ภ.ง.ด. (ไม่ส่ง = ฐานข้อมูลเลือกจากเลขผู้เสียภาษี) · ต้องตรงกับประเภทผู้ขาย: ขึ้นต้น 0 = นิติบุคคล = ภ.ง.ด.53
    if (tax.wht_type !== null) {
      if (tax.wht_rate === null || !WHT_TYPES.includes(tax.wht_type as WhtType)) {
        return fail(c, 400, 'invalid_wht_type', { message: 'แบบหัก ณ ที่จ่ายต้องเป็น pnd3 หรือ pnd53 และต้องระบุอัตรา' })
      }
      if (tax.wht_type !== whtTypeFor(tax.supplier_tax_id ?? '')) {
        return fail(c, 400, 'wht_type_mismatch', { message: 'ภ.ง.ด.53 ใช้กับนิติบุคคล (เลขผู้เสียภาษีขึ้นต้นด้วย 0) · ภ.ง.ด.3 ใช้กับบุคคลธรรมดา' })
      }
    }
    const taxFields = Object.fromEntries(
      Object.entries({ ...tax, wht_rate: tax.wht_rate === null ? null : Number(tax.wht_rate) }).filter(([, v]) => v !== null),
    )
    const [row] = await db(c).insert('expenses', {
      ...taxFields,
      restaurant_id: rid,
      category: 'other', // ฐานข้อมูลตั้งหมวดแบบเดิมจากบัญชีให้
      account_id: b.account_id,
      amount,
      vat_amount: vat,
      payment_method: b.payment_method ?? 'cash',
      ...(b.spent_on ? { spent_on: b.spent_on } : {}),
      note: typeof b.note === 'string' ? b.note.trim().slice(0, 300) || null : null,
      receipt_url: typeof b.receipt_url === 'string' ? b.receipt_url.slice(0, 500) : null,
    })
    return c.json({ expense: row }, 201)
  })

  app.post('/accounting/expenses/:id/void', auth, async (c) => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, WRITE)
    if (typeof rid !== 'string') return rid
    const id = c.req.param('id')
    if (!UUID.test(id)) return fail(c, 400, 'invalid_expense_id')
    if (typeof b.reason !== 'string' || !b.reason.trim()) return fail(c, 400, 'reason_required', { message: 'ต้องใส่เหตุผล' })
    const entry = await db(c).rpc<string>('acct_void_expense', { p_expense_id: id, p_reason: b.reason })
    return c.json({ voided: id, reversal_entry_id: entry })
  })

  app.post('/accounting/supplier-payments', auth, async (c) => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, WRITE)
    if (typeof rid !== 'string') return rid
    if (b.date !== undefined && !validDate(b.date)) return fail(c, 400, 'invalid_date')
    const entry = await db(c).rpc<string>('acct_pay_supplier', {
      p_restaurant_id: rid, p_amount: Number(b.amount), p_payment_method: b.payment_method,
      p_supplier: b.supplier ?? null, p_date: b.date ?? null, p_note: b.note ?? null,
    })
    return c.json({ entry_id: entry }, 201)
  })

  // ----- ยกเลิกบิลหลังจ่าย / กลับรายการ (เจ้าของ ต้องมีเหตุผล) -----
  app.post('/accounting/bills/:orderId/cancel', auth, async (c) => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, OWNER)
    if (typeof rid !== 'string') return rid
    const orderId = c.req.param('orderId')
    if (!UUID.test(orderId)) return fail(c, 400, 'invalid_order_id')
    const reason = typeof b.reason === 'string' ? b.reason.trim() : ''
    if (!reason || reason.length > 200) return fail(c, 400, 'reason_required', { message: 'ต้องใส่เหตุผล (ไม่เกิน 200 ตัวอักษร)' })
    const rows = await db(c).update<{ id: string }>(
      `orders?id=eq.${orderId}&restaurant_id=eq.${rid}&status=eq.paid&select=id`,
      { status: 'cancelled', cancel_reason: reason },
    )
    if (rows.length === 0) return fail(c, 404, 'not_found', { message: 'ไม่พบบิลที่จ่ายแล้ว' })
    return c.json({ cancelled: orderId })
  })

  app.post('/accounting/entries/:id/reverse', auth, async (c) => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, OWNER)
    if (typeof rid !== 'string') return rid
    const id = c.req.param('id')
    if (!UUID.test(id)) return fail(c, 400, 'invalid_entry_id')
    if (typeof b.reason !== 'string' || !b.reason.trim()) return fail(c, 400, 'reason_required', { message: 'ต้องใส่เหตุผล' })
    const entry = await db(c).rpc<string>('acct_reverse_entry', { p_entry_id: id, p_reason: b.reason })
    return c.json({ reversal_entry_id: entry })
  })

  app.post('/accounting/opening', auth, async (c) => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, OWNER)
    if (typeof rid !== 'string') return rid
    const entry = await db(c).rpc<string>('acct_set_opening', {
      p_restaurant_id: rid, p_cash: Number(b.cash ?? 0), p_bank: Number(b.bank ?? 0), p_date: b.date ?? null,
    })
    return c.json({ entry_id: entry }, 201)
  })

  // ----- ปิดวัน: สรุป -> นับเงินสด -> ยืนยัน (ล็อกวัน) -> ส่งสรุปเข้า LINE -----
  app.get('/accounting/day', auth, async (c) => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), READ)
    if (typeof rid !== 'string') return rid
    const date = c.req.query('date')
    if (!validDate(date)) return fail(c, 400, 'invalid_date')
    const s = await db(c).rpc<Record<string, unknown>>('acct_day_summary', { p_restaurant_id: rid, p_date: date })
    return c.json({ ...s, metrics: metrics(normalizeSummary(s)) })
  })

  app.post('/accounting/day-close', auth, async (c) => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, CLOSE)
    if (typeof rid !== 'string') return rid
    if (!validDate(b.date)) return fail(c, 400, 'invalid_date')
    const counted = Number(b.counted_cash)
    if (b.counted_cash === undefined || b.counted_cash === null || !(counted >= 0)) {
      return fail(c, 400, 'invalid_amount', { message: 'กรอกยอดเงินสดที่นับได้' })
    }
    const result = await db(c).rpc<DayClose>('acct_close_day', {
      p_restaurant_id: rid, p_date: b.date, p_counted_cash: counted, p_note: typeof b.note === 'string' ? b.note : null,
    })
    // ส่ง LINE เป็นงานเสริม: ส่งไม่ได้ก็ยังปิดวันสำเร็จ
    let line: 'sent' | 'not_configured' | 'failed' = 'not_configured'
    if (b.notify !== false && c.env.LINE_CHANNEL_ACCESS_TOKEN) {
      const settings = await db(c).select<{ line_to: string | null }>(`shop_settings?select=line_to&restaurant_id=eq.${rid}`)
      const to = settings[0]?.line_to
      if (to) {
        try {
          await pushLine(c.env.LINE_CHANNEL_ACCESS_TOKEN, to, dayCloseText(result))
          line = 'sent'
        } catch (e) {
          if (!(e instanceof LineError)) throw e
          console.error('day close line failed', e.message)
          line = 'failed'
        }
      }
    }
    return c.json({ close: result, line }, 201)
  })

  // ----- ตั้งค่าบัญชี (เจ้าของ) · onboarding: ส่ง onboarded=true -----
  app.get('/accounting/settings', auth, async (c) => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), READ)
    if (typeof rid !== 'string') return rid
    const d = normalizeDashboard(await db(c).rpc<Record<string, unknown>>('acct_dashboard', { p_restaurant_id: rid }))
    return c.json({ settings: d.settings })
  })

  app.patch('/accounting/settings', auth, async (c) => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, OWNER)
    if (typeof rid !== 'string') return rid
    const patch = pickSettings(b)
    if (!patch || Object.keys(patch).length === 0) return fail(c, 400, 'invalid_request', { message: 'ค่าตั้งค่าไม่ถูกต้อง' })
    const updated = await db(c).update(`shop_settings?restaurant_id=eq.${rid}`, patch)
    if (updated.length === 0) await db(c).insert('shop_settings', { restaurant_id: rid, ...patch })
    return c.json({ saved: Object.keys(patch) })
  })

  // ----- ส่งออกให้นักบัญชี: CSV (UTF-8 BOM) หรือ Excel (.xls XML) -----
  app.get('/accounting/export', auth, async (c) => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), READ)
    if (typeof rid !== 'string') return rid
    const r = range(c)
    if (!r) return fail(c, 400, 'invalid_range')
    const format = c.req.query('format') ?? 'csv'
    if (format !== 'csv' && format !== 'xls') return fail(c, 400, 'invalid_format', { message: 'format ต้องเป็น csv หรือ xls' })
    const report = c.req.query('report') ?? 'journal'
    const table = await exportTable(db(c), rid, report, r.from, r.to)
    if (!table) return fail(c, 400, 'invalid_report', { message: 'report: journal | trial_balance | summary | menu_profit | expenses' })
    const name = `plato-${report}-${r.from}_${r.to}.${format}`
    const content = format === 'csv' ? toCsv(table.header, table.rows) : toExcelXml(table.title, table.header, table.rows)
    return new Response(content, {
      headers: {
        'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.ms-excel; charset=utf-8',
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'no-store',
      },
    })
  })

  // ----- รายงานภาษีตามแบบกรมสรรพากร (รายเดือน) · format=json (ค่าเริ่มต้น) | csv -----
  const csvFile = (name: string, content: string) =>
    new Response(content, {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' },
    })
  async function taxReportInput(c: Ctx) {
    const rid = await requireRole(c, c.req.query('restaurant_id'), READ)
    if (typeof rid !== 'string') return rid
    const m = monthRange(c.req.query('month'))
    if (!m) return fail(c, 400, 'invalid_month', { message: 'ใส่ month เป็น YYYY-MM' })
    const format = c.req.query('format') ?? 'json'
    if (format !== 'json' && format !== 'csv') return fail(c, 400, 'invalid_format', { message: 'format ต้องเป็น json หรือ csv' })
    return { rid, m, format }
  }

  // รายงานภาษีขาย (ภ.พ.30) จากเอกสารภาษีที่ยืนยันแล้ว
  app.get('/accounting/reports/sales-tax', auth, async (c) => {
    const p = await taxReportInput(c)
    if (p instanceof Response) return p
    const [seller, rep] = await Promise.all([sellerOf(db(c), p.rid), salesTaxData(db(c), p.rid, p.m.from, p.m.to)])
    if (p.format === 'json') return c.json({ month: p.m.month, period: { from: p.m.from, to: p.m.to }, seller, ...rep })
    const t = rep.totals
    return csvFile(
      `sales-tax-${p.m.month}.csv`,
      reportCsv('รายงานภาษีขาย', sellerMeta(seller, p.m.label), SALES_TAX_HEADER, rep.rows.map(salesTaxCells), ['', '', '', 'รวม', '', '', t.taxable, t.exempt, t.vat, t.total, '']),
    )
  })

  // รายงานภาษีซื้อ จากรายจ่ายที่มีใบกำกับภาษีซื้อ (ตาราง expenses)
  app.get('/accounting/reports/purchase-tax', auth, async (c) => {
    const p = await taxReportInput(c)
    if (p instanceof Response) return p
    const [seller, rep] = await Promise.all([sellerOf(db(c), p.rid), purchaseTaxData(db(c), p.rid, p.m.from, p.m.to)])
    if (p.format === 'json') return c.json({ month: p.m.month, period: { from: p.m.from, to: p.m.to }, seller, ...rep })
    const t = rep.totals
    return csvFile(
      `purchase-tax-${p.m.month}.csv`,
      reportCsv('รายงานภาษีซื้อ', sellerMeta(seller, p.m.label), PURCHASE_TAX_HEADER, rep.rows.map(purchaseTaxCells), ['', '', '', 'รวม', '', '', t.value, t.vat, t.total, '']),
    )
  })

  // สรุป ภ.พ.30: ภาษีขาย - ภาษีซื้อ
  app.get('/accounting/reports/pp30-summary', auth, async (c) => {
    const p = await taxReportInput(c)
    if (p instanceof Response) return p
    const [seller, sales, purchases] = await Promise.all([
      sellerOf(db(c), p.rid),
      salesTaxData(db(c), p.rid, p.m.from, p.m.to),
      purchaseTaxData(db(c), p.rid, p.m.from, p.m.to),
    ])
    const summary = pp30Summary(sales.totals, purchases.totals)
    if (p.format === 'json') {
      return c.json({
        month: p.m.month, period: { from: p.m.from, to: p.m.to }, seller, summary,
        counts: { sales_lines: sales.rows.length, purchase_invoices: purchases.rows.length },
        purchases_without_invoice: purchases.without_invoice,
      })
    }
    const rows: Cell[][] = [
      ['1', 'ยอดขายในเดือนนี้', summary.sales_total],
      ['2', 'หัก ยอดขายที่เสียภาษีในอัตรา 0 / ได้รับยกเว้น', summary.sales_exempt_or_zero],
      ['3', 'ยอดขายที่ต้องเสียภาษี', summary.sales_taxable],
      ['4', 'ภาษีขายเดือนนี้', summary.output_vat],
      ['5', 'ยอดซื้อที่มีสิทธินำภาษีซื้อมาหัก', summary.purchases_eligible],
      ['6', 'ภาษีซื้อเดือนนี้', summary.input_vat],
      ['7', 'ภาษีที่ต้องชำระเดือนนี้', summary.vat_payable],
      ['8', 'ภาษีที่ชำระเกินเดือนนี้', summary.vat_credit],
    ]
    return csvFile(`pp30-${p.m.month}.csv`, reportCsv('สรุปภาษีมูลค่าเพิ่ม (ภ.พ.30)', sellerMeta(seller, p.m.label), ['ข้อ', 'รายการ', 'จำนวนเงิน (บาท)'], rows))
  })

  // สรุปภาษีหัก ณ ที่จ่าย (ภ.ง.ด.3 / ภ.ง.ด.53) · type=pnd3|pnd53 (ไม่ใส่ = ทั้งสองแบบ)
  app.get('/accounting/reports/wht', auth, async (c) => {
    const p = await taxReportInput(c)
    if (p instanceof Response) return p
    const type = c.req.query('type')
    if (type !== undefined && type !== 'pnd3' && type !== 'pnd53') return fail(c, 400, 'invalid_type', { message: 'type ต้องเป็น pnd3 หรือ pnd53' })
    const [seller, rows] = await Promise.all([
      sellerOf(db(c), p.rid),
      selectAll<WhtExpenseRow>(
        db(c),
        `expenses?select=spent_on,supplier_name,supplier_tax_id,supplier_branch_code,amount,vat_amount,wht_rate,wht_amount,wht_type,note,accounts(name)` +
          `&restaurant_id=eq.${p.rid}&voided_at=is.null&spent_on=gte.${p.m.from}&spent_on=lte.${p.m.to}` +
          `&wht_type=${type ? `eq.${type}` : 'not.is.null'}&order=spent_on,id`,
      ),
    ])
    const rep = whtReport(rows)
    if (p.format === 'json') return c.json({ month: p.m.month, period: { from: p.m.from, to: p.m.to }, type: type ?? 'all', seller, ...rep })
    const total = rep.rows.reduce((a, r) => ({ paid: a.paid + Math.round(r.paid_amount * 100), wht: a.wht + Math.round(r.wht * 100) }), { paid: 0, wht: 0 })
    const title = type === 'pnd3' ? 'ภ.ง.ด.3' : type === 'pnd53' ? 'ภ.ง.ด.53' : 'ภ.ง.ด.3 / ภ.ง.ด.53'
    return csvFile(
      `wht-${type ?? 'all'}-${p.m.month}.csv`,
      reportCsv(`สรุปภาษีหัก ณ ที่จ่าย (${title})`, sellerMeta(seller, p.m.label), WHT_HEADER, rep.rows.map(whtCells), ['', '', '', '', 'รวม', '', '', '', total.paid / 100, total.wht / 100]),
    )
  })

  // ----- กะแคชเชียร์: เปิดกะ → เงินเข้า/ออกลิ้นชัก → ปิดกะ (Z-Report) -----
  async function shiftOf(c: Ctx, rid: string, id: unknown): Promise<string | Response> {
    if (typeof id !== 'string' || !UUID.test(id)) return fail(c, 400, 'invalid_shift_id')
    const rows = await db(c).select<{ id: string }>(`cashier_shifts?select=id&id=eq.${id}&restaurant_id=eq.${rid}`)
    return rows.length ? id : fail(c, 404, 'not_found', { message: 'ไม่พบกะ' })
  }

  app.post('/shifts/open', auth, async (c) => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, SHIFT)
    if (typeof rid !== 'string') return rid
    const cash = Number(b.starting_cash)
    if (b.starting_cash === undefined || b.starting_cash === null || !(cash >= 0) || cash > 10_000_000) {
      return fail(c, 400, 'invalid_amount', { message: 'กรอกเงินทอนตั้งต้น' })
    }
    if (b.terminal_code !== undefined && b.terminal_code !== null && !/^[A-Za-z0-9]{1,10}$/.test(String(b.terminal_code))) {
      return fail(c, 400, 'invalid_terminal_code')
    }
    const shift = await db(c).rpc('shift_open', { p_restaurant_id: rid, p_starting_cash: cash, p_terminal_code: b.terminal_code ?? null })
    return c.json({ shift }, 201)
  })

  app.post('/shifts/cash-movement', auth, async (c) => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, SHIFT)
    if (typeof rid !== 'string') return rid
    const sid = await shiftOf(c, rid, b.shift_id)
    if (typeof sid !== 'string') return sid
    const type = String(b.type ?? '')
    if (type !== 'cash_in' && type !== 'cash_out') return fail(c, 400, 'invalid_log_type', { message: 'type ต้องเป็น cash_in หรือ cash_out' })
    const amount = Number(b.amount)
    if (!(amount > 0) || amount > 10_000_000) return fail(c, 400, 'invalid_amount', { message: 'จำนวนเงินไม่ถูกต้อง' })
    const reason = typeof b.reason === 'string' ? b.reason.trim() : ''
    if (!reason || reason.length > 300) return fail(c, 400, 'reason_required', { message: 'ต้องใส่เหตุผล (ไม่เกิน 300 ตัวอักษร)' })
    const log = await db(c).rpc('shift_cash_log', { p_shift_id: sid, p_log_type: type, p_amount: amount, p_reason: reason })
    return c.json({ log }, 201)
  })

  app.post('/shifts/close', auth, async (c) => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, SHIFT)
    if (typeof rid !== 'string') return rid
    const sid = await shiftOf(c, rid, b.shift_id)
    if (typeof sid !== 'string') return sid
    const actual = Number(b.actual_cash)
    if (b.actual_cash === undefined || b.actual_cash === null || !(actual >= 0) || actual > 10_000_000) {
      return fail(c, 400, 'invalid_amount', { message: 'กรอกยอดเงินสดที่นับได้' })
    }
    const shift = await db(c).rpc<Record<string, unknown>>('shift_close', {
      p_shift_id: sid, p_actual_cash: actual, p_note: typeof b.note === 'string' ? b.note.slice(0, 300) : null,
    })
    const report = await db(c).rpc<ShiftReport>('shift_report', { p_shift_id: sid })
    // เอกสารภาษีที่ยืนยันระหว่างกะ: เครื่องของกะ หรือ (ไม่ผูกเครื่อง) ผู้ยืนยันคือแคชเชียร์
    const who = shift.terminal_id ? `terminal_id=eq.${shift.terminal_id}` : `confirmed_by=eq.${shift.cashier_id}`
    const docs = await selectAll<ShiftTaxDoc>(
      db(c),
      `tax_documents?select=doc_type,doc_number,ref_document_id,vat_amount,total_amount&restaurant_id=eq.${rid}&status=eq.confirmed&${who}` +
        `&confirmed_at=gte.${encodeURIComponent(String(shift.opened_at))}&confirmed_at=lte.${encodeURIComponent(String(shift.closed_at))}&order=doc_number`,
    )
    return c.json({ shift, z_report: zReport(report, docs) })
  })
}
