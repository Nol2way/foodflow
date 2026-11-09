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

// ===== ภาษีตามกรมสรรพากร (0031/0032): ข้อมูลผู้ประกอบการ · ภาษีซื้อ · หัก ณ ที่จ่าย · เอกสารภาษี · รายงาน =====
// ทำงานในเครื่องทั้งหมด (สร้าง/ส่งออกไฟล์เอง) ไม่ส่งข้อมูลไปกรมสรรพากรหรือ API ภายนอก

// เลขประจำตัวผู้เสียภาษี 13 หลัก · checksum mod 11 (ตรงกับ th_tax_id_valid ในฐานข้อมูล)
export function thaiTaxIdValid(id: string): boolean {
  if (!/^\d{13}$/.test(id)) return false
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(id[i]) * (13 - i)
  return (11 - (sum % 11)) % 10 === Number(id[12])
}

export const BRANCH_CODE_RE = /^\d{5}$/
export const POSTCODE_RE = /^\d{5}$/
export const POS_REG_NO_RE = /^[A-Za-z0-9/-]{1,30}$/
export const TERMINAL_CODE_RE = /^[A-Z0-9]{1,10}$/
export const HEAD_OFFICE = '00000'

// ข้อมูลผู้ประกอบการ (ตาราง tax_settings) · พิมพ์บนใบกำกับภาษีและหัวรายงาน
export interface TaxSettingsForm {
  tax_id: string
  company_name: string
  branch_code: string
  branch_name: string
  registered_address: string
  postcode: string
}

export const EMPTY_TAX_SETTINGS: TaxSettingsForm = {
  tax_id: '',
  company_name: '',
  branch_code: HEAD_OFFICE,
  branch_name: '',
  registered_address: '',
  postcode: '',
}

export function validateTaxSettings(f: TaxSettingsForm): string | null {
  if (!thaiTaxIdValid(f.tax_id.trim())) return 'เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลักที่ถูกต้อง'
  const name = f.company_name.trim()
  if (name.length < 1 || name.length > 200) return 'กรอกชื่อผู้ประกอบการ/บริษัท (ไม่เกิน 200 ตัวอักษร)'
  if (!BRANCH_CODE_RE.test(f.branch_code.trim())) return 'รหัสสาขาต้องเป็นตัวเลข 5 หลัก (สำนักงานใหญ่ = 00000)'
  if (f.branch_name.trim().length > 100) return 'ชื่อสาขาไม่เกิน 100 ตัวอักษร'
  const addr = f.registered_address.trim()
  if (addr.length < 1 || addr.length > 500) return 'กรอกที่อยู่ตามที่จดทะเบียน (ไม่เกิน 500 ตัวอักษร)'
  if (f.postcode.trim() && !POSTCODE_RE.test(f.postcode.trim())) return 'รหัสไปรษณีย์ต้องเป็นตัวเลข 5 หลัก'
  return null
}

// แถวที่จะบันทึกลง tax_settings (ช่องว่าง = null)
export function taxSettingsRow(restaurantId: string, f: TaxSettingsForm) {
  return {
    restaurant_id: restaurantId,
    tax_id: f.tax_id.trim(),
    company_name: f.company_name.trim(),
    branch_code: f.branch_code.trim(),
    branch_name: f.branch_name.trim() || null,
    registered_address: f.registered_address.trim(),
    postcode: f.postcode.trim() || null,
  }
}

// เลขอนุมัติเครื่อง POS จากกรมสรรพากร (ว่าง = ยังไม่มี ออกใบอย่างย่อไม่ได้)
export function validatePosRegNo(v: string): string | null {
  const s = v.trim()
  return s === '' || POS_REG_NO_RE.test(s) ? null : 'เลขอนุมัติเครื่อง POS ใช้ได้เฉพาะ A-Z 0-9 / - ไม่เกิน 30 ตัว'
}

