// ทดสอบ backend ด้วย fetch จำลอง (ไม่ต่อ Supabase / Gemini จริง)
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.ts'
import { resetMemoryLimiter } from '../src/guards.ts'
import { sendDueReports } from '../src/reports.ts'
import type { Env } from '../src/env.ts'

const SB = 'https://proj.supabase.co'
const RID = '11111111-1111-4111-8111-111111111111'
const OWNER = '33333333-3333-4333-8333-333333333333'
const KITCHEN = '44444444-4444-4444-8444-444444444444'
const NEWUSER = '55555555-5555-4555-8555-555555555555'
const MANAGER = '66666666-6666-4666-8666-666666666666'
const TOKENS: Record<string, string> = { 'tok-owner': OWNER, 'tok-kitchen': KITCHEN, 'tok-manager': MANAGER }
const ROLE: Record<string, string> = { [OWNER]: 'owner', [KITCHEN]: 'kitchen', [MANAGER]: 'manager' }

const baseEnv: Env = {
  SUPABASE_URL: SB,
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service-secret',
  GEMINI_API_KEY: 'gm-test',
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
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

// การตอบสนองพื้นฐานของบริการภายนอก
function defaults(c: Call): Response {
  const u = new URL(c.url)
  if (u.href === `${SB}/auth/v1/user`) {
    const id = TOKENS[(c.headers.authorization ?? '').replace('Bearer ', '')]
    return id ? json({ id }) : json({ msg: 'invalid' }, 401)
  }
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
function req(path: string, opts: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}, env: Env = baseEnv) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  return app.request(path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }, env)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (r: Response): Promise<any> => r.json()
const callsTo = (part: string) => calls.filter((c) => c.url.includes(part))

beforeEach(() => {
  calls = []
  handlers = []
  resetMemoryLimiter()
})

// ===== health / CORS =====
test('health บอกสถานะ ไม่เปิดเผยความลับ', async () => {
  const r = await req('/api/health')
  const b = await body(r)
  assert.deepEqual(b, { ok: true, ai: true, line: false })
  assert.ok(!JSON.stringify(b).includes('secret'))
})

test('CORS: อนุญาตเฉพาะ origin ที่ตั้งไว้', async () => {
  const ok = await req('/api/health', { headers: { origin: 'https://shop.example' } })
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://shop.example')
  const bad = await req('/api/health', { headers: { origin: 'https://evil.example' } })
  assert.equal(bad.headers.get('access-control-allow-origin'), null)
})

// ===== auth =====
test('auth: ไม่มี token / token ผิด -> 401', async () => {
  assert.equal((await req('/api/staff?restaurant_id=' + RID)).status, 401)
  assert.equal((await req('/api/staff?restaurant_id=' + RID, { token: 'nope' })).status, 401)
})

test('auth: บทบาทไม่พอ -> 403', async () => {
  assert.equal((await req('/api/staff?restaurant_id=' + RID, { token: 'tok-kitchen' })).status, 403)
  const r = await req('/api/ai/summary', { token: 'tok-kitchen', body: { restaurant_id: RID } })
  assert.equal(r.status, 403)
  const i = await req('/api/import/sales', { token: 'tok-kitchen', body: { restaurant_id: RID, csv: 'a' } })
  assert.equal(i.status, 403)
  assert.equal(callsTo('generativelanguage').length, 0)
})

test('auth: ตรวจบทบาทด้วย JWT ของผู้ใช้ ไม่ใช่ service role', async () => {
  await req('/api/staff?restaurant_id=' + RID, { token: 'tok-owner' })
  const check = callsTo('/rest/v1/staff_members')[0]
  assert.equal(check.headers.authorization, 'Bearer tok-owner')
  assert.equal(check.headers.apikey, 'anon')
})

test('auth: restaurant_id ไม่ใช่ UUID -> 400 (กัน query injection)', async () => {
  const r = await req('/api/staff?restaurant_id=x%26role=eq.owner', { token: 'tok-owner' })
  assert.equal(r.status, 400)
})

