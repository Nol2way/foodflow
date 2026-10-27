// ทดสอบ API สต็อกวัตถุดิบด้วย fetch จำลอง (ไม่ต่อ Supabase จริง) · กฎสต็อกจริงทดสอบที่ database/tests/test_stock.py
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.ts'
import { countLines, pickFields, receiptLines, recipeLines } from '../src/stock.ts'
import { signJwt } from '../src/jwt.ts'
import type { Env } from '../src/env.ts'

const SB = 'https://proj.supabase.co'
const RID = '11111111-1111-4111-8111-111111111111'
const ING = '22222222-2222-4222-8222-222222222222'
const ING2 = '55555555-5555-4555-8555-555555555555'
const SUP = '88888888-8888-4888-8888-888888888888'
const USERS: Record<string, string> = {
  owner: '33333333-3333-4333-8333-333333333333',
  manager: '66666666-6666-4666-8666-666666666666',
  stock: '99999999-9999-4999-8999-999999999999',
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
const env: Env = { SUPABASE_URL: SB, SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service-secret', SUPABASE_JWT_SECRET: SECRET }

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}
let calls: Call[] = []
let handlers: ((c: Call) => Response | undefined)[] = []
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const headers: Record<string, string> = {}
  new Headers(init.headers).forEach((v, k) => (headers[k] = v))
  const call: Call = { url: String(input), method: init.method ?? 'GET', headers, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body }
  calls.push(call)
  for (const h of handlers) {
    const r = h(call)
    if (r) return r
  }
  const u = new URL(call.url)
  if (u.pathname === '/rest/v1/rpc/app_user_active') return json(true)
  if (u.pathname === '/rest/v1/staff_members' && call.method === 'GET') {
    const uid = u.searchParams.get('user_id')?.replace('eq.', '') ?? ''
    return json(ROLE[uid] ? [{ role: ROLE[uid] }] : [])
  }
  return json({ message: `unexpected ${call.method} ${call.url}` }, 599)
}) as typeof fetch

