// ทดสอบ API บัญชีด้วย fetch จำลอง (ไม่ต่อ Supabase / LINE จริง)
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.ts'
import { WHT_TYPES, pickSettings, whtTypeFor } from '../src/accounting.ts'
import { signJwt } from '../src/jwt.ts'
import type { Env } from '../src/env.ts'

const SB = 'https://proj.supabase.co'
const RID = '11111111-1111-4111-8111-111111111111'
const ORDER = '22222222-2222-4222-8222-222222222222'
const USERS: Record<string, string> = {
  owner: '33333333-3333-4333-8333-333333333333',
  manager: '66666666-6666-4666-8666-666666666666',
  accountant: '77777777-7777-4777-8777-777777777777',
  kitchen: '44444444-4444-4444-8444-444444444444',
}
const ROLE: Record<string, string> = Object.fromEntries(Object.entries(USERS).map(([r, id]) => [id, r]))
const SECRET = 'jwt-test-secret'
const now = () => Math.floor(Date.now() / 1000)
const JWT: Record<string, string> = {}
for (const [r, id] of Object.entries(USERS)) {
  JWT[r] = await signJwt({ sub: id, email: `${r}@x.com`, credential_version: 0, role: 'authenticated', aud: 'authenticated', iat: now(), exp: now() + 3600 }, SECRET)
}

const env: Env = {
  SUPABASE_URL: SB,
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service-secret',
  SUPABASE_JWT_SECRET: SECRET,
  ALLOWED_ORIGINS: 'https://shop.example',
}

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}
let calls: Call[] = []
let handlers: ((c: Call) => Response | undefined)[] = []
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

function defaults(c: Call): Response {
  const u = new URL(c.url)
  if (u.pathname === '/rest/v1/rpc/app_session_valid') return json(true)
  if (u.pathname === '/rest/v1/rpc/day_close_dispatch_claim') return json(RID)
  if (u.pathname === '/rest/v1/rpc/day_close_dispatch_finish') return json(null)
  if (u.pathname === '/rest/v1/staff_members' && c.method === 'GET') {
    const uid = u.searchParams.get('user_id')?.replace('eq.', '') ?? ''
    return json(ROLE[uid] ? [{ role: ROLE[uid] }] : [])
  }
  return json({ message: `unexpected ${c.method} ${c.url}` }, 599)
}

globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const headers: Record<string, string> = {}
  new Headers(init.headers).forEach((v, k) => (headers[k] = v))
  let body: unknown = init.body
  if (typeof body === 'string') body = JSON.parse(body)
  const call: Call = { url: String(input), method: init.method ?? 'GET', headers, body }
  if (Number(new URL(call.url).searchParams.get('offset')) > 0) return json([])
  calls.push(call)
  for (const h of handlers) {
    const r = h(call)
    if (r) return r
  }
  return defaults(call)
}) as typeof fetch

const app = createApp()
function req(path: string, opts: { method?: string; body?: unknown; as?: string } = {}, e: Env = env) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.as) headers.authorization = `Bearer ${JWT[opts.as]}`
  return app.request(path, { method: opts.method ?? (opts.body ? 'POST' : 'GET'), headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }, e)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (r: Response): Promise<any> => r.json()
const callsTo = (part: string) => calls.filter((c) => c.url.includes(part))
const on = (part: string, res: () => Response, method?: string) =>
  handlers.push((c) => (c.url.includes(part) && (!method || c.method === method) ? res() : undefined))

beforeEach(() => {
  calls = []
  handlers = []
})