// ===== import =====
const CSV = 'datetime,ref,item,qty\n2026-09-01 12:00,B1,ข้าวผัด,2\n'

test('import: ส่งแถวที่ตรวจแล้วไป import_sales_history ด้วย JWT ผู้ใช้', async () => {
  handlers.push((c) => (c.url.endsWith('/rpc/import_sales_history') ? json({ orders: 1, lines: 1, blocked: false }) : undefined))
  const r = await req('/api/import/sales', { token: 'tok-owner', body: { restaurant_id: RID, csv: CSV, dry_run: true } })
  assert.equal(r.status, 200)
  const rpc = callsTo('/rpc/import_sales_history')[0]
  assert.equal(rpc.headers.authorization, 'Bearer tok-owner')
  assert.deepEqual(rpc.body, {
    p_restaurant_id: RID,
    p_rows: [{ line: 2, ref: 'B1', at: '2026-09-01 12:00:00', item: 'ข้าวผัด', qty: 2, price: '' }],
    p_dry_run: true,
    p_skip_unknown: false,
  })
})

test('import: แถวผิด -> 400 พร้อมเลขบรรทัด ไม่เรียกฐานข้อมูล', async () => {
  const r = await req('/api/import/sales', { token: 'tok-owner', body: { restaurant_id: RID, csv: CSV + 'bad,B2,x,0\n' } })
  assert.equal(r.status, 400)
  const b = await body(r)
  assert.equal(b.error, 'invalid_rows')
  assert.equal(b.errors[0].line, 3)
  assert.equal(callsTo('import_sales_history').length, 0)
})

test('import: ฐานข้อมูลตอบ forbidden -> 403', async () => {
  handlers.push((c) => (c.url.endsWith('/rpc/import_sales_history') ? json({ code: 'P0001', message: 'forbidden' }, 400) : undefined))
  const r = await req('/api/import/sales', { token: 'tok-owner', body: { restaurant_id: RID, csv: CSV } })
  assert.equal(r.status, 403)
})

test('import: ลบรอบนำเข้า', async () => {
  const batch = '88888888-8888-4888-8888-888888888888'
  handlers.push((c) => (c.method === 'DELETE' && c.url.includes('/rest/v1/orders') ? json([{ id: 'a' }, { id: 'b' }]) : undefined))
  const r = await req(`/api/import/${batch}?restaurant_id=${RID}`, { token: 'tok-owner', method: 'DELETE' })
  assert.deepEqual(await body(r), { deleted_orders: 2 })
  const del = callsTo('/rest/v1/orders')[0]
  assert.ok(del.url.includes(`import_batch=eq.${batch}`) && del.url.includes(`restaurant_id=eq.${RID}`))
  assert.equal(del.headers.authorization, 'Bearer tok-owner')
})

// ===== AI =====
function analyticsHandlers(orders = 30) {
  handlers.push((c) => {
    if (c.url.endsWith('/rpc/analytics_hourly'))
      return json([
        { day_of_week: 1, hour_of_day: 12, order_count: 20, revenue_total: 2000 },
        { day_of_week: 1, hour_of_day: 15, order_count: 2, revenue_total: 200 },
        { day_of_week: 2, hour_of_day: 18, order_count: 8, revenue_total: 900 },
      ])
    if (c.url.endsWith('/rpc/analytics_summary'))
      return json([{ order_count: orders, revenue_total: 3100, avg_bill: 103.333, avg_prep_minutes: 12.44, first_order_at: '2026-09-01' }])
    if (c.url.endsWith('/rpc/analytics_top_items')) return json([{ item_name: 'กะเพรา', quantity_sold: 25, revenue_total: 1500 }])
    if (c.url.includes('/rest/v1/menu_item_costs'))
      return json([
        { name: 'กะเพรา', price: 60, unit_cost: 30.75, ingredient_count: 4 },
        { name: 'น้ำเปล่า', price: 10, unit_cost: 0, ingredient_count: 0 },
      ])
    return undefined
  })
}