const app = createApp()
function req(path: string, opts: { method?: string; body?: unknown; as?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.as) headers.authorization = `Bearer ${JWT[opts.as]}`
  return app.request(path, { method: opts.method ?? (opts.body ? 'POST' : 'GET'), headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }, env)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (r: Response): Promise<any> => r.json()
const callsTo = (part: string) => calls.filter((c) => c.url.includes(part))
const on = (part: string, res: () => Response, method?: string) =>
  handlers.push((c) => (c.url.includes(part) && (!method || c.method === method) ? res() : undefined))
const pgError = (message: string, code = 'P0001') => json({ code, message }, 400)

beforeEach(() => {
  calls = []
  handlers = []
})

// ---------- สิทธิ์ ----------
test('ภาพรวม: เจ้าของ ผู้จัดการ สต็อก บัญชีเปิดได้ · ครัว 403 · ไม่ล็อกอิน 401', async () => {
  on('/rpc/stock_overview', () => json({ stock_value: 100, out: [], low: [] }))
  for (const who of ['owner', 'manager', 'stock', 'accountant']) {
    assert.equal((await req(`/api/stock/overview?restaurant_id=${RID}`, { as: who })).status, 200, who)
  }
  assert.equal((await req(`/api/stock/overview?restaurant_id=${RID}`, { as: 'kitchen' })).status, 403)
  assert.equal((await req(`/api/stock/overview?restaurant_id=${RID}`)).status, 401)
})

test('ภาพรวม: เรียกฐานข้อมูลด้วย JWT ของผู้ใช้ (RLS ทำงาน) ไม่ใช้ service role', async () => {
  on('/rpc/stock_overview', () => json({ stock_value: 100 }))
  await req(`/api/stock/overview?restaurant_id=${RID}`, { as: 'stock' })
  const call = callsTo('/rpc/stock_overview')[0]
  assert.equal(call.headers.authorization, `Bearer ${JWT.stock}`)
  assert.equal(call.headers.apikey, 'anon')
  assert.deepEqual(call.body, { p_restaurant_id: RID })
})

test('รับเข้า/นับ: บัญชีอ่านได้แต่บันทึกไม่ได้ (403 ก่อนถึงฐานข้อมูล)', async () => {
  const r1 = await req('/api/stock/receipts', { as: 'accountant', body: { restaurant_id: RID, lines: [{ ingredient_id: ING, quantity: 1, unit_cost: 1 }] } })
  const r2 = await req('/api/stock/counts', { as: 'accountant', body: { restaurant_id: RID, lines: [{ ingredient_id: ING, counted_qty: 1 }] } })
  assert.equal(r1.status, 403)
  assert.equal(r2.status, 403)
  assert.equal(callsTo('/rpc/stock_receive').length + callsTo('/rpc/submit_stock_count').length, 0)
})

test('รับรองใบนับ/กลับรายการ: เฉพาะเจ้าของและผู้จัดการ', async () => {
  on('/rpc/verify_stock_count', () => json(null))
  on('/rpc/stock_reverse_movement', () => json(ING2))
  const id = ING2
  assert.equal((await req(`/api/stock/counts/${id}/verify`, { as: 'stock', body: { restaurant_id: RID } })).status, 403)
  assert.equal((await req(`/api/stock/counts/${id}/verify`, { as: 'manager', body: { restaurant_id: RID } })).status, 200)
  assert.equal((await req(`/api/stock/movements/${id}/reverse`, { as: 'stock', body: { restaurant_id: RID, reason: 'x' } })).status, 403)
  const r = await req(`/api/stock/movements/${id}/reverse`, { as: 'owner', body: { restaurant_id: RID, reason: 'คีย์ผิด' } })
  assert.equal(r.status, 201)
  assert.deepEqual((await body(r)).reversal_id, ING2)
})

// ---------- รับเข้า ----------
test('รับเข้า: ส่งแบบแพ็คพร้อมวันหมดอายุ ไปที่ stock_receive และคืนคำเตือน', async () => {
  on('/rpc/stock_receive', () => json({ receipt_id: ING2, warnings: [{ ingredient_id: ING, price_change_pct: 12.5 }], recosted_recipes: 3 }))
  const r = await req('/api/stock/receipts', {
    as: 'stock',
    body: { restaurant_id: RID, supplier_id: SUP, invoice_no: ' INV-1 ', lines: [{ ingredient_id: ING, pack_qty: 3, pack_size: 1000, pack_price: 180, expiry_date: '2026-11-02' }] },
  })
  assert.equal(r.status, 201)
  const b = await body(r)
  assert.equal(b.recosted_recipes, 3)
  assert.equal(b.warnings[0].price_change_pct, 12.5)
  const args = callsTo('/rpc/stock_receive')[0].body as Record<string, unknown>
  assert.equal(args.p_supplier_id, SUP)
  assert.equal(args.p_invoice_no, 'INV-1')
  assert.equal(args.p_record_expense, true)
  assert.deepEqual(args.p_lines, [{ ingredient_id: ING, pack_qty: 3, pack_size: 1000, pack_price: 180, expiry_date: '2026-11-02' }])
})

test('รับเข้า: ข้อมูลผิดรูปแบบตอบ 400 โดยไม่เรียกฐานข้อมูล', async () => {
  const bad = [
    [],
    [{ ingredient_id: ING, quantity: -1, unit_cost: 1 }],
    [{ ingredient_id: ING, quantity: 1, unit_cost: 1 }, { ingredient_id: ING, quantity: 2, unit_cost: 1 }],
    [{ ingredient_id: ING, quantity: 1, unit_cost: 1, expiry_date: '02/11/2026' }],
    [{ ingredient_id: ING, pack_qty: 1, pack_size: 0, pack_price: 10 }],
    [{ ingredient_id: 'nope', quantity: 1, unit_cost: 1 }],
  ]
  for (const lines of bad) {
    const r = await req('/api/stock/receipts', { as: 'stock', body: { restaurant_id: RID, lines } })
    assert.equal(r.status, 400, JSON.stringify(lines))
  }
  assert.equal(callsTo('/rpc/stock_receive').length, 0)
})

// ---------- ข้อผิดพลาดของกฎสต็อก -> ข้อความไทย ----------
test('ของไม่พอ / ล็อตถูกใช้แล้ว ตอบ 409 พร้อมข้อความไทยและชื่อวัตถุดิบ', async () => {
  on('/rpc/stock_reverse_movement', () => pgError('lot_already_used'))
  const r = await req(`/api/stock/movements/${ING2}/reverse`, { as: 'owner', body: { restaurant_id: RID, reason: 'x' } })
  assert.equal(r.status, 409)
  assert.equal((await body(r)).error, 'lot_already_used')
  handlers = []
  on('/rpc/submit_stock_count', () => pgError('insufficient_stock: กุ้ง'))
  const r2 = await req('/api/stock/counts', { as: 'stock', body: { restaurant_id: RID, lines: [{ ingredient_id: ING, counted_qty: 1 }] } })
  const b2 = await body(r2)
  assert.equal(r2.status, 409)
  assert.match(b2.message, /วัตถุดิบไม่พอ.*กุ้ง/)
})

test('รหัสที่ซ้ำกับโมดูลบัญชี: เส้นทางสต็อกใช้ข้อความของสต็อก', async () => {
  on('/rpc/stock_reverse_movement', () => pgError('reverse_not_allowed: recipe_deduct'))
  const r = await req(`/api/stock/movements/${ING2}/reverse`, { as: 'owner', body: { restaurant_id: RID, reason: 'x' } })
  const b = await body(r)
  assert.equal(r.status, 400)
  assert.match(b.message, /ยกเลิกออเดอร์/)
})

test('กลับรายการ: ไม่ใส่เหตุผล 400', async () => {
  const r = await req(`/api/stock/movements/${ING2}/reverse`, { as: 'owner', body: { restaurant_id: RID, reason: '  ' } })
  assert.equal(r.status, 400)
  assert.equal((await body(r)).error, 'reason_required')
})

// ---------- นับสต็อก ----------
test('นับ: ใบนับ blind ส่งเฉพาะรายการ ไม่มียอดในระบบ · กรอง ABC', async () => {
  on('/rpc/stock_count_sheet', () => json([{ ingredient_id: ING, name: 'กุ้ง', storage_location: 'ตู้แช่ 1' }]))
  const r = await req(`/api/stock/count-sheet?restaurant_id=${RID}&abc=a,B`, { as: 'stock' })
  assert.equal(r.status, 200)
  assert.deepEqual((callsTo('/rpc/stock_count_sheet')[0].body as Record<string, unknown>).p_abc, ['A', 'B'])
  assert.equal((await req(`/api/stock/count-sheet?restaurant_id=${RID}&abc=D`, { as: 'stock' })).status, 400)
  assert.equal((await req(`/api/stock/count-sheet?restaurant_id=${RID}`, { as: 'accountant' })).status, 403)
})

test('นับ: บันทึกแล้วคืนแค่รหัสใบนับ (ไม่เปิดเผยยอดที่ควรเหลือให้ผู้นับ)', async () => {
  on('/rpc/submit_stock_count', () => json(ING2))
  const r = await req('/api/stock/counts', {
    as: 'stock',
    body: { restaurant_id: RID, count_type: 'weekly', lines: [{ ingredient_id: ING, counted_qty: 1250.00049, entered_text: '2 ถุง + 250 g', note: ' หล่น ' }] },
  })
  assert.equal(r.status, 201)
  assert.deepEqual(await body(r), { count_id: ING2 })
  const args = callsTo('/rpc/submit_stock_count')[0].body as Record<string, unknown>
  assert.equal(args.p_count_type, 'weekly')
  assert.deepEqual(args.p_lines, [{ ingredient_id: ING, counted_qty: 1250, entered_text: '2 ถุง + 250 g', note: 'หล่น' }])
  assert.equal((await req('/api/stock/counts', { as: 'stock', body: { restaurant_id: RID, count_type: 'hourly', lines: [{ ingredient_id: ING, counted_qty: 1 }] } })).status, 400)
})

test('รายงานส่วนต่าง: ส่งต่อแถวจาก stock_variance_report', async () => {
  const line = { ingredient_name: 'ปู', expected_qty: 34000, counted_qty: 30000, variance_qty: -4000, variance_pct: -11.76, color: 'red', recipe_alert: false }
  on('/rpc/stock_variance_report', () => json([line]))
  const r = await req(`/api/stock/counts/${ING2}/variance?restaurant_id=${RID}`, { as: 'accountant' })
  assert.deepEqual((await body(r)).lines, [line])
})

// ---------- วัตถุดิบ ----------
test('วัตถุดิบ: ต้องเลือกหน่วยฐาน · g/ml ใช้ชื่อหน่วยฐาน · ยอดแก้ผ่าน PATCH ไม่ได้', async () => {
  on('/rest/v1/ingredients', () => json([{ id: ING }]), 'POST')
  on('/rest/v1/ingredients', () => json([{ id: ING }]), 'PATCH')
  assert.equal((await req('/api/stock/ingredients', { as: 'stock', body: { restaurant_id: RID, name: 'กุ้ง' } })).status, 400)
  const r = await req('/api/stock/ingredients', {
    as: 'stock',
    body: { restaurant_id: RID, name: 'กุ้ง', recipe_unit: 'g', unit: 'kg', quantity_on_hand: 2000, cost_per_unit: 0.4, trim_yield_pct: 60, abc_class: 'A' },
  })
  assert.equal(r.status, 201)
  const ins = callsTo('/rest/v1/ingredients').find((c) => c.method === 'POST')!.body as Record<string, unknown>
  assert.equal(ins.unit, 'g')
  assert.equal(ins.restaurant_id, RID)
  assert.equal(ins.quantity_on_hand, 2000)
  await req(`/api/stock/ingredients/${ING}`, { method: 'PATCH', as: 'manager', body: { restaurant_id: RID, name: 'กุ้งขาว', quantity_on_hand: 1, cost_per_unit: 9 } })
  const upd = callsTo('/rest/v1/ingredients').find((c) => c.method === 'PATCH')!.body as Record<string, unknown>
  assert.deepEqual(upd, { name: 'กุ้งขาว' })
})

test('วัตถุดิบ: ค่าเกินช่วงตอบ 400 พร้อมชื่อช่อง', async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ trim_yield_pct: 120 }, 'trim_yield_pct'],
    [{ cook_yield_pct: 0 }, 'cook_yield_pct'],
    [{ abc_class: 'D' }, 'abc_class'],
    [{ supplier_id: 'x' }, 'supplier_id'],
    [{ shelf_order: 1.5 }, 'shelf_order'],
  ]
  for (const [patch, field] of cases) {
    const r = await req(`/api/stock/ingredients/${ING}`, { method: 'PATCH', as: 'stock', body: { restaurant_id: RID, ...patch } })
    assert.equal(r.status, 400)
    assert.equal((await body(r)).field, field)
  }
})