const SUM = {
  from: '2026-10-26', to: '2026-10-26', sales: '1000', sales_by_account: [], discounts: '0', other_income: '0',
  cogs_recipe: '280', stock_variance: '20', food_cost: '300', labor: '300', opex: '100', expenses_by_account: [],
  cash_open: '0', cash_close: '600', cash_in: '1000', cash_out: '400', cash_drawer: '600', cash_by_source: [],
  stock_open: '500', stock_close: '400', stock_in: '200', vat_output: '0', vat_input: '0', bills: 10, cancelled_bills: 0,
}
const DASH = {
  today: '2026-10-26',
  periods: { today: SUM, d7: SUM, d30: SUM, month: SUM, prev_month: SUM, ytd: { ...SUM, sales: '1500000' } },
  reconcile: { stock_value: 400, ledger_value: 400, difference: 0, ok: true },
  last_close: null,
  unclosed_days: 0,
  settings: { accounting_mode: 'standard', business_type: 'individual', vat_registered: false, vat_rate: 7, receipt_payment_default: 'cash',
    food_cost_target_min: 28, food_cost_target_max: 35, prime_cost_target_min: 60, prime_cost_target_max: 65, onboarded: true },
}

test('dashboard: เจ้าของ/ผู้จัดการ/บัญชีเปิดได้ ครัว 403', async () => {
  on('/rpc/acct_dashboard', () => json(DASH))
  for (const who of ['owner', 'manager', 'accountant']) assert.equal((await req(`/api/accounting/dashboard?restaurant_id=${RID}`, { as: who })).status, 200, who)
  assert.equal((await req(`/api/accounting/dashboard?restaurant_id=${RID}`, { as: 'kitchen' })).status, 403)
})

test('dashboard: เรียกฐานข้อมูลด้วย JWT ผู้ใช้ และคิด Food/Prime Cost + แจ้งเตือนเกณฑ์ VAT', async () => {
  on('/rpc/acct_dashboard', () => json(DASH))
  const r = await req(`/api/accounting/dashboard?restaurant_id=${RID}`, { as: 'owner' })
  const b = await body(r)
  const call = callsTo('/rpc/acct_dashboard')[0]
  assert.equal(call.headers.authorization, `Bearer ${JWT.owner}`)
  assert.equal(call.headers.apikey, 'anon')
  assert.equal(b.metrics.today.foodCostPct, 30)
  assert.equal(b.metrics.today.primeCostPct, 60)
  assert.equal(b.metrics.today.netProfit, 300)
  assert.deepEqual(b.metrics.today.cash, { in: 1000, out: 400, net: 600, balance: 600 })
  assert.equal(b.vat_threshold.level, 'warn')
  assert.ok(b.alerts.some((a: { code: string }) => a.code === 'vat_threshold'))
  assert.equal(b.tax_compare.flatExpense, 900000)
})

test('summary: ช่วงวันที่ผิด -> 400 ไม่เรียกฐานข้อมูล', async () => {
  for (const qs of ['from=2026-10-30&to=2026-10-01', 'from=2026-1-1&to=2026-10-01', 'from=2000-01-01&to=2026-10-01', '']) {
    const r = await req(`/api/accounting/summary?restaurant_id=${RID}&${qs}`, { as: 'owner' })
    assert.equal(r.status, 400, qs)
  }
  assert.equal(callsTo('/rpc/acct_summary').length, 0)
})

test('summary: ตรวจ perpetual (ตามสูตร + ส่วนต่าง = ต้นงวด + รับเข้า - ปลายงวด)', async () => {
  on('/rpc/acct_summary', () => json(SUM))
  const b = await body(await req(`/api/accounting/summary?restaurant_id=${RID}&from=2026-10-01&to=2026-10-26`, { as: 'accountant' }))
  assert.deepEqual(callsTo('/rpc/acct_summary')[0].body, { p_restaurant_id: RID, p_from: '2026-10-01', p_to: '2026-10-26' })
  assert.equal(b.stock_check.cogsActual, 300)
  assert.equal(b.stock_check.usage, 300)
  assert.equal(b.stock_check.matches, true)
})

test('expenses: ต้องเลือกหมวด และจำนวนเงิน > 0', async () => {
  const noCat = await req('/api/accounting/expenses', { as: 'accountant', body: { restaurant_id: RID, amount: 100 } })
  assert.equal(noCat.status, 400)
  assert.equal((await body(noCat)).error, 'category_required')
  const bad = await req('/api/accounting/expenses', { as: 'accountant', body: { restaurant_id: RID, account_id: ORDER, amount: 100, vat_amount: 200 } })
  assert.equal(bad.status, 400)
  assert.equal(callsTo('/rest/v1/expenses').length, 0)
})