test('ai: ส่งเฉพาะตัวเลขที่คำนวณแล้วให้ Gemini และคืน facts ให้ตรวจสอบ', async () => {
  analyticsHandlers()
  handlers.push((c) => (c.url.startsWith('https://generativelanguage.googleapis.com') ? json({ candidates: [{ content: { parts: [{ text: 'สรุป: ช่วงพีค 12:00' }] } }] }) : undefined))
  const r = await req('/api/ai/summary', { token: 'tok-owner', body: { restaurant_id: RID, days: 28, question: 'ควรเพิ่มคนช่วงไหน' } })
  assert.equal(r.status, 200)
  const b = await body(r)
  assert.equal(b.answer, 'สรุป: ช่วงพีค 12:00')
  assert.equal(b.facts.orders, 30)
  assert.equal(b.facts.avg_bill_baht, 103.33)
  assert.deepEqual(b.facts.peak_hours, ['12:00–13:00'])
  assert.equal(b.facts.menu_food_cost[0].food_cost_percent, 51.3)
  assert.deepEqual(b.facts.menus_without_recipe, ['น้ำเปล่า'])

  const ai = callsTo('generativelanguage.googleapis.com')[0]
  assert.equal(ai.headers['x-goog-api-key'], 'gm-test')
  assert.match(ai.url, /\/models\/gemini-2\.5-flash:generateContent$/)
  const sent = ai.body as { systemInstruction: { parts: { text: string }[] }; contents: { parts: { text: string }[] }[] }
  assert.match(sent.systemInstruction.parts[0].text, /ห้ามคิดหรือประมาณตัวเลขใหม่/)
  const prompt = sent.contents[0].parts[0].text
  assert.match(prompt, /<question>ควรเพิ่มคนช่วงไหน<\/question>/)
  assert.ok(!prompt.includes('service-secret'))
  // ดึงตัวเลขด้วย JWT ของผู้ใช้ (RLS + has_role ในฐานข้อมูล)
  assert.equal(callsTo('/rpc/analytics_hourly')[0].headers.authorization, 'Bearer tok-owner')
})

test('ai: ไม่มีออเดอร์ -> ไม่เรียก Gemini', async () => {
  analyticsHandlers(0)
  const r = await req('/api/ai/summary', { token: 'tok-owner', body: { restaurant_id: RID } })
  const b = await body(r)
  assert.equal(b.ai, false)
  assert.equal(callsTo('generativelanguage').length, 0)
})

test('ai: ไม่ได้ตั้ง API key -> 503', async () => {
  const r = await req('/api/ai/summary', { token: 'tok-owner', body: { restaurant_id: RID } }, { ...baseEnv, GEMINI_API_KEY: undefined })
  assert.equal(r.status, 503)
})

test('ai: Gemini ล่ม -> 502 แต่ยังคืนตัวเลขให้', async () => {
  analyticsHandlers()
  handlers.push((c) => (c.url.startsWith('https://generativelanguage.googleapis.com') ? json({ error: 'overloaded' }, 529) : undefined))
  const r = await req('/api/ai/summary', { token: 'tok-owner', body: { restaurant_id: RID } })
  assert.equal(r.status, 502)
  assert.equal((await body(r)).facts.orders, 30)
})

test('ai: ตรวจ days และความยาวคำถาม', async () => {
  assert.equal((await req('/api/ai/summary', { token: 'tok-owner', body: { restaurant_id: RID, days: 0 } })).status, 400)
  assert.equal((await req('/api/ai/summary', { token: 'tok-owner', body: { restaurant_id: RID, days: 121 } })).status, 400)
  assert.equal((await req('/api/ai/summary', { token: 'tok-owner', body: { restaurant_id: RID, question: 'ก'.repeat(501) } })).status, 400)
})