test('ผู้ขาย: วันส่งของต้องเป็น 0-6 ไม่ซ้ำ', async () => {
  on('/rest/v1/suppliers', () => json([{ id: SUP }]), 'POST')
  assert.equal((await req('/api/stock/suppliers', { as: 'manager', body: { restaurant_id: RID, name: 'แม็คโคร', delivery_days: [1, 1] } })).status, 400)
  assert.equal((await req('/api/stock/suppliers', { as: 'manager', body: { restaurant_id: RID, name: 'แม็คโคร', delivery_days: [7] } })).status, 400)
  const r = await req('/api/stock/suppliers', { as: 'manager', body: { restaurant_id: RID, name: 'แม็คโคร', lead_time_days: 2, delivery_days: [4, 1] } })
  assert.equal(r.status, 201)
  assert.deepEqual((callsTo('/rest/v1/suppliers')[0].body as Record<string, unknown>).delivery_days, [1, 4])
})

// ---------- สูตร ----------
test('สูตร: บรรทัดต้องเป็นวัตถุดิบหรือสูตรย่อยอย่างใดอย่างหนึ่ง · บันทึกผ่าน stock_save_recipe', async () => {
  on('/rpc/stock_save_recipe', () => json(ING2))
  on('/rest/v1/recipes', () => json([{ id: ING2, name: 'น้ำจิ้ม', recipe_lines: [] }]), 'GET')
  const bad = await req('/api/stock/recipes', { as: 'stock', body: { restaurant_id: RID, name: 'x', lines: [{ ingredient_id: ING, sub_recipe_id: ING2, qty: 1 }] } })
  assert.equal(bad.status, 400)
  const r = await req('/api/stock/recipes', {
    as: 'stock',
    body: { restaurant_id: RID, name: ' น้ำจิ้ม ', output_qty: 5000, output_unit: 'ml', lines: [{ ingredient_id: ING, qty: 1000 }, { sub_recipe_id: ING2, qty: 30 }] },
  })
  assert.equal(r.status, 201)
  const args = callsTo('/rpc/stock_save_recipe')[0].body as Record<string, unknown>
  assert.equal(args.p_id, null)
  assert.equal(args.p_name, 'น้ำจิ้ม')
  assert.deepEqual(args.p_lines, [{ ingredient_id: ING, qty: 1000 }, { sub_recipe_id: ING2, qty: 30 }])
})