test('expenses: พนักงานบัญชีบันทึกด้วย JWT ตัวเอง / ผู้จัดการ 403', async () => {
  on('/rest/v1/expenses', () => json([{ id: 'e1' }], 201), 'POST')
  const r = await req('/api/accounting/expenses', {
    as: 'accountant',
    body: { restaurant_id: RID, account_id: ORDER, amount: 1070, vat_amount: 70, payment_method: 'bank', note: ' ค่าโฆษณา ', spent_on: '2026-10-26' },
  })
  assert.equal(r.status, 201)
  const ins = callsTo('/rest/v1/expenses')[0]
  assert.equal(ins.headers.authorization, `Bearer ${JWT.accountant}`)
  assert.deepEqual(ins.body, {
    restaurant_id: RID, category: 'other', account_id: ORDER, amount: 1070, vat_amount: 70, payment_method: 'bank',
    spent_on: '2026-10-26', note: 'ค่าโฆษณา', receipt_url: null,
  })
  assert.equal((await req('/api/accounting/expenses', { as: 'manager', body: { restaurant_id: RID, account_id: ORDER, amount: 1 } })).status, 403)
})

test('ข้อผิดพลาดบัญชีจากฐานข้อมูล -> ข้อความไทย (ปิดวันแล้ว = 409)', async () => {
  on('/rest/v1/expenses', () => json({ code: 'P0001', message: 'day_closed: 2026-10-26' }, 400), 'POST')
  const r = await req('/api/accounting/expenses', { as: 'owner', body: { restaurant_id: RID, account_id: ORDER, amount: 5 } })
  assert.equal(r.status, 409)
  const b = await body(r)
  assert.equal(b.error, 'day_closed')
  assert.match(b.message, /ปิดวัน/)
})

test('ยกเลิกบิล: เจ้าของเท่านั้น ต้องมีเหตุผล เฉพาะบิลที่จ่ายแล้ว', async () => {
  assert.equal((await req(`/api/accounting/bills/${ORDER}/cancel`, { as: 'manager', body: { restaurant_id: RID, reason: 'x' } })).status, 403)
  assert.equal((await req(`/api/accounting/bills/${ORDER}/cancel`, { as: 'accountant', body: { restaurant_id: RID, reason: 'x' } })).status, 403)
  assert.equal((await req(`/api/accounting/bills/${ORDER}/cancel`, { as: 'owner', body: { restaurant_id: RID, reason: '  ' } })).status, 400)
  on('/rest/v1/orders', () => json([{ id: ORDER }]), 'PATCH')
  const r = await req(`/api/accounting/bills/${ORDER}/cancel`, { as: 'owner', body: { restaurant_id: RID, reason: 'คิดเงินผิดโต๊ะ' } })
  assert.equal(r.status, 200)
  const patch = callsTo('/rest/v1/orders')[0]
  assert.ok(patch.url.includes(`id=eq.${ORDER}`) && patch.url.includes(`restaurant_id=eq.${RID}`) && patch.url.includes('status=eq.paid'))
  assert.deepEqual(patch.body, { status: 'cancelled', cancel_reason: 'คิดเงินผิดโต๊ะ' })
  assert.equal(patch.headers.authorization, `Bearer ${JWT.owner}`)
})

test('ยกเลิกบิล: ไม่พบบิลที่จ่ายแล้ว -> 404', async () => {
  on('/rest/v1/orders', () => json([]), 'PATCH')
  assert.equal((await req(`/api/accounting/bills/${ORDER}/cancel`, { as: 'owner', body: { restaurant_id: RID, reason: 'x' } })).status, 404)
})

const CLOSED = { ...SUM, restaurant: 'ร้านทดสอบ', date: '2026-10-26', system_cash: 600, counted_cash: 580, difference: -20, closed: true }