test('ai: จำกัด 6 ครั้งต่อนาทีต่อผู้ใช้', async () => {
  analyticsHandlers(0)
  const s: number[] = []
  for (let i = 0; i < 7; i++) s.push((await req('/api/ai/summary', { token: 'tok-owner', body: { restaurant_id: RID } })).status)
  assert.deepEqual(s, [200, 200, 200, 200, 200, 200, 429])
})

// ===== staff =====
test('staff: รายชื่อใช้ staff_list ผ่าน service role หลังตรวจว่าเป็นเจ้าของ', async () => {
  handlers.push((c) => (c.url.endsWith('/rpc/staff_list') ? json([{ user_id: OWNER, email: 'o@x.com', role: 'owner' }]) : undefined))
  const r = await req('/api/staff?restaurant_id=' + RID, { token: 'tok-owner' })
  assert.equal((await body(r)).staff[0].email, 'o@x.com')
  assert.equal(callsTo('/rpc/staff_list')[0].headers.authorization, 'Bearer service-secret')
})

test('staff: เพิ่มผู้ใช้ที่มีอยู่แล้ว (insert ด้วย JWT เจ้าของ)', async () => {
  handlers.push((c) => (c.url.endsWith('/rpc/staff_find_user') ? json(NEWUSER) : undefined))
  handlers.push((c) => (c.method === 'POST' && c.url.endsWith('/rest/v1/staff_members') ? json([{}], 201) : undefined))
  const r = await req('/api/staff', { token: 'tok-owner', body: { restaurant_id: RID, email: ' New@X.com ', role: 'kitchen' } })
  assert.equal(r.status, 201)
  assert.deepEqual(await body(r), { user_id: NEWUSER, email: 'new@x.com', role: 'kitchen', invited: false })
  const ins = callsTo('/rest/v1/staff_members').find((c) => c.method === 'POST')!
  assert.equal(ins.headers.authorization, 'Bearer tok-owner')
  assert.deepEqual(ins.body, { user_id: NEWUSER, restaurant_id: RID, role: 'kitchen' })
  assert.equal(callsTo('/auth/v1/invite').length, 0)
})

test('staff: อีเมลใหม่ -> ส่งคำเชิญ แล้วเพิ่มเข้าร้าน', async () => {
  handlers.push((c) => (c.url.endsWith('/rpc/staff_find_user') ? json(null) : undefined))
  handlers.push((c) => (c.url.includes('/auth/v1/invite') ? json({ id: NEWUSER }) : undefined))
  handlers.push((c) => (c.method === 'POST' && c.url.endsWith('/rest/v1/staff_members') ? json([{}], 201) : undefined))
  const r = await req('/api/staff', {
    token: 'tok-owner',
    body: { restaurant_id: RID, email: 'new@x.com', role: 'staff' },
    headers: { origin: 'https://shop.example' },
  })
  assert.equal((await body(r)).invited, true)
  const inv = callsTo('/auth/v1/invite')[0]
  assert.equal(new URL(inv.url).searchParams.get('redirect_to'), 'https://shop.example/set-password')
  assert.equal(inv.headers.authorization, 'Bearer service-secret')
})

test('staff: อีเมลเชิญไม่พาไปโดเมนที่ไม่น่าเชื่อถือ', async () => {
  handlers.push((c) => (c.url.endsWith('/rpc/staff_find_user') ? json(null) : undefined))
  handlers.push((c) => (c.url.includes('/auth/v1/invite') ? json({ id: NEWUSER }) : undefined))
  handlers.push((c) => (c.method === 'POST' && c.url.endsWith('/rest/v1/staff_members') ? json([{}], 201) : undefined))
  await req('/api/staff', {
    token: 'tok-owner',
    body: { restaurant_id: RID, email: 'new@x.com', role: 'staff' },
    headers: { origin: 'https://evil.example' },
  })
  assert.equal(new URL(callsTo('/auth/v1/invite')[0].url).searchParams.get('redirect_to'), null)
})