// ----- ภาษีซื้อ / หัก ณ ที่จ่าย ของรายจ่าย -----
export type WhtRate = 1 | 2 | 3 | 5
export const WHT_RATES: WhtRate[] = [1, 2, 3, 5]
export type WhtForm = 'pnd3' | 'pnd53'
export const WHT_FORM_LABEL: Record<WhtForm, string> = { pnd3: 'ภ.ง.ด.3 (บุคคลธรรมดา)', pnd53: 'ภ.ง.ด.53 (นิติบุคคล)' }
export const WHT_FORM_SHORT: Record<WhtForm, string> = { pnd3: 'ภ.ง.ด.3', pnd53: 'ภ.ง.ด.53' }

// นิติบุคคลเลขผู้เสียภาษีขึ้นต้นด้วย 0 → ภ.ง.ด.53 · อื่นๆ → ภ.ง.ด.3 (ฐานข้อมูลบังคับให้ตรงกัน)
export const whtFormFor = (taxId: string): WhtForm => (taxId.trim().startsWith('0') ? 'pnd53' : 'pnd3')

export interface ExpenseTaxCalc {
  vat: number // ภาษีซื้อ (แยกจากยอดรวม VAT)
  base: number // ฐานก่อน VAT
  wht: number // ภาษีหัก ณ ที่จ่าย (คิดจากฐานก่อน VAT ตรงกับ expenses_tax_fields)
  netPaid: number // เงินที่จ่ายจริงให้ผู้ขาย
}

// ใช้สตางค์ทั้งหมดเพื่อไม่ให้ปัดเศษเพี้ยน · VAT = ROUND(gross * rate / (100 + rate)) เหมือน tax_doc_split
export function expenseTax(amount: number, inputTax: boolean, whtRate: WhtRate | null, vatRate = 7): ExpenseTaxCalc {
  const gross = Math.round((Number.isFinite(amount) && amount > 0 ? amount : 0) * 100)
  const vat = inputTax ? Math.round((gross * vatRate) / (100 + vatRate)) : 0
  const base = gross - vat
  const wht = whtRate ? Math.round((base * whtRate) / 100) : 0
  return { vat: vat / 100, base: base / 100, wht: wht / 100, netPaid: (gross - wht) / 100 }
}

export interface ExpenseTaxForm {
  inputTax: boolean
  supplierName: string
  supplierTaxId: string
  supplierBranch: string
  invoiceNo: string
  invoiceDate: string
  whtRate: WhtRate | null
  whtForm: WhtForm
}

export const EMPTY_EXPENSE_TAX: ExpenseTaxForm = {
  inputTax: false,
  supplierName: '',
  supplierTaxId: '',
  supplierBranch: HEAD_OFFICE,
  invoiceNo: '',
  invoiceDate: '',
  whtRate: null,
  whtForm: 'pnd53',
}

export const needsSupplier = (f: Pick<ExpenseTaxForm, 'inputTax' | 'whtRate'>) => f.inputTax || f.whtRate !== null

export function validateExpenseTax(f: ExpenseTaxForm, amount: number, today?: string): string | null {
  if (!needsSupplier(f)) return null
  const name = f.supplierName.trim()
  if (name.length < 1 || name.length > 200) return 'กรอกชื่อผู้ขาย/ผู้รับเงิน'
  if (!thaiTaxIdValid(f.supplierTaxId.trim())) return 'เลขประจำตัวผู้เสียภาษีของผู้ขายต้องเป็น 13 หลักที่ถูกต้อง'
  if (!BRANCH_CODE_RE.test(f.supplierBranch.trim())) return 'รหัสสาขาผู้ขายต้องเป็นตัวเลข 5 หลัก (สำนักงานใหญ่ = 00000)'
  if (f.inputTax) {
    const no = f.invoiceNo.trim()
    if (no.length < 1 || no.length > 50) return 'กรอกเลขที่ใบกำกับภาษีซื้อ (ไม่เกิน 50 ตัวอักษร)'
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.invoiceDate) || Number.isNaN(Date.parse(f.invoiceDate))) return 'กรอกวันที่ในใบกำกับภาษีซื้อ'
    if (today && f.invoiceDate > today) return 'วันที่ใบกำกับภาษีต้องไม่เป็นวันในอนาคต'
  }
  if (f.whtRate !== null) {
    if (!WHT_RATES.includes(f.whtRate)) return 'อัตราหัก ณ ที่จ่ายต้องเป็น 1, 2, 3 หรือ 5%'
    if (f.whtForm !== whtFormFor(f.supplierTaxId)) {
      return f.whtForm === 'pnd53'
        ? 'ภ.ง.ด.53 ใช้กับนิติบุคคล (เลขผู้เสียภาษีขึ้นต้นด้วย 0) · ผู้ขายรายนี้ต้องใช้ ภ.ง.ด.3'
        : 'ภ.ง.ด.3 ใช้กับบุคคลธรรมดา · ผู้ขายรายนี้เป็นนิติบุคคล ต้องใช้ ภ.ง.ด.53'
    }
    if (!(amount > 0)) return 'กรอกจำนวนเงินก่อนคำนวณหัก ณ ที่จ่าย'
  }
  return null
}

