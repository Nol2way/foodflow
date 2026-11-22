import { test } from 'node:test'
import assert from 'node:assert/strict'
import { money, validDate } from '../src/validation.ts'
import { parseSales } from '../src/csv.ts'
import { selectAll } from '../src/accounting.ts'
import { reportHour, sendDueReports } from '../src/reports.ts'
import { createApp } from '../src/app.ts'
import { signJwt } from '../src/jwt.ts'
import { asService, type Db } from '../src/supabase.ts'
import type { Env } from '../src/env.ts'

const env: Env = { SUPABASE_URL: 'https://db.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', SUPABASE_JWT_SECRET: 'test' }
const id = '11111111-1111-4111-8111-111111111111'
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })
const token = (scope = 'full') => signJwt({ sub: id, role: 'authenticated', aud: 'authenticated', iat: 1, exp: 9999999999, credential_version: 2, scope }, 'test')

test('money rejects coercions, excess precision and nonfinite values; dates round trip', () => {
  for (const value of [true, [], '12', null, NaN, Infinity, 0.001, 100000001]) assert.throws(() => money(value))
  assert.equal(money(12.34), 12.34)
  assert.equal(validDate('2026-02-30'), false)
  assert.equal(validDate('2024-02-29'), true)
  assert.equal(reportHour({ ...env, REPORT_HOUR: '' }), 22)
})

test('CSV rejects malformed quoting, comma grouping and overlong bill identities', () => {
  const head = 'datetime,ref,item,qty,price\n'
  for (const row of ['2026-01-01 12:00,A,item,1,"1,2"', '2026-01-01 12:00,A,it"em,1,2', '2026-01-01 12:00,A,"item,1,2', `2026-01-01 12:00,${'a'.repeat(101)},item,1,2`]) assert.ok(parseSales(head + row).errors.length)
  assert.equal(parseSales(head + '2026-01-01 12:00,A,item,1,"1,234.56"').rows[0].price, '1234.56')
})

test('pagination continues below requested provider cap, fails explicitly at bounded maximum', async () => {
  const all = [1, 2, 3, 4, 5]
  const db = { select: async (path: string) => { const offset = Number(new URL('https://db.test/' + path).searchParams.get('offset')); return all.slice(offset, offset + 2) } } as unknown as Db
  assert.deepEqual(await selectAll(db, 'rows?order=id', 1000), all)
  await assert.rejects(selectAll(db, 'rows?order=id', 1000, 4), /export_too_large/)
})

test('first-login token cannot reach tenant data; invalid JSON never writes profile', async () => {
  const calls: string[] = []
  globalThis.fetch = async (input) => { calls.push(String(input)); return json(true) }
  const app = createApp()
  const first = await app.request('/api/staff?restaurant_id=' + id, { headers: { Authorization: 'Bearer ' + await token('password_change') } }, env)
  assert.equal(first.status, 403)
  for (const body of ['{', 'null', '[]']) {
    const r = await app.request('/api/auth/me', { method: 'PATCH', headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json' }, body }, env)
    assert.equal(r.status, 400)
  }
  assert.equal(calls.some(x => x.includes('app_update_profile')), false)
})

test('profile PATCH marks only supplied fields; epoch validation is mandatory', async () => {
  let saved: Record<string, unknown> = {}
  globalThis.fetch = async (input, init) => {
    const path = String(input)
    if (path.endsWith('app_update_profile')) saved = JSON.parse(String(init?.body))
    return json(path.endsWith('app_user_profile') ? [{ id }] : true)
  }
  const app = createApp()
  const r = await app.request('/api/auth/me', { method: 'PATCH', headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json' }, body: JSON.stringify({ display_name: 'Updated' }) }, env)
  assert.equal(r.status, 200)
  assert.equal(saved.p_set_phone, false)
  assert.equal(saved.p_set_display_name, true)
  globalThis.fetch = async () => json(false)
  assert.equal((await app.request('/api/auth/me', { headers: { Authorization: 'Bearer ' + await token() } }, env)).status, 401)
})

test('HTML outage and transport timeout have sanitized typed dependency failures', async () => {
  globalThis.fetch = async () => new Response('<html>outage</html>', { status: 503 })
  await assert.rejects(asService(env).select('x'), { status: 502, message: 'invalid_upstream_response' })
  globalThis.fetch = async () => { throw new DOMException('private endpoint', 'TimeoutError') }
  await assert.rejects(asService(env).select('x'), { status: 504, message: 'upstream_unavailable' })
})

test('committed day close survives settings-read failure', async () => {
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('app_session_valid')) return json(true)
    if (url.includes('staff_members?')) return json([{ role: 'owner' }])
    if (url.endsWith('acct_close_day')) return json({ id, close_date: '2026-11-22' })
    if (url.endsWith('day_close_dispatch_claim')) return json(id)
    if (url.endsWith('day_close_dispatch_finish')) return json(null)
    return new Response('outage', { status: 503 })
  }
  const r = await createApp().request('/api/accounting/day-close', { method: 'POST', headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json' }, body: JSON.stringify({ restaurant_id: id, date: '2026-11-22', counted_cash: 10 }) }, { ...env, LINE_CHANNEL_ACCESS_TOKEN: 'line' })
  assert.equal(r.status, 201)
  assert.deepEqual(await r.json(), { close: { id, close_date: '2026-11-22' }, line: 'failed' })
})

test('scheduler uses event time, previous date at midnight and durable retry identity', async () => {
  let sent = false
  let pushes = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    const b = JSON.parse(String(init?.body ?? '{}'))
    if (url.endsWith('daily_report_targets')) {
      assert.equal(b.p_scheduled_at, '2026-11-21T17:00:00.000Z')
      return json([{ restaurant_id: id, local_date: '2026-11-22', local_hour: 0, line_to: 'U1' }])
    }
    if (url.endsWith('report_dispatch_claim')) { assert.equal(b.p_report_date, '2026-11-21'); return json(sent ? null : id) }
    if (url.endsWith('report_dispatch_pending')) return json([])
    if (url.endsWith('daily_report_data')) return json({ restaurant: 'shop', date: '2026-11-21', orders: 0, revenue: 0, discount: 0, revenue_last_week: 0, cancelled: 0, payments: {}, top_items: [], peak_hour: null, waste: [], expenses: 0, new_members: 0, points_earned: 0, points_redeemed: 0 })
    if (url.endsWith('report_dispatch_finish')) { sent = b.p_success; return json(null) }
    assert.equal(new Headers(init?.headers).get('X-Line-Retry-Key'), id)
    pushes++
    return json({})
  }
  const cfg = { ...env, LINE_CHANNEL_ACCESS_TOKEN: 'line', REPORT_HOUR: '0' }
  const time = Date.parse('2026-11-21T17:00:00Z')
  assert.deepEqual(await sendDueReports(cfg, time), { sent: 1, failed: 0 })
  assert.deepEqual(await sendDueReports(cfg, time), { sent: 0, failed: 0 })
  assert.equal(pushes, 1)
})