test('staff: เป็นพนักงานร้านนี้อยู่แล้ว -> 409', async () => {
  handlers.push((c) => (c.url.endsWith('/rpc/staff_find_user') ? json(NEWUSER) : undefined))
  handlers.push((c) => (c.method === 'POST' && c.url.endsWith('/rest/v1/staff_members') ? json({ code: '23505', message: 'dup' }, 409) : undefined))
  const r = await req('/api/staff', { token: 'tok-owner', body: { restaurant_id: RID, email: 'a@b.co', role: 'staff' } })
  assert.equal(r.status, 409)
})

test('staff: ตรวจอีเมลและบทบาท', async () => {
  assert.equal((await req('/api/staff', { token: 'tok-owner', body: { restaurant_id: RID, email: 'nope', role: 'staff' } })).status, 400)
  assert.equal((await req('/api/staff', { token: 'tok-owner', body: { restaurant_id: RID, email: 'a@b.co', role: 'admin' } })).status, 400)
})

test('staff: เปลี่ยนบทบาทเจ้าของคนสุดท้าย -> 409 last_owner', async () => {
  handlers.push((c) => (c.method === 'PATCH' ? json({ code: 'P0001', message: 'last_owner' }, 400) : undefined))
  const r = await req(`/api/staff/${OWNER}`, { token: 'tok-owner', method: 'PATCH', body: { restaurant_id: RID, role: 'staff' } })
  assert.equal(r.status, 409)
  assert.equal((await body(r)).error, 'last_owner')
})

test('staff: ลบพนักงาน / ไม่พบ -> 404', async () => {
  handlers.push((c) => (c.method === 'DELETE' ? json(c.url.includes(KITCHEN) ? [{}] : []) : undefined))
  assert.equal((await req(`/api/staff/${KITCHEN}?restaurant_id=${RID}`, { token: 'tok-owner', method: 'DELETE' })).status, 200)
  assert.equal((await req(`/api/staff/${NEWUSER}?restaurant_id=${RID}`, { token: 'tok-owner', method: 'DELETE' })).status, 404)
})

test('ไม่มี endpoint สั่งอาหารของลูกค้าแล้ว (พนักงานรับออเดอร์ผ่าน Supabase)', async () => {
  const r = await req('/api/orders', { body: { table_id: RID, items: [] } })
  assert.equal(r.status, 404)
  assert.equal(calls.length, 0)
})

// ===== ผู้จัดการ =====
test('manager: ดูรายชื่อพนักงานได้', async () => {
  handlers.push((c) => (c.url.endsWith('/rpc/staff_list') ? json([]) : undefined))
  assert.equal((await req('/api/staff?restaurant_id=' + RID, { token: 'tok-manager' })).status, 200)
})

test('manager: เพิ่มพนักงานครัวได้', async () => {
  handlers.push((c) => (c.url.endsWith('/rpc/staff_find_user') ? json(NEWUSER) : undefined))
  handlers.push((c) => (c.method === 'POST' && c.url.endsWith('/rest/v1/staff_members') ? json([{}], 201) : undefined))
  const r = await req('/api/staff', { token: 'tok-manager', body: { restaurant_id: RID, email: 'cook@x.com', role: 'kitchen' } })
  assert.equal(r.status, 201)
  assert.equal(callsTo('/rest/v1/staff_members').find((c) => c.method === 'POST')!.headers.authorization, 'Bearer tok-manager')
})

test('manager: แต่งตั้งเจ้าของ/ผู้จัดการไม่ได้ (ไม่แตะฐานข้อมูล)', async () => {
  for (const role of ['owner', 'manager']) {
    const r = await req('/api/staff', { token: 'tok-manager', body: { restaurant_id: RID, email: 'a@b.co', role } })
    assert.equal(r.status, 403)
    assert.equal((await body(r)).error, 'role_not_allowed')
    const p = await req(`/api/staff/${KITCHEN}`, { token: 'tok-manager', method: 'PATCH', body: { restaurant_id: RID, role } })
    assert.equal(p.status, 403)
  }
  assert.equal(callsTo('staff_find_user').length + calls.filter((c) => c.method !== 'GET').length, 0)
})

