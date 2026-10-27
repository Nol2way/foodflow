// โมดูลบัญชี (0026): สูตรคำนวณ ข้อความแจ้งเตือน และไฟล์ส่งออก
// ฐานข้อมูลส่งยอดดิบ (acct_summary_data / acct_dashboard / acct_trial_balance) สูตรทั้งหมดอยู่ที่นี่
// ใช้ร่วมกันทั้งหน้าเว็บและ backend (ส่งออก CSV/Excel, ข้อความปิดวันทาง LINE) · ทดสอบใน tests/accounting.test.ts
// หมายเหตุ: ระบบนี้ไม่ใช่เครื่องมือยื่นภาษีอย่างเป็นทางการ ตัวเลขด้านภาษีเป็นข้อมูลประกอบ ควรให้นักบัญชีตรวจ

export type AccountingMode = 'simple' | 'standard' | 'pro'
export type AccountGroup =
  | 'cash' | 'bank' | 'stock' | 'claim' | 'vat_in' | 'other_asset'
  | 'ap' | 'vat_out' | 'other_liability' | 'equity'
  | 'sales' | 'discount' | 'other_income'
  | 'food_cost' | 'labor' | 'opex'
export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'

export interface AmountRow {
  code: string
  name: string
  amount: number
  grp?: AccountGroup
}

// ยอดดิบของช่วงวันที่ (acct_summary_data) · ตัวเลขจาก Postgres numeric มาเป็น string ได้ ใช้ normalizeSummary ก่อน
export interface Summary {
  from: string
  to: string
  sales: number
  sales_by_account: AmountRow[]
  discounts: number
  other_income: number
  cogs_recipe: number
  stock_variance: number
  food_cost: number
  labor: number
  opex: number
  expenses_by_account: AmountRow[]
  cash_open: number
  cash_close: number
  cash_in: number
  cash_out: number
  cash_drawer: number
  cash_by_source: { source_type: string; in: number; out: number }[]
  stock_open: number
  stock_close: number
  stock_in: number
  vat_output: number
  vat_input: number
  bills: number
  cancelled_bills: number
}

export interface AccountingSettings {
  accounting_mode: AccountingMode
  business_type: 'individual' | 'company'
  vat_registered: boolean
  vat_rate: number
  receipt_payment_default: 'cash' | 'bank' | 'credit'
  food_cost_target_min: number
  food_cost_target_max: number
  prime_cost_target_min: number
  prime_cost_target_max: number
  onboarded: boolean
}

export interface Reconcile {
  stock_value: number
  ledger_value: number
  difference: number
  ok: boolean
}

export type PeriodKey = 'today' | 'd7' | 'd30' | 'month' | 'prev_month' | 'ytd'

export interface Dashboard {
  today: string
  periods: Record<PeriodKey, Summary>
  reconcile: Reconcile
  last_close: string | null
  unclosed_days: number
  settings: AccountingSettings
}

export interface TrialRow {
  account_id: string
  code: string
  name: string
  type: AccountType
  grp: AccountGroup
  opening: number
  debit: number
  credit: number
  closing: number // เดบิต - เครดิต (บวก = ยอดดุลเดบิต)
}

const n = (v: unknown) => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
export const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100

const NUMERIC_KEYS = [
  'sales', 'discounts', 'other_income', 'cogs_recipe', 'stock_variance', 'food_cost', 'labor', 'opex',
  'cash_open', 'cash_close', 'cash_in', 'cash_out', 'cash_drawer', 'stock_open', 'stock_close', 'stock_in',
  'vat_output', 'vat_input', 'bills', 'cancelled_bills',
] as const

export function normalizeSummary(raw: Record<string, unknown>): Summary {
  const s = { ...raw } as Record<string, unknown>
  for (const k of NUMERIC_KEYS) s[k] = n(raw[k])
  const rows = (v: unknown) => ((v as AmountRow[] | null) ?? []).map((r) => ({ ...r, amount: n(r.amount) }))
  s.sales_by_account = rows(raw.sales_by_account)
  s.expenses_by_account = rows(raw.expenses_by_account)
  s.cash_by_source = ((raw.cash_by_source as Summary['cash_by_source'] | null) ?? []).map((r) => ({ ...r, in: n(r.in), out: n(r.out) }))
  return s as unknown as Summary
}