// ช่องภาษีที่ส่งไปตาราง expenses (ฐานข้อมูลคิด wht_amount ซ้ำเอง)
export function expenseTaxFields(f: ExpenseTaxForm, amount: number, vatRate = 7) {
  const calc = expenseTax(amount, f.inputTax, f.whtRate, vatRate)
  const supplier = needsSupplier(f)
  return {
    vat_amount: calc.vat,
    supplier_name: supplier ? f.supplierName.trim() : null,
    supplier_tax_id: supplier ? f.supplierTaxId.trim() : null,
    supplier_branch_code: supplier ? f.supplierBranch.trim() : null,
    tax_invoice_no: f.inputTax ? f.invoiceNo.trim() : null,
    tax_invoice_date: f.inputTax ? f.invoiceDate : null,
    wht_rate: f.whtRate,
    wht_type: f.whtRate === null ? null : f.whtForm,
  }
}

export const EXPENSE_TAX_ERRORS: Record<string, string> = {
  expenses_tax_invoice_key: 'ใบกำกับภาษีซื้อเลขนี้ของผู้ขายรายนี้บันทึกไปแล้ว (ใช้ขอคืนได้ครั้งเดียว)',
  expenses_wht_check: 'ข้อมูลหัก ณ ที่จ่ายไม่ตรงกัน (แบบ ภ.ง.ด. ต้องตรงกับประเภทผู้ขาย)',
  expenses_tax_invoice_check: 'ใบกำกับภาษีซื้อต้องมีเลขที่ วันที่ ชื่อและเลขผู้เสียภาษีของผู้ขาย',
  expenses_supplier_tax_id_check: 'เลขประจำตัวผู้เสียภาษีของผู้ขายไม่ถูกต้อง',
  wht_supplier_tax_id_required: 'หัก ณ ที่จ่ายต้องมีเลขผู้เสียภาษีของผู้ขาย',
  wht_manual_expense_only: 'หัก ณ ที่จ่ายใช้ได้เฉพาะรายจ่ายที่บันทึกเอง',
}

// ข้อผิดพลาดจาก insert expenses (constraint / unique index / trigger) → ข้อความไทย
export function expenseTaxError(message: string): string | null {
  for (const [k, v] of Object.entries(EXPENSE_TAX_ERRORS)) if (message.includes(k)) return v
  return null
}

// ----- เอกสารภาษีขาย (ABB / TAX / CN) -----
export type TaxDocType = 'ABB' | 'TAX' | 'CN'
export type TaxDocStatus = 'draft' | 'confirmed' | 'voided'
export const TAX_DOC_LABEL: Record<TaxDocType, string> = { ABB: 'ใบกำกับภาษีอย่างย่อ', TAX: 'ใบกำกับภาษีเต็มรูป', CN: 'ใบลดหนี้' }
export const TAX_DOC_STATUS_LABEL: Record<TaxDocStatus, string> = { draft: 'ฉบับร่าง', confirmed: 'ยืนยันแล้ว', voided: 'ยกเลิก' }
export const ETDA_TYPE_CODE: Record<TaxDocType, string> = { TAX: 'T03', ABB: 'T05', CN: '81' }