test('owner: แต่งตั้งผู้จัดการได้', async () => {
  handlers.push((c) => (c.method === 'PATCH' ? json([{}]) : undefined))
  const r = await req(`/api/staff/${KITCHEN}`, { token: 'tok-owner', method: 'PATCH', body: { restaurant_id: RID, role: 'manager' } })
  assert.equal(r.status, 200)
})

test('manager: นำเข้า CSV และย้อนการนำเข้าได้', async () => {
  handlers.push((c) => (c.url.endsWith('/rpc/import_sales_history') ? json({ orders: 1 }) : undefined))
  handlers.push((c) => (c.method === 'DELETE' ? json([{ id: 'a' }]) : undefined))
  assert.equal((await req('/api/import/sales', { token: 'tok-manager', body: { restaurant_id: RID, csv: CSV } })).status, 200)
  assert.equal((await req(`/api/import/${NEWUSER}?restaurant_id=${RID}`, { token: 'tok-manager', method: 'DELETE' })).status, 200)
})

test('manager: ใช้ AI วิเคราะห์ไม่ได้ (นอกขอบเขต)', async () => {
  assert.equal((await req('/api/ai/summary', { token: 'tok-manager', body: { restaurant_id: RID } })).status, 403)
})

test('ฐานข้อมูลปฏิเสธด้วย RLS (42501) -> 403', async () => {
  handlers.push((c) => (c.url.endsWith('/rpc/staff_find_user') ? json(NEWUSER) : undefined))
  handlers.push((c) => (c.method === 'POST' && c.url.endsWith('/rest/v1/staff_members') ? json({ code: '42501', message: 'new row violates row-level security policy' }, 403) : undefined))
  const r = await req('/api/staff', { token: 'tok-manager', body: { restaurant_id: RID, email: 'a@b.co', role: 'staff' } })
  assert.equal(r.status, 403)
  assert.deepEqual(await body(r), { error: 'forbidden' })
})

test('ไม่พบเส้นทาง -> 404 JSON', async () => {
  const r = await req('/api/nothing')
  assert.equal(r.status, 404)
  assert.deepEqual(await body(r), { error: 'not_found' })
})

// ===== แนะนำโปร (0018) =====
const INSIGHTS = {
  days: 28,
  hours: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((h) => ({
    hour: h,
    orders_per_day: [12, 13, 18, 19, 20].includes(h) ? 10 : [14, 15, 16].includes(h) ? 1 : 5,
    revenue: 1000,
  })),
  items: [
    { id: 'c', name: 'ต้มยำ', price: 120, unit_cost: 50, has_recipe: true, quantity: 10, revenue: 1200, is_available: true },
    { id: 'a', name: 'กะเพรา', price: 60, unit_cost: 20, has_recipe: true, quantity: 300, revenue: 18000, is_available: true },
    { id: 'b', name: 'ข้าวผัด', price: 70, unit_cost: 25, has_recipe: true, quantity: 200, revenue: 14000, is_available: true },
  ],
  active_promotions: [],
}
const gemini = (text: string) => json({ candidates: [{ content: { parts: [{ text }] } }] })

test('แนะนำโปร: ได้คำแนะนำจากกติกาเสมอ ไม่เรียก AI ถ้าไม่ขอ', async () => {
  handlers.push((c) => (c.url.endsWith('/rpc/promo_insights') ? json(INSIGHTS) : undefined))
  const r = await req('/api/ai/promo-suggestions', { token: 'tok-manager', body: { restaurant_id: RID } })
  assert.equal(r.status, 200)
  const b = await body(r)
  assert.ok(b.rules.length >= 2)
  assert.deepEqual(b.ai, [])
  assert.equal(callsTo('generativelanguage').length, 0)
  assert.equal(callsTo('/rpc/promo_insights')[0].headers.authorization, 'Bearer tok-manager')
})