export function normalizeDashboard(raw: Record<string, unknown>): Dashboard {
  const periods = raw.periods as Record<PeriodKey, Record<string, unknown>>
  const rec = raw.reconcile as Record<string, unknown>
  const set = raw.settings as Record<string, unknown>
  return {
    today: String(raw.today),
    periods: Object.fromEntries(Object.entries(periods).map(([k, v]) => [k, normalizeSummary(v)])) as Record<PeriodKey, Summary>,
    reconcile: { stock_value: n(rec.stock_value), ledger_value: n(rec.ledger_value), difference: n(rec.difference), ok: Boolean(rec.ok) },
    last_close: (raw.last_close as string | null) ?? null,
    unclosed_days: n(raw.unclosed_days),
    settings: {
      ...(set as unknown as AccountingSettings),
      vat_rate: n(set.vat_rate),
      food_cost_target_min: n(set.food_cost_target_min),
      food_cost_target_max: n(set.food_cost_target_max),
      prime_cost_target_min: n(set.prime_cost_target_min),
      prime_cost_target_max: n(set.prime_cost_target_max),
    },
  }
}

export const pct = (part: number, whole: number): number | null => (whole > 0 ? round2((part / whole) * 100) : null)

// ===== มุมมองมาตรฐาน: ยอดขาย - ต้นทุนอาหารที่ใช้จริง - ค่าใช้จ่าย = กำไร =====
export interface Metrics {
  netSales: number // ยอดขายหลังหักส่วนลด
  foodCost: number // ต้นทุนอาหารที่ใช้จริง (ตามสูตร + ส่วนต่างสต็อก + วัตถุดิบนอกสต็อก + ส่วนต่างรับสินค้า)
  cogsActual: number // ต้นทุนขายจริง = ตามสูตร + ส่วนต่างสต็อก
  grossProfit: number
  labor: number
  opex: number
  expenses: number // ค่าแรง + ค่าใช้จ่ายดำเนินงาน
  netProfit: number
  foodCostPct: number | null
  primeCostPct: number | null // (ต้นทุนอาหาร + ค่าแรง) / ยอดขายสุทธิ
  netMarginPct: number | null
}

export function metrics(s: Summary): Metrics {
  const netSales = round2(s.sales - s.discounts)
  const grossProfit = round2(netSales - s.food_cost)
  const expenses = round2(s.labor + s.opex)
  return {
    netSales,
    foodCost: round2(s.food_cost),
    cogsActual: round2(s.cogs_recipe + s.stock_variance),
    grossProfit,
    labor: round2(s.labor),
    opex: round2(s.opex),
    expenses,
    netProfit: round2(grossProfit + s.other_income - expenses),
    foodCostPct: pct(s.food_cost, netSales),
    primeCostPct: pct(s.food_cost + s.labor, netSales),
    netMarginPct: pct(grossProfit + s.other_income - expenses, netSales),
  }
}

// perpetual: ต้นทุนขายจริง (ตามสูตร + ส่วนต่าง) ต้องเท่ากับ ต้นงวด + รับเข้า - ปลายงวด
export function stockCheck(s: Summary) {
  const usage = round2(s.stock_open + s.stock_in - s.stock_close)
  const cogsActual = round2(s.cogs_recipe + s.stock_variance)
  return { opening: s.stock_open, purchases: s.stock_in, closing: s.stock_close, usage, cogsActual, matches: Math.abs(usage - cogsActual) < 0.005 }
}

// เทียบกับเป้า (Food Cost 28–35% · Prime Cost 60–65%) สำหรับแถบสี
export type Band = 'none' | 'low' | 'ok' | 'high'
export function band(value: number | null, min: number, max: number): Band {
  if (value === null) return 'none'
  if (value > max) return 'high'
  if (value < min) return 'low'
  return 'ok'
}

export const changePct = (now: number, before: number): number | null =>
  before === 0 ? null : round2(((now - before) / Math.abs(before)) * 100)

// ===== มุมมองง่าย: เงินเข้า / เงินออก / คงเหลือ (มุมมองเงินสด ซื้อของ = รายจ่ายวันนั้น) =====
export function cashView(s: Summary) {
  return { in: round2(s.cash_in), out: round2(s.cash_out), net: round2(s.cash_in - s.cash_out), balance: round2(s.cash_close) }
}

