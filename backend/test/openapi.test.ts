// เอกสาร Swagger ต้องตรงกับ route จริง และไฟล์ docs/openapi.json ต้องเป็นเวอร์ชันล่าสุด
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createApp } from '../src/app.ts'
import { openapi } from '../src/openapi.ts'

const app = createApp()
const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' }

test('ทุก route ใน app มีเอกสาร และเอกสารไม่มี route ที่ไม่มีจริง', () => {
  const real = new Set(
    app.routes
      .filter((r) => r.method !== 'ALL')
      .map((r) => `${r.method.toLowerCase()} ${r.path.replace(/:(\w+)/g, '{$1}')}`),
  )
  const documented = new Set(
    Object.entries(openapi.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m} ${p}`)),
  )
  // ชื่อพารามิเตอร์ใน path อาจต่างกัน (เช่น :userId กับ {user_id}) เทียบเฉพาะรูปทรง
  const shape = (s: string) => s.replace(/\{\w+\}/g, '{}')
  assert.deepEqual([...real].map(shape).sort(), [...documented].map(shape).sort())
})

test('ทุก endpoint ที่ต้องล็อกอินมี security bearerAuth', () => {
  const secured = Object.entries(openapi.paths).flatMap(([p, ops]) =>
    Object.entries(ops)
      .filter(([, op]) => ((op as { security?: unknown[] }).security ?? []).length > 0)
      .map(([m]) => `${m} ${p}`),
  )
  assert.deepEqual(secured.sort(), [
    'delete /api/import/{batch_id}',
    'delete /api/staff/{user_id}',
    'get /api/staff',
    'patch /api/staff/{user_id}',
    'post /api/ai/promo-suggestions',
    'post /api/ai/summary',
    'post /api/import/sales',
    'post /api/reports/daily/send',
    'post /api/staff',
  ])
})

test('$ref ทุกตัวชี้ไปที่ schema ที่มีอยู่', () => {
  const refs = JSON.stringify(openapi).match(/#\/components\/schemas\/\w+/g) ?? []
  for (const r of refs) assert.ok(r.split('/').pop()! in openapi.components.schemas, r)
})

test('GET /api/openapi.json และ /api/docs', async () => {
  const j = await app.request('/api/openapi.json', {}, env)
  assert.equal(j.status, 200)
  assert.equal(((await j.json()) as { openapi: string }).openapi, '3.1.0')
  const h = await app.request('/api/docs', {}, env)
  assert.equal(h.status, 200)
  assert.match(h.headers.get('content-type') ?? '', /text\/html/)
  const html = await h.text()
  assert.match(html, /swagger-ui-dist@\d+\.\d+\.\d+/)
  assert.match(html, /url: '\.\/openapi\.json'/)
})

test('docs/openapi.json ตรงกับโค้ดล่าสุด (ถ้าไม่ตรง ให้รัน npm run openapi)', () => {
  const file = JSON.parse(readFileSync(new URL('../../docs/openapi.json', import.meta.url), 'utf8'))
  assert.deepEqual(file, JSON.parse(JSON.stringify(openapi)))
})