test('แนะนำโปร: ผลจาก AI ที่ขาดทุน/เมนูไม่มีจริง ถูกตัดทิ้ง', async () => {
  handlers.push((c) => (c.url.endsWith('/rpc/promo_insights') ? json(INSIGHTS) : undefined))
  handlers.push((c) =>
    c.url.includes('generativelanguage')
      ? gemini(
          JSON.stringify({
            suggestions: [
              { title: 'ต้มยำลด 15%', reason: 'ขายช้า', promo: { name: 'ต้มยำลด 15%', discount_type: 'percent', value: 15, item_ids: ['c'] } },
              { title: 'ขาดทุน', reason: '', promo: { name: 'กะเพราลด 80%', discount_type: 'percent', value: 80, item_ids: ['a'] } },
              { title: 'ผี', reason: '', promo: { name: 'เมนูผี', discount_type: 'percent', value: 10, item_ids: ['zzz'] } },
            ],
          }),
        )
      : undefined,
  )
  const b = await body(await req('/api/ai/promo-suggestions', { token: 'tok-owner', body: { restaurant_id: RID, ai: true } }))
  assert.deepEqual(
    b.ai.map((s: { promo: { name: string } }) => s.promo.name),
    ['ต้มยำลด 15%'],
  )
  assert.equal(b.ai[0].source, 'ai')
})

test('แนะนำโปร: AI ตอบไม่ใช่ JSON -> ยังได้คำแนะนำจากกติกา', async () => {
  handlers.push((c) => (c.url.endsWith('/rpc/promo_insights') ? json(INSIGHTS) : undefined))
  handlers.push((c) => (c.url.includes('generativelanguage') ? gemini('ขอโทษค่ะ') : undefined))
  const r = await req('/api/ai/promo-suggestions', { token: 'tok-owner', body: { restaurant_id: RID, ai: true } })
  const b = await body(r)
  assert.equal(r.status, 200)
  assert.ok(b.rules.length > 0)
  assert.ok(b.ai_error)
})

test('แนะนำโปร: ครัวใช้ไม่ได้ / days ผิด', async () => {
  assert.equal((await req('/api/ai/promo-suggestions', { token: 'tok-kitchen', body: { restaurant_id: RID } })).status, 403)
  assert.equal((await req('/api/ai/promo-suggestions', { token: 'tok-owner', body: { restaurant_id: RID, days: 3 } })).status, 400)
})

// ===== รายงานรายวันทาง LINE (0018) =====
const REPORT = {
  restaurant: 'ร้านทดสอบ',
  date: '2026-10-23',
  orders: 2,
  revenue: 300,
  discount: 0,
  revenue_last_week: 0,
  cancelled: 0,
  payments: { cash: 300 },
  top_items: [{ name: 'กะเพรา', quantity: 3, amount: 180 }],
  peak_hour: 12,
  waste: [],
  expenses: 0,
  new_members: 0,
  points_earned: 0,
  points_redeemed: 0,
}
const LINE_TO = 'U' + '0'.repeat(32)
const lineEnv: Env = { ...baseEnv, LINE_CHANNEL_ACCESS_TOKEN: 'line-secret' }