test('ปิดวัน: ผู้จัดการปิดได้ พนักงานบัญชี 403 / ต้องกรอกยอดนับ', async () => {
  on('/rpc/acct_close_day', () => json(CLOSED))
  assert.equal((await req('/api/accounting/day-close', { as: 'accountant', body: { restaurant_id: RID, date: '2026-10-26', counted_cash: 1 } })).status, 403)
  assert.equal((await req('/api/accounting/day-close', { as: 'manager', body: { restaurant_id: RID, date: '2026-10-26' } })).status, 400)
  const r = await req('/api/accounting/day-close', { as: 'manager', body: { restaurant_id: RID, date: '2026-10-26', counted_cash: 580 } })
  assert.equal(r.status, 201)
  assert.equal((await body(r)).line, 'not_configured')
  assert.deepEqual(callsTo('/rpc/acct_close_day')[0].body, { p_restaurant_id: RID, p_date: '2026-10-26', p_counted_cash: 580, p_note: null, p_notify: false })
})

test('ปิดวัน: ส่งสรุปเข้า LINE ของร้าน / LINE ล่มก็ยังปิดวันสำเร็จ', async () => {
  on('/rpc/acct_close_day', () => json(CLOSED))
  on('/rest/v1/shop_settings', () => json([{ line_to: 'U' + 'a'.repeat(32) }]))
  let lineOk = true
  on('api.line.me', () => (lineOk ? json({}) : json({ message: 'bad' }, 400)))
  const e = { ...env, LINE_CHANNEL_ACCESS_TOKEN: 'line-token' }
  const r = await req('/api/accounting/day-close', { as: 'owner', body: { restaurant_id: RID, date: '2026-10-26', counted_cash: 580 } }, e)
  assert.equal((await body(r)).line, 'sent')
  const push = callsTo('api.line.me')[0].body as { messages: { text: string }[] }
  assert.match(push.messages[0].text, /เงินสดขาด ฿20/)
  lineOk = false
  const r2 = await req('/api/accounting/day-close', { as: 'owner', body: { restaurant_id: RID, date: '2026-10-26', counted_cash: 580 } }, e)
  assert.equal(r2.status, 201)
  assert.equal((await body(r2)).line, 'failed')
})

test('ปิดวันซ้ำ -> 409 already_closed', async () => {
  on('/rpc/acct_close_day', () => json({ code: 'P0001', message: 'already_closed' }, 400))
  const r = await req('/api/accounting/day-close', { as: 'owner', body: { restaurant_id: RID, date: '2026-10-26', counted_cash: 0 } })
  assert.equal(r.status, 409)
})

test('ส่งออก CSV: UTF-8 BOM หัวตารางไทย เป็นไฟล์แนบ', async () => {
  on('/rpc/acct_journal_export', () =>
    json([{ entry_no: 1, entry_date: '2026-10-26', source_type: 'bill', memo: 'ขาย โต๊ะ 1', reason: null, created_by_name: 'a',
      account_code: '1010', account_name: 'เงินสด', debit: '150', credit: '0', line_memo: null }]))
  const r = await req(`/api/accounting/export?restaurant_id=${RID}&from=2026-10-01&to=2026-10-26&report=journal&format=csv`, { as: 'accountant' })
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type') ?? '', /text\/csv/)
  assert.match(r.headers.get('content-disposition') ?? '', /plato-journal-2026-10-01_2026-10-26\.csv/)
  const bytes = new Uint8Array(await r.arrayBuffer())
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]) // BOM (text() ตัดทิ้งให้ จึงตรวจเป็นไบต์)
  const text = new TextDecoder().decode(bytes)
  assert.ok(text.startsWith('วันที่,เลขที่,ประเภท'))
  assert.ok(text.includes('2026-10-26,1,ขาย,ขาย โต๊ะ 1,1010,เงินสด,150,0'))
})