// แถวจาก GET /api/tax/documents (ตัวเลข numeric มาเป็น string ได้)
export interface TaxDocRow {
  id: string
  order_id: string
  ref_document_id: string | null
  doc_type: TaxDocType
  doc_number: string | null
  status: TaxDocStatus
  terminal_code: string | null
  pos_reg_no: string | null
  buyer_name: string | null
  buyer_tax_id: string | null
  buyer_branch_code: string | null
  vat_rate: number
  taxable_amount: number
  exempt_amount: number
  vat_amount: number
  total_amount: number
  credit_note_reason: string | null
  issue_date: string | null
  created_by_name: string | null
  created_at: string
  confirmed_by_name: string | null
  confirmed_at: string | null
  voided_at: string | null
  void_reason: string | null
}

export function normalizeTaxDoc(raw: Record<string, unknown>): TaxDocRow {
  const d = raw as unknown as TaxDocRow
  return {
    ...d,
    vat_rate: n(d.vat_rate),
    taxable_amount: n(d.taxable_amount),
    exempt_amount: n(d.exempt_amount),
    vat_amount: n(d.vat_amount),
    total_amount: n(d.total_amount),
  }
}

// รวมร่าง (ยังไม่มีวันที่ออก) กับเอกสารในช่วงวันที่ ไม่ซ้ำ · ร่างขึ้นก่อน แล้วเรียงตามเวลาสร้างล่าสุด
export function mergeTaxDocs(...lists: TaxDocRow[][]): TaxDocRow[] {
  const map = new Map<string, TaxDocRow>()
  for (const list of lists) for (const d of list) map.set(d.id, d)
  return [...map.values()].sort(
    (a, b) => Number(b.status === 'draft') - Number(a.status === 'draft') || b.created_at.localeCompare(a.created_at),
  )
}

export function taxDocActions(d: Pick<TaxDocRow, 'status' | 'doc_number'>) {
  return {
    canConfirm: d.status === 'draft',
    canPrint: d.status !== 'voided',
    canDownloadXml: d.status === 'confirmed' && Boolean(d.doc_number),
  }
}

export const xmlFileName = (docNumber: string) => `${docNumber.replace(/[^A-Za-z0-9_-]/g, '_')}.xml`

// ยอดสรุปของรายการเอกสาร (เงินนับเฉพาะที่ยืนยันแล้ว · ใบลดหนี้ติดลบ)
export function taxDocTotals(docs: Pick<TaxDocRow, 'doc_type' | 'status' | 'vat_amount' | 'total_amount'>[]) {
  const count: Record<TaxDocStatus, number> = { draft: 0, confirmed: 0, voided: 0 }
  const byType: Record<TaxDocType, number> = { ABB: 0, TAX: 0, CN: 0 }
  let vat = 0
  let total = 0
  for (const d of docs) {
    count[d.status]++
    byType[d.doc_type]++
    if (d.status !== 'confirmed') continue
    const sign = d.doc_type === 'CN' ? -1 : 1
    vat += sign * Math.round(d.vat_amount * 100)
    total += sign * Math.round(d.total_amount * 100)
  }
  return { count, byType, vat: vat / 100, total: total / 100 }
}

// ----- รายงานภาษีรายเดือน (GET /api/accounting/reports/*) -----
export type TaxReportKind = 'sales-tax' | 'purchase-tax' | 'pp30-summary' | 'wht'

export interface TaxReportSeller {
  company_name: string
  tax_id: string
  branch_code: string
  registered_address: string
}

export interface SalesTaxLine {
  no: number
  date: string
  doc_number: string
  doc_type: TaxDocType
  buyer_name: string
  buyer_tax_id: string
  branch: string
  taxable: number
  exempt: number
  vat: number
  total: number
  note: string
}

export interface PurchaseTaxLine {
  no: number
  invoice_date: string
  invoice_no: string
  supplier_name: string
  supplier_tax_id: string
  branch: string
  value: number
  vat: number
  total: number
  posted_on: string
}

export interface WhtLine {
  no: number
  form: WhtForm
  payee_tax_id: string
  branch: string
  payee_name: string
  paid_on: string
  income_type: string
  rate: number
  paid_amount: number
  wht: number
}