test('สูตรวนกลับ: ข้อความไทยจากฐานข้อมูล', async () => {
  on('/rpc/stock_save_recipe', () => pgError('recipe_cycle'))
  const r = await req(`/api/stock/recipes/${ING2}`, { method: 'PUT', as: 'stock', body: { restaurant_id: RID, name: 'x', lines: [{ sub_recipe_id: ING, qty: 1 }] } })
  assert.equal(r.status, 400)
  assert.match((await body(r)).message, /วนกลับ/)
})

// ---------- Yield / ประวัติ ----------
test('yield test: ต้องชั่ง 3 ครั้ง', async () => {
  on('/rpc/record_yield_test', () => json({ avg_pct: 75 }))
  const two = await req('/api/stock/yield-tests', { as: 'stock', body: { restaurant_id: RID, ingredient_id: ING, kind: 'trim', trials: [{ before: 1, after: 1 }, { before: 1, after: 1 }] } })
  assert.equal(two.status, 400)
  const ok = await req('/api/stock/yield-tests', {
    as: 'stock',
    body: { restaurant_id: RID, ingredient_id: ING, kind: 'trim', apply: true, trials: [{ before: 500, after: 350 }, { before: '400', after: 300 }, { before: 1000, after: 800 }] },
  })
  assert.equal(ok.status, 201)
  const args = callsTo('/rpc/record_yield_test')[0].body as Record<string, unknown>
  assert.equal(args.p_apply, true)
  assert.deepEqual(args.p_trials, [{ before: 500, after: 350 }, { before: 400, after: 300 }, { before: 1000, after: 800 }])
})

