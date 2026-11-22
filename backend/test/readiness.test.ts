import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/app.ts'
import { REQUIRED_COLUMNS, REQUIRED_RPCS, checkSchemaReadiness } from '../src/readiness.ts'
import type { Env } from '../src/env.ts'
// @ts-expect-error Node deployment script shares the same runtime contract.
import { schemaPreflight } from '../../scripts/schema-preflight.mjs'

const env: Env = { SUPABASE_URL: 'https://db.example', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', SUPABASE_JWT_SECRET: 'secret' }
function schema() {
  return { swagger: '2.0', definitions: Object.fromEntries(Object.entries(REQUIRED_COLUMNS).map(([table, columns]) => [table, { properties: Object.fromEntries(columns.map(column => [column, {}])) }])),
    paths: Object.fromEntries(Object.entries(REQUIRED_RPCS).map(([name, args]) => [`/rpc/${name}`, { post: { parameters: [{ in: 'body', schema: { properties: Object.fromEntries(args.map(arg => [arg, {}])) } }] } }])) }
}

test('readiness checks metadata and a zero-row HEAD probe, never business records', async () => {
  const calls: string[] = []
  globalThis.fetch = async (url, init) => { calls.push(String(url)); assert.equal(init?.method, calls.length === 1 ? 'GET' : 'HEAD'); return Response.json(schema()) }
  assert.deepEqual(await checkSchemaReadiness(env), { ok: true, ready: true, schema_version: '0011' })
  assert.deepEqual(calls, ['https://db.example/rest/v1/', 'https://db.example/rest/v1/order_items?select=options_snapshot&limit=0'])
})

test('old schema, missing RPC and missing new RPC argument fail compatibility', async () => {
  const mutations = [
    (s: ReturnType<typeof schema>) => { delete s.definitions.order_items.properties.options_snapshot },
    (s: ReturnType<typeof schema>) => { delete s.paths['/rpc/app_session_valid'] },
    (s: ReturnType<typeof schema>) => { delete s.paths['/rpc/tax_doc_create'].post.parameters[0].schema.properties.p_client_ref },
  ]
  for (const mutate of mutations) {
    const s = schema(); mutate(s)
    globalThis.fetch = async () => Response.json(s)
    const r = await createApp().request('/api/readyz', {}, env)
    assert.equal(r.status, 503)
    assert.deepEqual(await r.json(), { ok: false, ready: false, error: 'schema_not_ready', required_schema: '0011' })
  }
})

test('outage, auth misconfiguration and unavailable metadata stay distinct and sanitized', async () => {
  for (const [status, payload, expected] of [[503, '<html>private outage</html>', 'database_unavailable'], [401, 'secret provider body', 'database_access_denied'], [200, '{}', 'schema_metadata_unavailable']] as const) {
    globalThis.fetch = async () => new Response(payload, { status })
    const r = await createApp().request('/api/readyz', {}, env)
    assert.equal(r.status, 503)
    assert.equal((await r.json() as { error: string }).error, expected)
  }
  globalThis.fetch = async () => { throw new DOMException('private URL', 'TimeoutError') }
  assert.equal((await checkSchemaReadiness(env)).error, 'database_unavailable')
})

test('missing deployment configuration does not call the database', async () => {
  globalThis.fetch = async () => { throw new Error('must not call') }
  const r = await createApp().request('/api/readyz', {}, { ...env, SUPABASE_SERVICE_ROLE_KEY: '' })
  assert.equal(r.status, 503)
  assert.equal((await r.json() as { error: string }).error, 'database_not_configured')
})

test('deployment preflight shares readiness contract and fails closed without credentials', async () => {
  globalThis.fetch = async () => Response.json(schema())
  assert.equal((await schemaPreflight({ env })).ok, true)
  assert.equal((await schemaPreflight({ env: {} })).error, 'database_not_configured')
  const old = schema(); delete old.definitions.order_items.properties.options_snapshot
  globalThis.fetch = async () => Response.json(old)
  assert.equal((await schemaPreflight({ env })).error, 'schema_not_ready')
})

test('runtime schema errors return compatibility status without exposing SQL', async () => {
  globalThis.fetch = async () => Response.json({ code: '42703', message: 'column order_items_1.options_snapshot does not exist; private details' }, { status: 400 })
  const response = await createApp().request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'staff@example.com', password: 'password-test' }) }, env)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'schema_not_ready', required_schema: '0011' })
})

test('stale metadata cannot hide a missing column or a disconnected database', async () => {
  for (const [status, expected] of [[400, 'schema_not_ready'], [503, 'database_unavailable']] as const) {
    globalThis.fetch = async (_url, init) => init?.method === 'HEAD' ? new Response(null, { status }) : Response.json(schema())
    assert.equal((await checkSchemaReadiness(env)).error, expected)
  }
})

test('deployment command exits before build or publish when target credentials are absent', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/deploy.mjs', import.meta.url))], {
    env: { ...process.env, SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_ANON_KEY: '', SUPABASE_JWT_SECRET: '' }, encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /database_not_configured/)
  assert.match(result.stderr, /Deployment blocked/)
  assert.equal(result.stdout, '')
})
