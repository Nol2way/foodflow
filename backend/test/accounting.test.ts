// ทดสอบ API บัญชีด้วย fetch จำลอง (ไม่ต่อ Supabase / LINE จริง)
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.ts'
import { pickSettings } from '../src/accounting.ts'
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
  JWT[r] = await signJwt({ sub: id, email: `${r}@x.com`, role: 'authenticated', aud: 'authenticated', iat: now(), exp: now() + 3600 }, SECRET)
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
  if (u.pathname === '/rest/v1/rpc/app_user_active') return json(true)
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

test('expenses: พนักงานบัญชีบันทึกด้วย JWT ตัวเอง · ผู้จัดการ 403', async () => {
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

test('ปิดวัน: ผู้จัดการปิดได้ พนักงานบัญชี 403 · ต้องกรอกยอดนับ', async () => {
  on('/rpc/acct_close_day', () => json(CLOSED))
  assert.equal((await req('/api/accounting/day-close', { as: 'accountant', body: { restaurant_id: RID, date: '2026-10-26', counted_cash: 1 } })).status, 403)
  assert.equal((await req('/api/accounting/day-close', { as: 'manager', body: { restaurant_id: RID, date: '2026-10-26' } })).status, 400)
  const r = await req('/api/accounting/day-close', { as: 'manager', body: { restaurant_id: RID, date: '2026-10-26', counted_cash: 580 } })
  assert.equal(r.status, 201)
  assert.equal((await body(r)).line, 'not_configured')
  assert.deepEqual(callsTo('/rpc/acct_close_day')[0].body, { p_restaurant_id: RID, p_date: '2026-10-26', p_counted_cash: 580, p_note: null })
})

test('ปิดวัน: ส่งสรุปเข้า LINE ของร้าน · LINE ล่มก็ยังปิดวันสำเร็จ', async () => {
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
  on('/rpc/acct_journal_rows', () =>
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

test('ส่งออก Excel: งบทดลองเป็น XML Spreadsheet · รายงาน/รูปแบบผิด 400', async () => {
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