export const SOURCE_LABEL: Record<string, string> = {
  bill: 'ขาย',
  stock_receipt: 'ซื้อวัตถุดิบ',
  recipe_deduct: 'ตัดตามสูตร',
  count_adjust: 'ปรับจากการนับ',
  expense: 'รายจ่าย',
  reversal: 'กลับรายการ',
  day_close: 'ปิดวัน',
  waste: 'ของเสีย',
  production: 'ผลิตของเตรียม',
  stock_revalue: 'ปรับมูลค่าสต็อก',
  supplier_claim: 'ของขาดจากผู้ขาย',
  supplier_payment: 'จ่ายเจ้าหนี้',
  opening: 'ยอดยกมา',
}

// ===== งบกระแสเงินสด (วิธีทางตรง) จากรายการที่กระทบเงินสด/ธนาคาร =====
export function cashFlow(s: Summary) {
  const rows = s.cash_by_source.map((r) => ({ label: SOURCE_LABEL[r.source_type] ?? r.source_type, ...r, net: round2(r.in - r.out) }))
  const operating = round2(rows.reduce((a, r) => a + r.net, 0))
  // ยอดยกมา/เงินทุนที่เจ้าของใส่เพิ่ม (รายการ opening) = กิจกรรมจัดหาเงิน
  const financing = round2(s.cash_close - s.cash_open - operating)
  return { open: round2(s.cash_open), rows, operating, financing, close: round2(s.cash_close) }
}

// ===== งบดุล จากงบทดลอง (ยอดคงเหลือ ณ วันสิ้นงวด) =====
export function balanceSheet(rows: TrialRow[]) {
  const pick = (t: AccountType, sign: 1 | -1) =>
    rows.filter((r) => r.type === t && r.closing !== 0).map((r) => ({ code: r.code, name: r.name, amount: round2(sign * r.closing) }))
  const sum = (xs: { amount: number }[]) => round2(xs.reduce((a, x) => a + x.amount, 0))
  const assets = pick('asset', 1)
  const liabilities = pick('liability', -1)
  const equity = pick('equity', -1)
  // กำไรสะสม (ยังไม่ปิดบัญชี) = -(รายได้ + ค่าใช้จ่าย) ในรูปเดบิต-เครดิต
  const earnings = round2(-rows.filter((r) => r.type === 'revenue' || r.type === 'expense').reduce((a, r) => a + r.closing, 0))
  const totalAssets = sum(assets)
  const totalLiabEquity = round2(sum(liabilities) + sum(equity) + earnings)
  return { assets, liabilities, equity, earnings, totalAssets, totalLiabEquity, balanced: Math.abs(totalAssets - totalLiabEquity) < 0.005 }
}

// ===== เกณฑ์จด VAT: รายรับสะสมในปีเกิน 1.8 ล้านบาท ต้องจดภายใน 30 วัน =====
export const VAT_THRESHOLD = 1_800_000
export function vatThreshold(ytdSales: number, registered: boolean) {
  const ratio = ytdSales / VAT_THRESHOLD
  const level: 'none' | 'info' | 'warn' | 'danger' = registered ? 'none' : ratio >= 1 ? 'danger' : ratio >= 0.8 ? 'warn' : ratio >= 0.5 ? 'info' : 'none'
  return { level, pct: round2(ratio * 100), remaining: round2(Math.max(VAT_THRESHOLD - ytdSales, 0)) }
}

// ===== ภาษีเงินได้บุคคลธรรมดา: หักค่าใช้จ่ายเหมา 60% vs ตามจริง (ข้อมูลประกอบ ไม่ใช่คำแนะนำภาษี) =====
export function taxDeductionCompare(s: Summary) {
  const income = round2(s.sales - s.discounts + s.other_income)
  const flat = round2(income * 0.6)
  const actual = round2(s.food_cost + s.labor + s.opex)
  return {
    income,
    flatExpense: flat,
    flatNet: round2(income - flat),
    actualExpense: actual,
    actualNet: round2(income - actual),
    lowerNet: actual > flat ? ('actual' as const) : actual < flat ? ('flat' as const) : ('same' as const),
  }
}