test('ประวัติ: กรองวัตถุดิบ ผู้ทำรายการ ประเภท · ช่วงวันที่รวมวันสุดท้าย', async () => {
  on('/rpc/stock_history', () => json([]))
  const r = await req(`/api/stock/history?restaurant_id=${RID}&from=2026-10-01&to=2026-10-26&ingredient_id=${ING}&actor_id=${USERS.stock}&type=receive`, { as: 'manager' })
  assert.equal(r.status, 200)
  const args = callsTo('/rpc/stock_history')[0].body as Record<string, unknown>
  assert.equal(args.p_from, '2026-10-01T00:00:00+07:00')
  assert.equal(args.p_to, '2026-10-26T17:00:00.000Z')
  assert.equal(args.p_actor_id, USERS.stock)
  assert.equal(args.p_type, 'receive')
  assert.equal((await req(`/api/stock/history?restaurant_id=${RID}&from=2026-10-01&to=2026-10-26&type=waste`, { as: 'manager' })).status, 400)
  assert.equal((await req(`/api/stock/history?restaurant_id=${RID}&from=2025-01-01&to=2026-10-26`, { as: 'manager' })).status, 400)
})

// ---------- ตัวตรวจข้อมูล ----------
test('ตัวตรวจ: pickFields / receiptLines / countLines / recipeLines', () => {
  assert.equal(pickFields({ name: '' }, { name: { kind: 'text', max: 10, required: true } }, true), 'name')
  assert.deepEqual(pickFields({ par_level: null }, { par_level: { kind: 'num', min: 0, max: 9, nullable: true } }, false), { par_level: null })
  assert.equal(receiptLines([{ ingredient_id: ING, quantity: 0, unit_cost: 5 }])?.length, 1) // รับ 0 = ตีกลับ (ตรวจในฐานข้อมูล)
  assert.equal(receiptLines(Array.from({ length: 201 }, () => ({ ingredient_id: ING, quantity: 1, unit_cost: 1 }))), null)
  assert.equal(countLines([{ ingredient_id: ING, counted_qty: -0.1 }]), null)
  assert.deepEqual(recipeLines([]), [])
  assert.equal(recipeLines([{ ingredient_id: ING, qty: 0 }]), null)
})
