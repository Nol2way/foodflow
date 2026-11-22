import { test } from 'node:test'
import assert from 'node:assert/strict'
import { utils, write } from 'xlsx'
import { xlsxCsv } from '../src/xlsx.ts'
import { parseSales } from '../src/csv.ts'
import { createApp } from '../src/app.ts'
import { signJwt } from '../src/jwt.ts'

const rid = '11111111-1111-4111-8111-111111111111'
const env = { SUPABASE_URL: 'https://db.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', SUPABASE_JWT_SECRET: 'secret' }
const jwt = await signJwt({ sub: rid, role: 'authenticated', aud: 'authenticated', iat: 1, exp: 9999999999, credential_version: 0 }, 'secret')
const json = (v: unknown) => new Response(JSON.stringify(v))
const request = (path: string, body: object, method = 'POST') => createApp().request('/api' + path, { method, body: JSON.stringify(body), headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' } }, env)

test('XLSX uses same sales parser and rejects formulas or multiple worksheets', () => {
  const book = utils.book_new()
  utils.book_append_sheet(book, utils.aoa_to_sheet([['datetime', 'ref', 'item', 'qty', 'price'], ['2026-11-01 12:00', '001', 'Rice', 2, 50]]), 'Sales')
  const encode = () => write(book, { type: 'base64', bookType: 'xlsx' }) as string
  const parsed = parseSales(xlsxCsv(encode()))
  assert.equal(parsed.errors.length, 0)
  assert.equal(parsed.rows[0].ref, '001')
  book.Sheets.Sales.E2.f = '1+1'
  assert.throws(() => xlsxCsv(encode()), /workbook_formulas_not_supported/)
  delete book.Sheets.Sales.E2.f
  utils.book_append_sheet(book, utils.aoa_to_sheet([['other']]), 'Other')
  assert.throws(() => xlsxCsv(encode()), /single_sheet_required/)
  assert.throws(() => xlsxCsv('not-base64'), /invalid_workbook/)
})

test('feedback validates rating/client reference before writes and drops personal fields', async () => {
  let saved: Record<string, unknown> | null = null
  globalThis.fetch = async (input, init) => {
    const path = String(input)
    if (path.endsWith('app_session_valid')) return json(true)
    if (path.includes('staff_members')) return json([{ role: 'staff' }])
    if (path.endsWith('submit_feedback')) { saved = JSON.parse(String(init?.body)); return json(rid) }
    throw new Error('Unexpected request')
  }
  assert.equal((await request('/feedback', { restaurant_id: rid, rating: true, client_ref: rid })).status, 400)
  assert.equal(saved, null)
  assert.equal((await request('/feedback', { restaurant_id: rid, rating: 5, client_ref: rid, name: 'Do not save', phone: '0812345678' })).status, 201)
  assert.deepEqual(saved, { p_restaurant_id: rid, p_rating: 5, p_client_ref: rid })
})

test('tax draft tenant mismatch never reaches mutation RPC', async () => {
  const writes: string[] = []
  globalThis.fetch = async input => {
    const path = String(input)
    if (path.endsWith('app_session_valid')) return json(true)
    if (path.includes('staff_members')) return json([{ role: 'owner' }])
    if (path.includes('tax_documents?')) return json([])
    writes.push(path)
    return json(null)
  }
  assert.equal((await request(`/tax/documents/${rid}`, { restaurant_id: rid, buyer_name: 'New' }, 'PATCH')).status, 404)
  assert.deepEqual(writes, [])
})