// ===== แจ้งเตือนบนแดชบอร์ด =====
export interface Alert {
  level: 'info' | 'warn' | 'danger'
  code: string
  text: string
}

const fmt = (x: number) => '฿' + x.toLocaleString('th-TH', { maximumFractionDigits: 2 })

export function alerts(d: Dashboard): Alert[] {
  const out: Alert[] = []
  if (!d.reconcile.ok) {
    out.push({
      level: 'danger',
      code: 'stock_mismatch',
      text: `มูลค่าสต็อก (${fmt(d.reconcile.stock_value)}) ไม่เท่ากับบัญชีสต็อก (${fmt(d.reconcile.ledger_value)}) ต่างกัน ${fmt(d.reconcile.difference)} ให้แจ้งผู้ดูแลระบบตรวจ`,
    })
  }
  const ytd = d.periods.ytd
  const v = vatThreshold(ytd.sales - ytd.discounts, d.settings.vat_registered)
  if (v.level === 'danger') {
    out.push({ level: 'danger', code: 'vat_threshold', text: `รายรับปีนี้ ${fmt(ytd.sales - ytd.discounts)} เกิน 1.8 ล้านบาทแล้ว ต้องจดทะเบียน VAT ภายใน 30 วัน (ปรึกษานักบัญชี)` })
  } else if (v.level === 'warn') {
    out.push({ level: 'warn', code: 'vat_threshold', text: `รายรับปีนี้ถึง ${v.pct}% ของเกณฑ์จด VAT 1.8 ล้านบาท (เหลือ ${fmt(v.remaining)})` })
  }
  const m = metrics(d.periods.d30)
  if (band(m.foodCostPct, d.settings.food_cost_target_min, d.settings.food_cost_target_max) === 'high') {
    out.push({ level: 'warn', code: 'food_cost_high', text: `Food Cost 30 วัน ${m.foodCostPct}% สูงกว่าเป้า ${d.settings.food_cost_target_max}%` })
  }
  if (band(m.primeCostPct, d.settings.prime_cost_target_min, d.settings.prime_cost_target_max) === 'high') {
    out.push({ level: 'warn', code: 'prime_cost_high', text: `Prime Cost 30 วัน ${m.primeCostPct}% สูงกว่าเป้า ${d.settings.prime_cost_target_max}%` })
  }
  if (d.unclosed_days > 0) {
    out.push({ level: 'info', code: 'unclosed_days', text: `มี ${d.unclosed_days} วันที่ยังไม่ได้ปิดวัน (นับเงินสดและยืนยันยอด)` })
  }
  return out
}

// ตอบคำถาม onboarding "จดบริษัทหรือจด VAT ไหม" แล้วเลือกโหมดให้
export function suggestMode(businessType: 'individual' | 'company', vatRegistered: boolean, wantsSimple = false): AccountingMode {
  if (businessType === 'company' || vatRegistered) return 'pro'
  return wantsSimple ? 'simple' : 'standard'
}

export const MODE_LABEL: Record<AccountingMode, string> = {
  simple: 'ง่าย',
  standard: 'มาตรฐาน',
  pro: 'มืออาชีพ',
}

// ===== ข้อความสรุปปิดวัน (ส่ง LINE) =====
export interface DayClose extends Summary {
  restaurant: string
  date: string
  system_cash: number
  counted_cash: number
  difference: number
}

export function dayCloseText(d: DayClose): string {
  const s = normalizeSummary(d as unknown as Record<string, unknown>)
  const m = metrics(s)
  const diff = n(d.difference)
  const lines = [
    `ปิดวัน ${d.restaurant} · ${d.date}`,
    `ยอดขายสุทธิ ${fmt(m.netSales)} (${s.bills} บิล${s.cancelled_bills ? ` · ยกเลิก ${s.cancelled_bills}` : ''})`,
    `ต้นทุนอาหาร ${fmt(m.foodCost)}${m.foodCostPct === null ? '' : ` (${m.foodCostPct}%)`}`,
    `ค่าใช้จ่าย ${fmt(m.expenses)}`,
    `กำไรวันนี้ ${fmt(m.netProfit)}`,
    `เงินเข้า ${fmt(s.cash_in)} · เงินออก ${fmt(s.cash_out)}`,
    `เงินสดตามระบบ ${fmt(n(d.system_cash))} · นับจริง ${fmt(n(d.counted_cash))}`,
    diff === 0 ? 'เงินสดตรงยอด' : diff > 0 ? `เงินสดเกิน ${fmt(diff)}` : `เงินสดขาด ${fmt(-diff)}`,
  ]
  return lines.join('\n')
}

