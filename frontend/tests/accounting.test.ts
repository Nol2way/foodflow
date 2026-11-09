// สูตรบัญชี: Food/Prime Cost, กำไร, perpetual inventory, งบดุล, เกณฑ์ VAT, เหมา 60%, แจ้งเตือน, ไฟล์ส่งออก
import assert from 'node:assert/strict'
import {
  alerts,
  balanceSheet,
  band,
  cashFlow,
  cashView,
  dayCloseText,
  metrics,
  normalizeDashboard,
  normalizeSummary,
  stockCheck,
  suggestMode,
  taxDeductionCompare,
  toCsv,
  toExcelXml,
  vatThreshold,
  EMPTY_EXPENSE_TAX,
  EMPTY_TAX_SETTINGS,
  ETDA_TYPE_CODE,
  TERMINAL_CODE_RE,
  WHT_RATES,
  expenseTax,
  expenseTaxError,
  expenseTaxFields,
  filingDue,
  mergeTaxDocs,
  monthOf,
  needsSupplier,
  normalizeTaxDoc,
  pp30Lines,
  taxDocActions,
  taxDocTotals,
  taxReportFileName,
  taxReportPath,
  taxSettingsRow,
  thaiTaxIdValid,
  validateExpenseTax,
  validatePosRegNo,
  validateTaxSettings,
  whtFormFor,
  xmlFileName,
  type ExpenseTaxForm,
  type Pp30Summary,
  type Summary,
  type TaxDocRow,
  type TaxSettingsForm,
  type TrialRow,
} from '../src/lib/accounting.ts'

let count = 0
const t = (name: string, fn: () => void) => {
  fn()
  count++
  console.log('ok -', name)
}

const base: Summary = {
  from: '2026-10-01',
  to: '2026-10-31',
  sales: 100000,
  sales_by_account: [{ code: '4010', name: 'รายได้ขายอาหาร', amount: 100000 }],
  discounts: 0,
  other_income: 0,
  cogs_recipe: 28000,
  stock_variance: 2000,
  food_cost: 30000,
  labor: 30000,
  opex: 15000,
  expenses_by_account: [],
  cash_open: 1000,
  cash_close: 6000,
  cash_in: 100000,
  cash_out: 95000,
  cash_drawer: 3000,
  cash_by_source: [
    { source_type: 'bill', in: 100000, out: 0 },
    { source_type: 'expense', in: 0, out: 45000 },
    { source_type: 'stock_receipt', in: 0, out: 50000 },
  ],
  stock_open: 10000,
  stock_close: 12000,
  stock_in: 32000,
  vat_output: 0,
  vat_input: 0,
  bills: 400,
  cancelled_bills: 2,
}
const S = (patch: Partial<Summary> = {}): Summary => ({ ...base, ...patch })