test('ส่งออก Excel: งบทดลองเป็น XML Spreadsheet / รายงาน/รูปแบบผิด 400', async () => {
  on('/rpc/acct_trial_balance', () => json([{ account_id: 'a', code: '1010', name: 'เงินสด', type: 'asset', grp: 'cash', opening: 0, debit: 150, credit: 0, closing: 150 }]))
  const r = await req(`/api/accounting/export?restaurant_id=${RID}&from=2026-10-01&to=2026-10-26&report=trial_balance&format=xls`, { as: 'manager' })
  assert.match(r.headers.get('content-type') ?? '', /vnd\.ms-excel/)
  assert.ok((await r.text()).includes('<Data ss:Type="Number">150</Data>'))
  assert.equal((await req(`/api/accounting/export?restaurant_id=${RID}&from=2026-10-01&to=2026-10-26&report=x`, { as: 'owner' })).status, 400)
  assert.equal((await req(`/api/accounting/export?restaurant_id=${RID}&from=2026-10-01&to=2026-10-26&format=pdf`, { as: 'owner' })).status, 400)
  assert.equal((await req(`/api/accounting/export?restaurant_id=${RID}&from=2026-10-01&to=2026-10-26`, { as: 'kitchen' })).status, 403)
})

test('ตั้งค่า: เจ้าของเท่านั้น ตรวจค่า และสร้างแถวใหม่ถ้ายังไม่มี (onboarding)', async () => {
  assert.equal((await req('/api/accounting/settings', { method: 'PATCH', as: 'manager', body: { restaurant_id: RID, accounting_mode: 'pro' } })).status, 403)
  assert.equal((await req('/api/accounting/settings', { method: 'PATCH', as: 'owner', body: { restaurant_id: RID, accounting_mode: 'expert' } })).status, 400)
  on('/rest/v1/shop_settings', () => json([]), 'PATCH')
  on('/rest/v1/shop_settings', () => json([{}], 201), 'POST')
  const r = await req('/api/accounting/settings', { method: 'PATCH', as: 'owner', body: { restaurant_id: RID, business_type: 'company', vat_registered: true, accounting_mode: 'pro', onboarded: true } })
  assert.equal(r.status, 200)
  const ins = callsTo('/rest/v1/shop_settings').find((c) => c.method === 'POST')!.body as Record<string, unknown>
  assert.equal(ins.restaurant_id, RID)
  assert.equal(ins.accounting_mode, 'pro')
  assert.ok(typeof ins.accounting_onboarded_at === 'string')
})

test('pickSettings: กรองเฉพาะช่องตั้งค่าบัญชี', () => {
  assert.deepEqual(pickSettings({ accounting_mode: 'simple', line_to: 'x', vat_rate: 7 }), { accounting_mode: 'simple', vat_rate: 7 })
  assert.equal(pickSettings({ vat_registered: 'yes' }), null)
  assert.equal(pickSettings({ food_cost_target_max: 150 }), null)
})

// ===== ภาษี: ภาษีซื้อ / หัก ณ ที่จ่าย (ภ.ง.ด.3/53) / เอกสารภาษี / รายงาน กรมสรรพากร (หน้า AcctExpenses / AcctReports) =====
const COMPANY_TAX_ID = '0105551234567' // นิติบุคคล → ภ.ง.ด.53
const PERSON_TAX_ID = '1101700203450' // บุคคลธรรมดา → ภ.ง.ด.3
const EXPENSE = { restaurant_id: RID, account_id: ORDER, amount: 1070, vat_amount: 70, payment_method: 'bank', spent_on: '2026-11-05' }

test('whtTypeFor / WHT_TYPES: ขึ้นต้น 0 = ภ.ง.ด.53 / อื่นๆ = ภ.ง.ด.3', () => {
  assert.equal(whtTypeFor(COMPANY_TAX_ID), 'pnd53')
  assert.equal(whtTypeFor(PERSON_TAX_ID), 'pnd3')
  assert.deepEqual([...WHT_TYPES], ['pnd3', 'pnd53'])
})