// ===== ข้อผิดพลาดจากฐานข้อมูล -> ข้อความไทย =====
export const ACCOUNTING_ERRORS: Record<string, string> = {
  day_closed: 'วันนั้นปิดวันไปแล้ว บันทึกรายการเพิ่มไม่ได้ (เลือกวันที่อื่น หรือใช้กลับรายการ)',
  already_closed: 'วันนี้ปิดวันไปแล้ว',
  already_reversed: 'รายการนี้ถูกกลับรายการ/ยกเลิกไปแล้ว',
  reason_required: 'ต้องใส่เหตุผล',
  cancel_reason_required: 'ยกเลิกบิลที่จ่ายแล้วต้องใส่เหตุผล',
  expense_posted_use_void: 'รายจ่ายลงบัญชีแล้ว แก้ยอด/ลบไม่ได้ ให้ใช้ "ยกเลิกรายจ่าย" แล้วบันทึกใหม่',
  order_posted_use_cancel: 'ออเดอร์นี้ลงบัญชีแล้ว ลบไม่ได้ ให้ใช้ยกเลิกบิล',
  invalid_expense_account: 'เลือกหมวดรายจ่ายที่ใช้ได้',
  reverse_not_allowed: 'รายการประเภทนี้กลับรายการตรงไม่ได้ (บิลใช้ยกเลิกบิล รายจ่ายใช้ยกเลิกรายจ่าย สต็อกใช้ตรวจนับ)',
  system_account: 'บัญชีของระบบเปลี่ยนรหัส/กลุ่ม หรือปิดใช้งานไม่ได้',
  journal_immutable: 'รายการที่ลงบัญชีแล้วแก้ไขไม่ได้ ใช้กลับรายการแทน',
  invalid_amount: 'จำนวนเงินไม่ถูกต้อง',
  invalid_date: 'วันที่ไม่ถูกต้อง',
  invalid_status_change: 'เปลี่ยนสถานะบิลนี้ไม่ได้',
}

export function accountingErrorCode(message: string): string | null {
  const code = message.split(':')[0].trim()
  return code in ACCOUNTING_ERRORS ? code : null
}

export function accountingError(message: string): string {
  const code = accountingErrorCode(message)
  return code ? ACCOUNTING_ERRORS[code] : message
}

// ===== ไฟล์ส่งออกให้นักบัญชี =====
export type Cell = string | number | null | undefined

function csvCell(v: Cell): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  // กันสูตรใน Excel (CSV injection): ข้อความที่ขึ้นต้นด้วย = + - @ ใส่ ' นำหน้า (ตัวเลขติดลบปกติไม่โดน)
  const safe = typeof v === 'string' && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

// UTF-8 + BOM เพื่อให้ Excel เปิดภาษาไทยได้ถูกต้อง
export function toCsv(header: string[], rows: Cell[][]): string {
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Excel XML Spreadsheet 2003 (.xls) เปิดได้ใน Excel/LibreOffice/Google Sheets โดยไม่ต้องใช้ไลบรารีเพิ่ม
export function toExcelXml(sheet: string, header: string[], rows: Cell[][]): string {
  const cell = (v: Cell) =>
    typeof v === 'number' && Number.isFinite(v)
      ? `<Cell><Data ss:Type="Number">${v}</Data></Cell>`
      : `<Cell><Data ss:Type="String">${xml(v === null || v === undefined ? '' : String(v))}</Data></Cell>`
  const row = (r: Cell[], style = '') => `<Row${style}>${r.map(cell).join('')}</Row>`
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<?mso-application progid="Excel.Sheet"?>',
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
    '<Styles><Style ss:ID="h"><Font ss:Bold="1"/></Style></Styles>',
    `<Worksheet ss:Name="${xml(sheet.slice(0, 31))}"><Table>`,
    row(header, ' ss:StyleID="h"'),
    ...rows.map((r) => row(r)),
    '</Table></Worksheet></Workbook>',
  ].join('\n')
}