t('Food Cost % = ต้นทุนอาหารที่ใช้จริง / ยอดขายสุทธิ', () => {
  assert.equal(metrics(S()).foodCostPct, 30)
})
t('Prime Cost % = (ต้นทุนอาหาร + ค่าแรง) / ยอดขายสุทธิ', () => {
  assert.equal(metrics(S()).primeCostPct, 60)
})
t('Food/Prime Cost คิดจากยอดขายหลังหักส่วนลด', () => {
  const m = metrics(S({ discounts: 20000 }))
  assert.equal(m.netSales, 80000)
  assert.equal(m.foodCostPct, 37.5)
  assert.equal(m.primeCostPct, 75)
})
t('ไม่มียอดขาย -> เปอร์เซ็นต์เป็น null (ไม่หารศูนย์)', () => {
  const m = metrics(S({ sales: 0 }))
  assert.equal(m.foodCostPct, null)
  assert.equal(m.primeCostPct, null)
})
t('กำไร = ยอดขาย - ต้นทุนอาหาร - ค่าใช้จ่าย', () => {
  const m = metrics(S())
  assert.equal(m.grossProfit, 70000)
  assert.equal(m.expenses, 45000)
  assert.equal(m.netProfit, 25000)
  assert.equal(m.netMarginPct, 25)
})
t('ต้นทุนขายจริง = ตามสูตร + ส่วนต่างสต็อก = ต้นงวด + รับเข้า - ปลายงวด', () => {
  const c = stockCheck(S())
  assert.equal(c.cogsActual, 30000)
  assert.equal(c.usage, 30000)
  assert.ok(c.matches)
  assert.ok(!stockCheck(S({ stock_close: 11000 })).matches)
})
t('แถบสีเทียบเป้า', () => {
  assert.equal(band(30, 28, 35), 'ok')
  assert.equal(band(28, 28, 35), 'ok')
  assert.equal(band(35.01, 28, 35), 'high')
  assert.equal(band(20, 28, 35), 'low')
  assert.equal(band(null, 28, 35), 'none')
})
t('มุมมองง่าย: เงินเข้า เงินออก คงเหลือ', () => {
  assert.deepEqual(cashView(S()), { in: 100000, out: 95000, net: 5000, balance: 6000 })
})
t('งบกระแสเงินสด: ยอดต้น + สุทธิ = ยอดปลาย', () => {
  const f = cashFlow(S())
  assert.equal(f.operating, 5000)
  assert.equal(f.financing, 0)
  assert.equal(f.open + f.operating + f.financing, f.close)
  assert.equal(cashFlow(S({ cash_close: 16000 })).financing, 10000) // เจ้าของใส่เงินทุนเพิ่ม
  assert.equal(f.rows.find((r) => r.source_type === 'stock_receipt')?.label, 'ซื้อวัตถุดิบ')
})
t('งบดุล: สินทรัพย์ = หนี้สิน + ทุน + กำไรสะสม', () => {
  const tr = (code: string, type: TrialRow['type'], grp: TrialRow['grp'], closing: number): TrialRow =>
    ({ account_id: code, code, name: code, type, grp, opening: 0, debit: 0, credit: 0, closing })
  const rows = [
    tr('1010', 'asset', 'cash', 5000),
    tr('1130', 'asset', 'stock', 12000),
    tr('2010', 'liability', 'ap', -3000),
    tr('3010', 'equity', 'equity', -10000),
    tr('4010', 'revenue', 'sales', -20000),
    tr('5010', 'expense', 'food_cost', 16000),
  ]
  const b = balanceSheet(rows)
  assert.equal(b.totalAssets, 17000)
  assert.equal(b.earnings, 4000)
  assert.equal(b.totalLiabEquity, 17000)
  assert.ok(b.balanced)
})
t('เกณฑ์ VAT 1.8 ล้าน: เตือนที่ 80% อันตรายเมื่อเกิน · จดแล้วไม่เตือน', () => {
  assert.equal(vatThreshold(1_000_000, false).level, 'info')
  assert.equal(vatThreshold(1_440_000, false).level, 'warn')
  assert.equal(vatThreshold(1_800_000, false).level, 'danger')
  assert.equal(vatThreshold(2_000_000, true).level, 'none')
  assert.equal(vatThreshold(1_440_000, false).remaining, 360000)
})
t('เหมา 60% vs ตามจริง (ข้อมูลประกอบ)', () => {
  const c = taxDeductionCompare(S())
  assert.equal(c.income, 100000)
  assert.equal(c.flatExpense, 60000)
  assert.equal(c.flatNet, 40000)
  assert.equal(c.actualExpense, 75000)
  assert.equal(c.actualNet, 25000)
  assert.equal(c.lowerNet, 'actual')
  assert.equal(taxDeductionCompare(S({ labor: 0, opex: 0 })).lowerNet, 'flat')
})
t('onboarding: จดบริษัท/จด VAT -> มืออาชีพ · บุคคลธรรมดา -> มาตรฐาน (หรือง่าย)', () => {
  assert.equal(suggestMode('company', false), 'pro')
  assert.equal(suggestMode('individual', true), 'pro')
  assert.equal(suggestMode('individual', false), 'standard')
  assert.equal(suggestMode('individual', false, true), 'simple')
})
t('แปลงตัวเลขจาก Postgres numeric (string) เป็น number', () => {
  const s = normalizeSummary({ ...base, sales: '123.45', expenses_by_account: [{ code: '5110', name: 'ค่าแรง', amount: '10.5' }] } as unknown as Record<string, unknown>)
  assert.equal(s.sales, 123.45)
  assert.equal(s.expenses_by_account[0].amount, 10.5)
})

const dash = (patch: Partial<Summary> = {}, extra: Record<string, unknown> = {}) =>
  normalizeDashboard({
    today: '2026-10-26',
    periods: { today: S(), d7: S(), d30: S(patch), month: S(), prev_month: S(), ytd: S(patch) },
    reconcile: { stock_value: '100', ledger_value: '100', difference: '0', ok: true },
    last_close: null,
    unclosed_days: 0,
    settings: {
      accounting_mode: 'standard', business_type: 'individual', vat_registered: false, vat_rate: '7', receipt_payment_default: 'cash',
      food_cost_target_min: '28', food_cost_target_max: '35', prime_cost_target_min: '60', prime_cost_target_max: '65', onboarded: true,
    },
    ...extra,
  })