test('POST /accounting/expenses: ใบกำกับภาษีซื้อ + หัก ณ ที่จ่าย ภ.ง.ด.53 ส่งครบทุกช่อง', async () => {
  on('/rest/v1/expenses', () => json([{ id: 'e1' }], 201), 'POST')
  const r = await req('/api/accounting/expenses', {
    as: 'owner',
    body: {
      ...EXPENSE,
      supplier_name: ' บจก. ซัพพลาย ',
      supplier_tax_id: COMPANY_TAX_ID,
      supplier_branch_code: '00001',
      tax_invoice_no: 'IV-2026-001',
      tax_invoice_date: '2026-11-04',
      wht_rate: 3,
      wht_type: 'pnd53',
    },
  })
  assert.equal(r.status, 201)
  const sent = callsTo('/rest/v1/expenses')[0].body as Record<string, unknown>
  assert.deepEqual(
    [sent.supplier_name, sent.supplier_tax_id, sent.supplier_branch_code, sent.tax_invoice_no, sent.tax_invoice_date, sent.wht_rate, sent.wht_type, sent.vat_amount],
    ['บจก. ซัพพลาย', COMPANY_TAX_ID, '00001', 'IV-2026-001', '2026-11-04', 3, 'pnd53', 70],
  )
  // ยอดหัก ณ ที่จ่ายให้ฐานข้อมูลคิด (expenses_tax_fields) ไม่รับจาก client
  assert.equal('wht_amount' in sent, false)
})

test('POST /accounting/expenses: ภ.ง.ด.3 กับบุคคลธรรมดา / ไม่ส่งแบบ = ให้ฐานข้อมูลเลือก', async () => {
  on('/rest/v1/expenses', () => json([{ id: 'e2' }], 201), 'POST')
  const person = { ...EXPENSE, vat_amount: 0, amount: 5000, supplier_name: 'นายช่าง', supplier_tax_id: PERSON_TAX_ID, wht_rate: 3 }
  assert.equal((await req('/api/accounting/expenses', { as: 'accountant', body: { ...person, wht_type: 'pnd3' } })).status, 201)
  assert.equal((callsTo('/rest/v1/expenses')[0].body as Record<string, unknown>).wht_type, 'pnd3')
  assert.equal((await req('/api/accounting/expenses', { as: 'accountant', body: person })).status, 201)
  assert.equal('wht_type' in (callsTo('/rest/v1/expenses')[1].body as Record<string, unknown>), false)
})

test('POST /accounting/expenses: แบบ ภ.ง.ด. ไม่ตรงประเภทผู้ขาย / ไม่มีอัตรา / ค่าแปลก -> 400 ไม่เรียกฐานข้อมูล', async () => {
  const company = { ...EXPENSE, supplier_name: 'บจก. ก', supplier_tax_id: COMPANY_TAX_ID }
  const cases: [Record<string, unknown>, string][] = [
    [{ ...company, wht_rate: 3, wht_type: 'pnd3' }, 'wht_type_mismatch'],
    [{ ...company, supplier_tax_id: PERSON_TAX_ID, wht_rate: 3, wht_type: 'pnd53' }, 'wht_type_mismatch'],
    [{ ...company, wht_type: 'pnd53' }, 'invalid_wht_type'],
    [{ ...company, wht_rate: 3, wht_type: 'pnd1' }, 'invalid_wht_type'],
    [{ ...EXPENSE, wht_rate: 3 }, 'invalid_wht'],
    [{ ...company, wht_rate: 7 }, 'invalid_wht'],
    [{ ...company, tax_invoice_no: 'IV-1' }, 'invalid_tax_invoice'],
    [{ ...company, supplier_tax_id: '12345' }, 'invalid_supplier_tax_id'],
    [{ ...company, supplier_branch_code: '1' }, 'invalid_supplier_branch_code'],
  ]
  for (const [b, code] of cases) {
    const r = await req('/api/accounting/expenses', { as: 'owner', body: b })
    assert.equal(r.status, 400, code)
    assert.equal((await body(r)).error, code)
  }
  assert.equal(callsTo('/rest/v1/expenses').length, 0)
})

test('POST /accounting/expenses: ใบกำกับภาษีซื้อซ้ำ (unique index) ส่งต่อข้อผิดพลาดฐานข้อมูล', async () => {
  on('/rest/v1/expenses', () => json({ code: '23505', message: 'duplicate key value violates unique constraint "expenses_tax_invoice_key"' }, 409), 'POST')
  const r = await req('/api/accounting/expenses', {
    as: 'owner',
    body: { ...EXPENSE, supplier_name: 'บจก. ก', supplier_tax_id: COMPANY_TAX_ID, tax_invoice_no: 'IV-1', tax_invoice_date: '2026-11-04' },
  })
  assert.ok(r.status >= 400)
})

