// API โมดูลบัญชี (0026) · ทุก endpoint เรียกฐานข้อมูลด้วย JWT ของผู้ใช้ (RLS + has_role ตรวจซ้ำ)
// สูตร Food/Prime Cost กำไร งบดุล และไฟล์ส่งออกใช้ร่วมกับหน้าเว็บ (frontend/src/lib/accounting.ts)
import type { Context, Hono, MiddlewareHandler } from 'hono'
import type { AppEnv, Role } from './env.ts'
import { asUser } from './supabase.ts'
import { LineError, pushLine } from './reports.ts'
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
      `expenses?select=id,spent_on,amount,vat_amount,payment_method,note,receipt_url,source,voided_at,void_reason,created_at,account_id` +
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
    const [row] = await db(c).insert('expenses', {
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
}