t('แจ้งเตือน: ปกติไม่มี', () => assert.deepEqual(alerts(dash()), []))
t('แจ้งเตือน: มูลค่าสต็อกไม่เท่าบัญชี', () => {
  const a = alerts(dash({}, { reconcile: { stock_value: 100, ledger_value: 90, difference: -10, ok: false } }))
  assert.equal(a[0].code, 'stock_mismatch')
  assert.equal(a[0].level, 'danger')
})
t('แจ้งเตือน: รายรับปีใกล้ 1.8 ล้าน / Food & Prime Cost เกินเป้า / ยังไม่ปิดวัน', () => {
  const codes = alerts(dash({ sales: 1_500_000, food_cost: 600_000, labor: 400_000 }, { unclosed_days: 2 })).map((a) => a.code)
  assert.deepEqual(codes, ['vat_threshold', 'food_cost_high', 'prime_cost_high', 'unclosed_days'])
})
t('ข้อความปิดวันส่ง LINE', () => {
  const txt = dayCloseText({ ...S({ sales: 5000, food_cost: 1500, labor: 0, opex: 500, bills: 20, cancelled_bills: 1, cash_in: 5000, cash_out: 500 }),
    restaurant: 'ร้านทดสอบ', date: '2026-10-26', system_cash: 4500, counted_cash: 4480, difference: -20 })
  for (const part of ['ปิดวัน ร้านทดสอบ · 2026-10-26', '฿5,000 (20 บิล · ยกเลิก 1)', '(30%)', 'กำไรวันนี้ ฿3,000', 'เงินสดขาด ฿20'])
    assert.ok(txt.includes(part), part)
})
t('CSV: มี BOM ใส่เครื่องหมายคำพูดเมื่อจำเป็น และกันสูตร Excel', () => {
  const c = toCsv(['a', 'b'], [['x,y', 'say "hi"'], ['=1+1', -5], [null, 1.5]])
  assert.ok(c.startsWith('﻿'))
  assert.equal(c, '﻿a,b\r\n"x,y","say ""hi"""\r\n\'=1+1,-5\r\n,1.5\r\n')
})
t('Excel XML: ตัวเลขเป็น Number ข้อความ escape แล้ว', () => {
  const x = toExcelXml('สมุดรายวัน', ['บัญชี', 'เดบิต'], [['<เงินสด> & ธนาคาร', 150]])
  assert.ok(x.includes('<Data ss:Type="Number">150</Data>'))
  assert.ok(x.includes('&lt;เงินสด&gt; &amp; ธนาคาร'))
  assert.ok(x.includes('ss:Name="สมุดรายวัน"'))
})

// ===== ภาษี: ผู้ประกอบการ / ภาษีซื้อ / หัก ณ ที่จ่าย / เอกสารภาษี / รายงาน กรมสรรพากร =====
const COMPANY = '0105551234567' // นิติบุคคล
const PERSON = '1101700203450' // บุคคลธรรมดา
const taxForm = (over: Partial<ExpenseTaxForm> = {}): ExpenseTaxForm => ({
  ...EMPTY_EXPENSE_TAX,
  supplierName: 'บจก. ซัพพลาย',
  supplierTaxId: COMPANY,
  invoiceNo: 'IV-001',
  invoiceDate: '2026-11-04',
  ...over,
})

t('thaiTaxIdValid: 13 หลัก + checksum mod 11', () => {
  assert.equal(thaiTaxIdValid(COMPANY), true)
  assert.equal(thaiTaxIdValid(PERSON), true)
  assert.equal(thaiTaxIdValid('0105551234568'), false)
  assert.equal(thaiTaxIdValid('010555123456'), false)
  assert.equal(thaiTaxIdValid('01055512345a7'), false)
})