interface TaxReportBase {
  month: string
  period: { from: string; to: string }
  seller: TaxReportSeller | null
}

export interface SalesTaxReport extends TaxReportBase {
  rows: SalesTaxLine[]
  totals: { taxable: number; exempt: number; vat: number; total: number }
}

export interface PurchaseTaxReport extends TaxReportBase {
  rows: PurchaseTaxLine[]
  totals: { value: number; vat: number; total: number }
  without_invoice: { count: number; vat: number }
}

export interface Pp30Summary {
  sales_total: number
  sales_exempt_or_zero: number
  sales_taxable: number
  output_vat: number
  purchases_eligible: number
  input_vat: number
  net_vat: number
  vat_payable: number
  vat_credit: number
}

export interface Pp30Report extends TaxReportBase {
  summary: Pp30Summary
  counts: { sales_lines: number; purchase_invoices: number }
  purchases_without_invoice: { count: number; vat: number }
}

export interface WhtSummaryPart {
  count: number
  paid_amount: number
  wht: number
}

export interface WhtReport extends TaxReportBase {
  type: WhtForm | 'all'
  rows: WhtLine[]
  summary: { pnd3: WhtSummaryPart; pnd53: WhtSummaryPart; total_wht: number }
}

export const monthOf = (date: string) => date.slice(0, 7)

export function taxReportPath(kind: TaxReportKind, restaurantId: string, month: string, format: 'json' | 'csv' = 'json', type?: WhtForm) {
  const q = new URLSearchParams({ restaurant_id: restaurantId, month, format })
  if (kind === 'wht' && type) q.set('type', type)
  return `/accounting/reports/${kind}?${q.toString()}`
}

export const taxReportFileName = (kind: TaxReportKind, month: string, type?: WhtForm) =>
  kind === 'pp30-summary' ? `pp30-${month}.csv` : kind === 'wht' ? `wht-${type ?? 'all'}-${month}.csv` : `${kind}-${month}.csv`

// แถวสรุป ภ.พ.30 (ข้อ 1-8 ตามแบบ) ใช้ทั้งการ์ดบนหน้าเว็บและทดสอบ
export function pp30Lines(s: Pp30Summary): { no: string; label: string; amount: number; strong?: boolean }[] {
  return [
    { no: '1', label: 'ยอดขายในเดือนนี้', amount: s.sales_total },
    { no: '2', label: 'หัก ยอดขายที่เสียภาษีในอัตรา 0 / ได้รับยกเว้น', amount: s.sales_exempt_or_zero },
    { no: '3', label: 'ยอดขายที่ต้องเสียภาษี', amount: s.sales_taxable },
    { no: '4', label: 'ภาษีขายเดือนนี้', amount: s.output_vat, strong: true },
    { no: '5', label: 'ยอดซื้อที่มีสิทธินำภาษีซื้อมาหัก', amount: s.purchases_eligible },
    { no: '6', label: 'ภาษีซื้อเดือนนี้', amount: s.input_vat, strong: true },
    { no: '7', label: 'ภาษีที่ต้องชำระเดือนนี้', amount: s.vat_payable, strong: true },
    { no: '8', label: 'ภาษีที่ชำระเกินเดือนนี้', amount: s.vat_credit, strong: true },
  ]
}

// กำหนดยื่นแบบของเดือนภาษี (วันในเดือนถัดไป): ภ.พ.30 กระดาษ 15 / ออนไลน์ 23 · ภ.ง.ด.3/53 กระดาษ 7 / ออนไลน์ 15
export function filingDue(month: string, form: 'pp30' | 'wht' = 'pp30'): { paper: string; online: string } {
  const [y, m] = month.split('-').map(Number)
  const ny = m === 12 ? y + 1 : y
  const mm = String(m === 12 ? 1 : m + 1).padStart(2, '0')
  return form === 'pp30' ? { paper: `${ny}-${mm}-15`, online: `${ny}-${mm}-23` } : { paper: `${ny}-${mm}-07`, online: `${ny}-${mm}-15` }
}