test('GET /accounting/expenses: อ่านช่องผู้ขาย ใบกำกับ และหัก ณ ที่จ่าย / ครัว 403', async () => {
  on('/rpc/acct_expense_export', () => json([{ id: 'e1', wht_type: 'pnd53', wht_amount: '30.00' }]))
  const r = await req(`/api/accounting/expenses?restaurant_id=${RID}&from=2026-11-01&to=2026-11-30`, { as: 'manager' })
  assert.equal(r.status, 200)
  assert.deepEqual(callsTo('/rpc/acct_expense_export')[0].body, { p_restaurant_id: RID, p_from: '2026-11-01', p_to: '2026-11-30' })
  assert.equal((await body(r)).expenses[0].wht_type, 'pnd53')
  assert.equal((await req(`/api/accounting/expenses?restaurant_id=${RID}&from=2026-11-01&to=2026-11-30`, { as: 'kitchen' })).status, 403)
})

test('GET /tax/documents: แท็บเอกสารภาษีดึงร่างทั้งหมด + เอกสารตามวันที่ออก / สถานะผิด 400', async () => {
  on('/rpc/tax_documents_list', () => json([{ id: 'd1', doc_type: 'TAX', status: 'draft', total_amount: '1070.00' }]))
  const drafts = await req(`/api/tax/documents?restaurant_id=${RID}&status=draft`, { as: 'accountant' })
  assert.equal(drafts.status, 200)
  assert.equal((callsTo('/rpc/tax_documents_list')[0].body as { p_status: string }).p_status, 'draft')
  assert.equal((await body(drafts)).documents[0].status, 'draft')
  await req(`/api/tax/documents?restaurant_id=${RID}&from=2026-11-01&to=2026-11-30`, { as: 'owner' })
  assert.deepEqual(callsTo('/rpc/tax_documents_list')[1].body, { p_restaurant_id: RID, p_from: '2026-11-01', p_to: '2026-11-30', p_doc_type: null, p_status: null, p_order_id: null })
  assert.equal((await req(`/api/tax/documents?restaurant_id=${RID}&status=archived`, { as: 'owner' })).status, 400)
  assert.equal((await req(`/api/tax/documents?restaurant_id=${RID}&from=2026-13-01`, { as: 'owner' })).status, 400)
})

test('POST /tax/documents/:id/confirm + GET xml: ยืนยันร่างด้วยเครื่อง POS แล้วดาวน์โหลด XML ETDA', async () => {
  const DOC = '88888888-8888-4888-8888-888888888888'
  on('/rest/v1/tax_documents?select=id&', () => json([{ id: DOC }]))
  on('/rpc/tax_doc_confirm', () => json({ id: DOC, status: 'confirmed', doc_number: 'TAX-POS01-202611-000001', xml_payload: '<x/>' }))
  const r = await req(`/api/tax/documents/${DOC}/confirm`, { as: 'manager', body: { restaurant_id: RID, terminal_code: 'pos01' } })
  assert.equal(r.status, 200)
  const b = await body(r)
  assert.equal(b.document.doc_number, 'TAX-POS01-202611-000001')
  assert.equal(b.document.has_xml, true)
  assert.equal('xml_payload' in b.document, false)
  assert.deepEqual(callsTo('/rpc/tax_doc_confirm')[0].body, { p_document_id: DOC, p_terminal_code: 'POS01' })
  assert.equal((await req(`/api/tax/documents/${DOC}/confirm`, { as: 'owner', body: { restaurant_id: RID } })).status, 400)

  on('select=doc_number,status,xml_payload', () => json([{ doc_number: 'TAX-POS01-202611-000001', status: 'confirmed', xml_payload: '<rsm:TaxInvoice_CrossIndustryInvoice/>' }]))
  const x = await req(`/api/tax/documents/${DOC}/xml?restaurant_id=${RID}`, { as: 'accountant' })
  assert.equal(x.status, 200)
  assert.match(x.headers.get('content-type') ?? '', /application\/xml/)
  assert.match(x.headers.get('content-disposition') ?? '', /filename="TAX-POS01-202611-000001\.xml"/)
})