t('validateTaxSettings: เลขผู้เสียภาษี ชื่อ สาขา 5 หลัก ที่อยู่ รหัสไปรษณีย์', () => {
  const ok: TaxSettingsForm = { ...EMPTY_TAX_SETTINGS, tax_id: COMPANY, company_name: 'บจก. ร้านอาหาร', registered_address: '1 ถ.สุขุมวิท กรุงเทพฯ' }
  assert.equal(validateTaxSettings(ok), null)
  assert.equal(EMPTY_TAX_SETTINGS.branch_code, '00000')
  assert.match(validateTaxSettings({ ...ok, tax_id: '0105551234568' })!, /13 หลัก/)
  assert.match(validateTaxSettings({ ...ok, company_name: '  ' })!, /ชื่อ/)
  assert.match(validateTaxSettings({ ...ok, branch_code: '1' })!, /5 หลัก/)
  assert.match(validateTaxSettings({ ...ok, registered_address: '' })!, /ที่อยู่/)
  assert.match(validateTaxSettings({ ...ok, postcode: '1011' })!, /ไปรษณีย์/)
  assert.equal(validateTaxSettings({ ...ok, postcode: '10110' }), null)
})

t('taxSettingsRow: trim และช่องว่างเป็น null', () => {
  const row = taxSettingsRow('rid', { tax_id: ` ${COMPANY} `, company_name: ' ร้าน ', branch_code: '00001', branch_name: ' ', registered_address: ' ที่อยู่ ', postcode: '' })
  assert.deepEqual(row, { restaurant_id: 'rid', tax_id: COMPANY, company_name: 'ร้าน', branch_code: '00001', branch_name: null, registered_address: 'ที่อยู่', postcode: null })
})

t('validatePosRegNo: ว่างได้ · A-Z 0-9 / - ไม่เกิน 30', () => {
  assert.equal(validatePosRegNo(''), null)
  assert.equal(validatePosRegNo('E0123456789/01-A'), null)
  assert.ok(validatePosRegNo('มีภาษาไทย'))
  assert.ok(validatePosRegNo('X'.repeat(31)))
  assert.ok(TERMINAL_CODE_RE.test('POS01'))
  assert.ok(!TERMINAL_CODE_RE.test('pos-01'))
})

t('whtFormFor: เลขขึ้นต้น 0 = ภ.ง.ด.53 · อื่นๆ = ภ.ง.ด.3', () => {
  assert.equal(whtFormFor(COMPANY), 'pnd53')
  assert.equal(whtFormFor(PERSON), 'pnd3')
  assert.deepEqual(WHT_RATES, [1, 2, 3, 5])
})

t('expenseTax: VAT 7% แยกจากยอดรวม · หัก ณ ที่จ่ายจากฐานก่อน VAT · ปัดเป็นสตางค์', () => {
  assert.deepEqual(expenseTax(1070, true, null), { vat: 70, base: 1000, wht: 0, netPaid: 1070 })
  assert.deepEqual(expenseTax(1070, true, 3), { vat: 70, base: 1000, wht: 30, netPaid: 1040 })
  assert.deepEqual(expenseTax(5000, false, 5), { vat: 0, base: 5000, wht: 250, netPaid: 4750 })
  assert.deepEqual(expenseTax(100, true, 1), { vat: 6.54, base: 93.46, wht: 0.93, netPaid: 99.07 })
  assert.deepEqual(expenseTax(0, true, 3), { vat: 0, base: 0, wht: 0, netPaid: 0 })
  assert.deepEqual(expenseTax(Number.NaN, true, 3), { vat: 0, base: 0, wht: 0, netPaid: 0 })
  assert.equal(expenseTax(1100, true, null, 10).vat, 100)
})

t('validateExpenseTax: ไม่มีภาษี = ผ่าน · ใบกำกับต้องครบ · แบบ ภ.ง.ด. ต้องตรงผู้ขาย', () => {
  assert.equal(validateExpenseTax(EMPTY_EXPENSE_TAX, 100), null)
  assert.equal(validateExpenseTax(taxForm({ inputTax: true }), 1070, '2026-11-09'), null)
  assert.match(validateExpenseTax(taxForm({ inputTax: true, supplierName: '' }), 1070)!, /ชื่อผู้ขาย/)
  assert.match(validateExpenseTax(taxForm({ inputTax: true, supplierTaxId: '123' }), 1070)!, /13 หลัก/)
  assert.match(validateExpenseTax(taxForm({ inputTax: true, supplierBranch: '0' }), 1070)!, /สาขา/)
  assert.match(validateExpenseTax(taxForm({ inputTax: true, invoiceNo: ' ' }), 1070)!, /เลขที่ใบกำกับ/)
  assert.match(validateExpenseTax(taxForm({ inputTax: true, invoiceDate: '' }), 1070)!, /วันที่/)
  assert.match(validateExpenseTax(taxForm({ inputTax: true, invoiceDate: '2026-12-01' }), 1070, '2026-11-09')!, /อนาคต/)
  // หัก ณ ที่จ่ายอย่างเดียว ไม่ต้องมีเลขที่ใบกำกับ
  assert.equal(validateExpenseTax(taxForm({ invoiceNo: '', whtRate: 3, whtForm: 'pnd53' }), 1000), null)
  assert.match(validateExpenseTax(taxForm({ whtRate: 3, whtForm: 'pnd3' }), 1000)!, /ภ\.ง\.ด\.53/)
  assert.match(validateExpenseTax(taxForm({ supplierTaxId: PERSON, whtRate: 3, whtForm: 'pnd53' }), 1000)!, /ภ\.ง\.ด\.3/)
  assert.match(validateExpenseTax(taxForm({ whtRate: 3, whtForm: 'pnd53' }), 0)!, /จำนวนเงิน/)
})