test('รายงาน: ส่งเข้า LINE ด้วย token ของร้าน และข้อความสรุป', async () => {
  handlers.push((c) => (c.url.includes('/rest/v1/shop_settings') ? json([{ line_to: LINE_TO }]) : undefined))
  handlers.push((c) => (c.url.endsWith('/rpc/daily_report') ? json(REPORT) : undefined))
  handlers.push((c) => (c.url === 'https://api.line.me/v2/bot/message/push' ? json({}) : undefined))
  const r = await req('/api/reports/daily/send', { token: 'tok-manager', body: { restaurant_id: RID } }, lineEnv)
  assert.equal(r.status, 200)
  const push = callsTo('api.line.me')[0]
  assert.equal(push.headers.authorization, 'Bearer line-secret')
  const sent = push.body as { to: string; messages: { text: string }[] }
  assert.equal(sent.to, LINE_TO)
  assert.match(sent.messages[0].text, /ร้านทดสอบ[\s\S]*฿300 \(2 บิล\)[\s\S]*กะเพรา 3 ที่/)
  assert.equal(callsTo('/rpc/daily_report')[0].headers.authorization, 'Bearer tok-manager')
})

test('รายงาน: ยังไม่ตั้ง token -> 503 · ยังไม่ตั้งผู้รับ -> 400 · LINE ปฏิเสธ -> 502', async () => {
  assert.equal((await req('/api/reports/daily/send', { token: 'tok-owner', body: { restaurant_id: RID } })).status, 503)
  handlers.push((c) => (c.url.includes('/rest/v1/shop_settings') ? json([{ line_to: null }]) : undefined))
  assert.equal((await req('/api/reports/daily/send', { token: 'tok-owner', body: { restaurant_id: RID } }, lineEnv)).status, 400)
  handlers = []
  handlers.push((c) => (c.url.includes('/rest/v1/shop_settings') ? json([{ line_to: LINE_TO }]) : undefined))
  handlers.push((c) => (c.url.endsWith('/rpc/daily_report') ? json(REPORT) : undefined))
  handlers.push((c) => (c.url.includes('api.line.me') ? json({ message: 'bad' }, 401) : undefined))
  const r = await req('/api/reports/daily/send', { token: 'tok-owner', body: { restaurant_id: RID } }, lineEnv)
  assert.equal(r.status, 502)
  assert.ok(!JSON.stringify(await body(r)).includes('line-secret'))
})

test('รายงาน: ครัวส่งไม่ได้ / วันที่ผิดรูปแบบ', async () => {
  assert.equal((await req('/api/reports/daily/send', { token: 'tok-kitchen', body: { restaurant_id: RID } }, lineEnv)).status, 403)
  assert.equal((await req('/api/reports/daily/send', { token: 'tok-owner', body: { restaurant_id: RID, date: 'x' } }, lineEnv)).status, 400)
})

test('รายงานอัตโนมัติ: ส่งเฉพาะร้านที่ถึง 22:00 ตามเวลาร้าน ด้วย service role', async () => {
  const R2 = '22222222-2222-4222-8222-222222222222'
  handlers.push((c) =>
    c.url.endsWith('/rpc/daily_report_targets')
      ? json([
          { restaurant_id: RID, line_to: LINE_TO, local_date: '2026-10-23', local_hour: 22 },
          { restaurant_id: R2, line_to: LINE_TO, local_date: '2026-10-23', local_hour: 21 },
        ])
      : undefined,
  )
  handlers.push((c) => (c.url.endsWith('/rpc/daily_report_data') ? json(REPORT) : undefined))
  handlers.push((c) => (c.url.includes('api.line.me') ? json({}) : undefined))
  const r = await sendDueReports(lineEnv)
  assert.deepEqual(r, { sent: 1, failed: 0 })
  assert.equal(callsTo('/rpc/daily_report_data').length, 1)
  assert.deepEqual(callsTo('/rpc/daily_report_data')[0].body, { p_restaurant_id: RID, p_date: '2026-10-23' })
  assert.equal(callsTo('/rpc/daily_report_targets')[0].headers.authorization, 'Bearer service-secret')
})

test('รายงานอัตโนมัติ: ไม่ตั้ง token = ไม่ทำอะไร', async () => {
  assert.deepEqual(await sendDueReports(baseEnv), { sent: 0, failed: 0 })
  assert.equal(calls.length, 0)
})