test('รายงาน กรมสรรพากร: JSON ที่หน้า RD Tax ใช้ + ชื่อไฟล์ CSV ตรงกับหน้าเว็บ', async () => {
  on('/rest/v1/tax_settings', () => json([{ company_name: 'บจก. ร้านอาหาร', tax_id: COMPANY_TAX_ID, branch_code: '00000', registered_address: 'กรุงเทพฯ' }]))
  on('/rpc/acct_expense_export', () =>
    json([{ tax_invoice_date: '2026-11-04', tax_invoice_no: 'IV-1', supplier_name: 'บจก. ซัพพลาย', supplier_tax_id: COMPANY_TAX_ID, supplier_branch_code: '00000', amount: '1070', vat_amount: '70', spent_on: '2026-11-05', wht_rate: '3', wht_amount: '30', wht_type: 'pnd53', note: null, accounts: { name: 'ค่าบริการ' } },
    { spent_on: '2026-11-06', supplier_name: 'นายช่าง', supplier_tax_id: PERSON_TAX_ID, supplier_branch_code: null, amount: '5000', vat_amount: '0', wht_rate: '3', wht_amount: '150', wht_type: 'pnd3', note: 'ซ่อมแอร์', accounts: null }]),
  )
  on('tax_invoice_no=is.null', () => json([]))
  on('wht_type=', () =>
    json([
      { spent_on: '2026-11-05', supplier_name: 'บจก. ซัพพลาย', supplier_tax_id: COMPANY_TAX_ID, supplier_branch_code: '00000', amount: '1070', vat_amount: '70', wht_rate: '3', wht_amount: '30', wht_type: 'pnd53', note: null, accounts: { name: 'ค่าบริการ' } },
      { spent_on: '2026-11-06', supplier_name: 'นายช่าง', supplier_tax_id: PERSON_TAX_ID, supplier_branch_code: null, amount: '5000', vat_amount: '0', wht_rate: '3', wht_amount: '150', wht_type: 'pnd3', note: 'ซ่อมแอร์', accounts: null },
    ]),
  )
  const p = await body(await req(`/api/accounting/reports/purchase-tax?restaurant_id=${RID}&month=2026-11`, { as: 'accountant' }))
  assert.deepEqual(p.totals, { value: 1000, vat: 70, total: 1070 })
  assert.deepEqual(p.without_invoice, { count: 0, vat: 0 })
  assert.equal(p.seller.tax_id, COMPANY_TAX_ID)

  const w = await body(await req(`/api/accounting/reports/wht?restaurant_id=${RID}&month=2026-11`, { as: 'owner' }))
  assert.equal(w.type, 'all')
  assert.deepEqual(w.summary.pnd53, { count: 1, paid_amount: 1000, wht: 30 })
  assert.deepEqual(w.summary.pnd3, { count: 1, paid_amount: 5000, wht: 150 })
  assert.equal(w.summary.total_wht, 180)
  assert.deepEqual(w.rows.map((r: { form: string }) => r.form), ['pnd3', 'pnd53'])

  const csv = await req(`/api/accounting/reports/wht?restaurant_id=${RID}&month=2026-11&format=csv&type=pnd53`, { as: 'owner' })
  assert.match(csv.headers.get('content-disposition') ?? '', /filename="wht-pnd53-2026-11\.csv"/)
  const pc = await req(`/api/accounting/reports/purchase-tax?restaurant_id=${RID}&month=2026-11&format=csv`, { as: 'owner' })
  assert.match(pc.headers.get('content-disposition') ?? '', /filename="purchase-tax-2026-11\.csv"/)
  assert.match(await pc.text(), /รายงานภาษีซื้อ/)
  assert.equal((await req(`/api/accounting/reports/wht?restaurant_id=${RID}&month=2026-11&format=pdf`, { as: 'owner' })).status, 400)
  assert.equal((await req(`/api/accounting/reports/pp30-summary?restaurant_id=${RID}&month=2026-11`, { as: 'kitchen' })).status, 403)
})