t('expenseTaxFields: ส่งเฉพาะช่องที่ใช้ · ไม่มีภาษี = null ทั้งหมด', () => {
  assert.deepEqual(expenseTaxFields(EMPTY_EXPENSE_TAX, 500), {
    vat_amount: 0, supplier_name: null, supplier_tax_id: null, supplier_branch_code: null,
    tax_invoice_no: null, tax_invoice_date: null, wht_rate: null, wht_type: null,
  })
  assert.deepEqual(expenseTaxFields(taxForm({ inputTax: true, whtRate: 3, whtForm: 'pnd53', supplierName: ' บจก. ซัพพลาย ', invoiceNo: ' IV-001 ' }), 1070), {
    vat_amount: 70, supplier_name: 'บจก. ซัพพลาย', supplier_tax_id: COMPANY, supplier_branch_code: '00000',
    tax_invoice_no: 'IV-001', tax_invoice_date: '2026-11-04', wht_rate: 3, wht_type: 'pnd53',
  })
  const whtOnly = expenseTaxFields(taxForm({ supplierTaxId: PERSON, whtRate: 5, whtForm: 'pnd3' }), 10000)
  assert.deepEqual([whtOnly.vat_amount, whtOnly.tax_invoice_no, whtOnly.tax_invoice_date, whtOnly.wht_type], [0, null, null, 'pnd3'])
  assert.equal(needsSupplier({ inputTax: false, whtRate: null }), false)
})

t('expenseTaxError: constraint / unique index → ข้อความไทย', () => {
  assert.match(expenseTaxError('duplicate key value violates unique constraint "expenses_tax_invoice_key"')!, /บันทึกไปแล้ว/)
  assert.match(expenseTaxError('new row violates check constraint "expenses_wht_check"')!, /ภ\.ง\.ด\./)
  assert.match(expenseTaxError('wht_supplier_tax_id_required')!, /เลขผู้เสียภาษี/)
  assert.equal(expenseTaxError('day_closed'), null)
})

const docRow = (over: Partial<TaxDocRow>): TaxDocRow =>
  normalizeTaxDoc({
    id: 'x', order_id: 'o', ref_document_id: null, doc_type: 'ABB', doc_number: null, status: 'draft', terminal_code: null, pos_reg_no: null,
    buyer_name: null, buyer_tax_id: null, buyer_branch_code: null, vat_rate: '7', taxable_amount: '100', exempt_amount: '0',
    vat_amount: '7', total_amount: '107', credit_note_reason: null, issue_date: null, created_by_name: null, created_at: '2026-11-01T10:00:00Z',
    confirmed_by_name: null, confirmed_at: null, voided_at: null, void_reason: null,
    ...over,
  } as unknown as Record<string, unknown>)

t('normalizeTaxDoc: numeric string → number', () => {
  const d = docRow({})
  assert.deepEqual([d.vat_rate, d.taxable_amount, d.vat_amount, d.total_amount], [7, 100, 7, 107])
})

t('mergeTaxDocs: รวมร่างกับเอกสารตามช่วงวันที่ ไม่ซ้ำ ร่างขึ้นก่อน', () => {
  const a = docRow({ id: 'a', status: 'confirmed', doc_number: 'ABB-1', created_at: '2026-11-05T00:00:00Z' })
  const b = docRow({ id: 'b', status: 'draft', created_at: '2026-11-01T00:00:00Z' })
  const c = docRow({ id: 'c', status: 'confirmed', doc_number: 'ABB-2', created_at: '2026-11-07T00:00:00Z' })
  assert.deepEqual(mergeTaxDocs([a, c], [b, b]).map((d) => d.id), ['b', 'c', 'a'])
})

