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
  type Summary,
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

console.log(`\n${count} tests passed`)