t('taxDocActions: ร่างยืนยันได้ · ยืนยันแล้วพิมพ์ + XML · ยกเลิกทำอะไรไม่ได้', () => {
  assert.deepEqual(taxDocActions({ status: 'draft', doc_number: null }), { canConfirm: true, canPrint: true, canDownloadXml: false })
  assert.deepEqual(taxDocActions({ status: 'confirmed', doc_number: 'TAX-1' }), { canConfirm: false, canPrint: true, canDownloadXml: true })
  assert.deepEqual(taxDocActions({ status: 'voided', doc_number: null }), { canConfirm: false, canPrint: false, canDownloadXml: false })
  assert.equal(xmlFileName('TAX-POS01/2026 11'), 'TAX-POS01_2026_11.xml')
  assert.deepEqual(ETDA_TYPE_CODE, { TAX: 'T03', ABB: 'T05', CN: '81' })
})

t('taxDocTotals: นับตามสถานะ/ประเภท · เงินเฉพาะที่ยืนยัน · ใบลดหนี้ติดลบ', () => {
  const r = taxDocTotals([
    docRow({ id: '1', status: 'confirmed', doc_type: 'ABB' }),
    docRow({ id: '2', status: 'confirmed', doc_type: 'TAX', vat_amount: 70, total_amount: 1070 }),
    docRow({ id: '3', status: 'confirmed', doc_type: 'CN', vat_amount: 7, total_amount: 107 }),
    docRow({ id: '4', status: 'draft', doc_type: 'TAX', vat_amount: 700, total_amount: 10700 }),
    docRow({ id: '5', status: 'voided', doc_type: 'ABB' }),
  ])
  assert.deepEqual(r.count, { draft: 1, confirmed: 3, voided: 1 })
  assert.deepEqual(r.byType, { ABB: 2, TAX: 2, CN: 1 })
  assert.equal(r.vat, 70)
  assert.equal(r.total, 1070)
})

t('taxReportPath / taxReportFileName: ตรงกับ backend /accounting/reports/*', () => {
  assert.equal(taxReportPath('sales-tax', 'rid', '2026-11'), '/accounting/reports/sales-tax?restaurant_id=rid&month=2026-11&format=json')
  assert.equal(taxReportPath('wht', 'rid', '2026-11', 'csv', 'pnd53'), '/accounting/reports/wht?restaurant_id=rid&month=2026-11&format=csv&type=pnd53')
  assert.ok(!taxReportPath('sales-tax', 'rid', '2026-11', 'csv', 'pnd3').includes('type='))
  assert.equal(taxReportFileName('sales-tax', '2026-11'), 'sales-tax-2026-11.csv')
  assert.equal(taxReportFileName('purchase-tax', '2026-11'), 'purchase-tax-2026-11.csv')
  assert.equal(taxReportFileName('pp30-summary', '2026-11'), 'pp30-2026-11.csv')
  assert.equal(taxReportFileName('wht', '2026-11'), 'wht-all-2026-11.csv')
  assert.equal(taxReportFileName('wht', '2026-11', 'pnd3'), 'wht-pnd3-2026-11.csv')
  assert.equal(monthOf('2026-11-09'), '2026-11')
})

t('pp30Lines: ข้อ 1-8 ตามแบบ ภ.พ.30', () => {
  const s: Pp30Summary = {
    sales_total: 10000, sales_exempt_or_zero: 0, sales_taxable: 10000, output_vat: 700,
    purchases_eligible: 5000, input_vat: 350, net_vat: 350, vat_payable: 350, vat_credit: 0,
  }
  const lines = pp30Lines(s)
  assert.deepEqual(lines.map((l) => l.no), ['1', '2', '3', '4', '5', '6', '7', '8'])
  assert.deepEqual(lines.map((l) => l.amount), [10000, 0, 10000, 700, 5000, 350, 350, 0])
})

t('filingDue: ภ.พ.30 วันที่ 15/23 · ภ.ง.ด.3/53 วันที่ 7/15 ของเดือนถัดไป · ข้ามปี', () => {
  assert.deepEqual(filingDue('2026-11'), { paper: '2026-12-15', online: '2026-12-23' })
  assert.deepEqual(filingDue('2026-12', 'pp30'), { paper: '2027-01-15', online: '2027-01-23' })
  assert.deepEqual(filingDue('2026-12', 'wht'), { paper: '2027-01-07', online: '2027-01-15' })
})

console.log(`\n${count} tests passed`)
