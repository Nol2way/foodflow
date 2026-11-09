// ทดสอบเอกสารภาษี รายงานภาษี และกะแคชเชียร์ ด้วย fetch จำลอง (ไม่ต่อ Supabase จริง)
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.ts'
import { splitVat } from '../src/tax.ts'
import { zReport } from '../src/accounting.ts'
import { monthRange, pp30Summary, salesTaxReport, thaiDate, whtReport, type TaxDocRow } from '../src/csv.ts'
import { signJwt } from '../src/jwt.ts'
import type { Env } from '../src/env.ts'

const SB = 'https://proj.supabase.co'
const RID = '11111111-1111-4111-8111-111111111111'
const ORDER = '22222222-2222-4222-8222-222222222222'
const DOC = '55555555-5555-4555-8555-555555555555'
const SHIFT = '88888888-8888-4888-8888-888888888888'
const USERS: Record<string, string> = {
  owner: '33333333-3333-4333-8333-333333333333',
  accountant: '77777777-7777-4777-8777-777777777777',
  staff: '99999999-9999-4999-8999-999999999999',
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

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = []
let handlers: ((c: Call) => Response | undefined)[] = []
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  let body: unknown = init.body
  if (typeof body === 'string') body = JSON.parse(body)
  const call: Call = { url: String(input), method: init.method ?? 'GET', body }
  calls.push(call)
  for (const h of handlers) {
    const r = h(call)
    if (r) return r
  }
  const u = new URL(call.url)
  if (u.pathname === '/rest/v1/rpc/app_user_active') return json(true)
  if (u.pathname === '/rest/v1/staff_members') {
    const uid = u.searchParams.get('user_id')?.replace('eq.', '') ?? ''
    return json(ROLE[uid] ? [{ role: ROLE[uid] }] : [])
  }
  return json({ message: `unexpected ${call.method} ${call.url}` }, 599)
}) as typeof fetch

const app = createApp()
function req(path: string, opts: { body?: unknown; as?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.as) headers.authorization = `Bearer ${JWT[opts.as]}`
  return app.request(path, { method: opts.body ? 'POST' : 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }, env)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (r: Response): Promise<any> => r.json()
const callsTo = (part: string) => calls.filter((c) => c.url.includes(part))
const on = (part: string, res: (c: Call) => Response, method?: string) =>
  handlers.push((c) => (c.url.includes(part) && (!method || c.method === method) ? res(c) : undefined))
const dbError = (message: string) => json({ code: 'P0001', message }, 400)

beforeEach(() => {
  calls = []
  handlers = []
})

// ----- ฟังก์ชันล้วน -----
test('splitVat: ROUND(total * 7 / 107, 2)', () => {
  assert.deepEqual(splitVat(107), { taxable: 100, vat: 7 })
  assert.deepEqual(splitVat(100), { taxable: 93.46, vat: 6.54 })
  assert.deepEqual(splitVat(150, 50), { taxable: 93.46, vat: 6.54 })
})

test('monthRange / thaiDate', () => {
  assert.deepEqual(monthRange('2028-02'), { month: '2028-02', from: '2028-02-01', to: '2028-02-29', label: 'กุมภาพันธ์ 2571' })
  assert.equal(monthRange('2026-13'), null)
  assert.equal(thaiDate('2026-11-09'), '09/11/2569')
})

const doc = (o: Partial<TaxDocRow>): TaxDocRow => ({
  id: 'x', doc_type: 'ABB', doc_number: '', issue_date: '2026-11-01', terminal_code: 'POS01', ref_document_id: null,
  buyer_name: null, buyer_tax_id: null, buyer_branch_code: null, taxable_amount: 100, exempt_amount: 0, vat_amount: 7, total_amount: 107, ...o,
})

test('salesTaxReport: ABB รวมต่อวัน/เครื่อง · CN ติดลบ · TAX แทน ABB ไม่นับซ้ำ', () => {
  const docs = [
    doc({ id: 'a1', doc_number: 'ABB-POS01-202611-000001' }),
    doc({ id: 'a2', doc_number: 'ABB-POS01-202611-000002' }),
    doc({ id: 't1', doc_type: 'TAX', doc_number: 'TAX-POS01-202611-000001', ref_document_id: 'a2', buyer_name: 'บจก. ก', buyer_tax_id: '0105551234567', buyer_branch_code: '00000' }),
    doc({ id: 't2', doc_type: 'TAX', doc_number: 'TAX-POS01-202611-000002', issue_date: '2026-11-02', buyer_name: 'บจก. ข', buyer_tax_id: '0105551234567', buyer_branch_code: '00001', taxable_amount: 1000, vat_amount: 70, total_amount: 1070 }),
    doc({ id: 'c1', doc_type: 'CN', doc_number: 'CN-POS01-202611-000001', issue_date: '2026-11-03', ref_document_id: 't2', taxable_amount: 100, vat_amount: 7, total_amount: 107, credit_note_reason: 'คืนสินค้า' }),
  ]
  const refs = new Map(docs.map((d) => [d.id, { doc_number: d.doc_number, doc_type: d.doc_type }]))
  const r = salesTaxReport(docs, refs)
  assert.equal(r.rows.length, 4)
  assert.equal(r.rows[0].doc_number, 'ABB-POS01-202611-000001 - ABB-POS01-202611-000002')
  assert.equal(r.rows[0].vat, 14)
  assert.equal(r.rows[1].vat, 0)
  assert.match(r.rows[1].note, /ออกแทน/)
  assert.equal(r.rows[2].branch, 'สาขาที่ 00001')
  assert.equal(r.rows[3].total, -107)
  assert.deepEqual(r.totals, { taxable: 1100, exempt: 0, vat: 77, total: 1177 })
})

test('pp30Summary: ชำระ / ชำระเกิน', () => {
  assert.equal(pp30Summary({ taxable: 1000, exempt: 0, vat: 70, total: 1070 }, { value: 500, vat: 35 }).vat_payable, 35)
  const over = pp30Summary({ taxable: 100, exempt: 0, vat: 7, total: 107 }, { value: 500, vat: 35 })
  assert.deepEqual([over.vat_payable, over.vat_credit, over.net_vat], [0, 28, -28])
})

test('whtReport: ฐานก่อน VAT แยก ภ.ง.ด.3 / 53', () => {
  const r = whtReport([
    { spent_on: '2026-11-05', supplier_name: 'บจก. ค', supplier_tax_id: '0105551234567', supplier_branch_code: '00000', amount: 1070, vat_amount: 70, wht_rate: 3, wht_amount: 30, wht_type: 'pnd53', note: null, accounts: { name: 'ค่าบริการ' } },
    { spent_on: '2026-11-06', supplier_name: 'นาย ง', supplier_tax_id: '1101700230705', supplier_branch_code: null, amount: 5000, vat_amount: 0, wht_rate: 5, wht_amount: 250, wht_type: 'pnd3', note: 'ค่าเช่า' },
  ])
  assert.equal(r.rows[0].form, 'pnd3')
  assert.equal(r.rows[1].paid_amount, 1000)
  assert.deepEqual(r.summary, { pnd3: { count: 1, paid_amount: 5000, wht: 250 }, pnd53: { count: 1, paid_amount: 1000, wht: 30 }, total_wht: 280 })
})

test('zReport: ส่วนต่างเงินสด + ช่วงเลขที่ ABB + VAT สุทธิ', () => {
  const z = zReport(
    {
      shift: { id: SHIFT, cashier_name: 'แคชเชียร์', starting_cash: 1000, actual_cash: 2950, variance_cash: -50, opened_at: 'a', closed_at: 'b' },
      cash_sales: 2000, cash_in_total: 100, cash_out_total: 100, expected_cash: 3000,
      sales_by_method: { cash: { bills: 3, total: 2000 }, promptpay: { bills: 2, total: 500.5 } }, cancelled_after_paid: 1, drawer_logs: [],
    },
    [
      { doc_type: 'ABB', doc_number: 'ABB-1-000002', ref_document_id: null, vat_amount: 7, total_amount: 107 },
      { doc_type: 'ABB', doc_number: 'ABB-1-000001', ref_document_id: null, vat_amount: 7, total_amount: 107 },
      { doc_type: 'TAX', doc_number: 'TAX-1-000001', ref_document_id: 'abb', vat_amount: 7, total_amount: 107 },
    ],
  )
  assert.equal(z.cash_status, 'short')
  assert.equal(z.total_bills, 5)
  assert.equal(z.total_sales, 2500.5)
  assert.deepEqual(z.tax_documents.abb, { count: 2, first: 'ABB-1-000001', last: 'ABB-1-000002' })
  assert.equal(z.tax_documents.vat_total, 14)
})

// ----- route -----
const CONFIRMED = { id: DOC, doc_type: 'ABB', doc_number: 'ABB-POS01-202611-000001', status: 'confirmed', xml_payload: '<?xml version="1.0"?><x/>' }

test('POST /tax/documents: สร้างร่างด้วย JWT ผู้ใช้ · ครัว 403 · CN ต้องมี ref', async () => {
  on('/rpc/tax_doc_create', () => json(DOC))
  on('/rest/v1/tax_documents?', () => json([{ id: DOC, status: 'draft' }]))
  const r = await req('/api/tax/documents', { as: 'staff', body: { restaurant_id: RID, doc_type: 'abb', order_id: ORDER } })
  assert.equal(r.status, 201)
  assert.equal((await body(r)).document.status, 'draft')
  const call = callsTo('/rpc/tax_doc_create')[0]
  assert.equal((call.body as { p_doc_type: string }).p_doc_type, 'ABB')
  assert.equal((await req('/api/tax/documents', { as: 'kitchen', body: { restaurant_id: RID, doc_type: 'ABB', order_id: ORDER } })).status, 403)
  assert.equal((await req('/api/tax/documents', { as: 'staff', body: { restaurant_id: RID, doc_type: 'CN', ref_document_id: DOC } })).status, 403)
  assert.equal((await req('/api/tax/documents', { as: 'owner', body: { restaurant_id: RID, doc_type: 'CN', order_id: ORDER } })).status, 400)
})

test('POST /tax/documents confirm=true: ยืนยันทันที ไม่คืน XML ใน JSON · ยืนยันไม่ผ่านคืน document_id', async () => {
  on('/rpc/tax_doc_create', () => json(DOC))
  on('/rpc/tax_doc_confirm', () => json(CONFIRMED))
  const r = await req('/api/tax/documents', { as: 'owner', body: { restaurant_id: RID, doc_type: 'ABB', order_id: ORDER, confirm: true, terminal_code: 'pos01' } })
  const b = await body(r)
  assert.equal(r.status, 201)
  assert.equal(b.document.doc_number, CONFIRMED.doc_number)
  assert.equal(b.document.xml_payload, undefined)
  assert.equal(b.document.has_xml, true)
  assert.equal((callsTo('/rpc/tax_doc_confirm')[0].body as { p_terminal_code: string }).p_terminal_code, 'POS01')

  handlers = []
  on('/rpc/tax_doc_create', () => json(DOC))
  on('/rpc/tax_doc_confirm', () => dbError('pos_not_registered'))
  const f = await req('/api/tax/documents', { as: 'owner', body: { restaurant_id: RID, doc_type: 'ABB', order_id: ORDER, confirm: true, terminal_code: 'POS01' } })
  const fb = await body(f)
  assert.equal(f.status, 400)
  assert.deepEqual([fb.error, fb.document_id, fb.status], ['pos_not_registered', DOC, 'draft'])
})

test('POST /tax/documents/:id/confirm: ข้อผิดพลาดฐานข้อมูลเป็นภาษาไทย (not_draft = 409)', async () => {
  on('/rest/v1/tax_documents?select=id', () => json([{ id: DOC }]))
  on('/rpc/tax_doc_confirm', () => dbError('not_draft'))
  const r = await req(`/api/tax/documents/${DOC}/confirm`, { as: 'owner', body: { restaurant_id: RID, terminal_code: 'POS01' } })
  assert.equal(r.status, 409)
  assert.equal((await body(r)).message, 'เอกสารนี้ไม่ใช่ฉบับร่าง')
  assert.equal((await req(`/api/tax/documents/${DOC}/confirm`, { as: 'owner', body: { restaurant_id: RID } })).status, 400)
})

test('GET /tax/documents/:id/xml: ดาวน์โหลดไฟล์ · ร่าง 409', async () => {
  on('/rest/v1/tax_documents?select=doc_number', () => json([CONFIRMED]))
  const r = await req(`/api/tax/documents/${DOC}/xml?restaurant_id=${RID}`, { as: 'accountant' })
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type') ?? '', /application\/xml/)
  assert.match(r.headers.get('content-disposition') ?? '', /ABB-POS01-202611-000001\.xml/)
  assert.equal(await r.text(), CONFIRMED.xml_payload)
  handlers = []
  on('/rest/v1/tax_documents?select=doc_number', () => json([{ doc_number: null, status: 'draft', xml_payload: null }]))
  assert.equal((await req(`/api/tax/documents/${DOC}/xml?restaurant_id=${RID}`, { as: 'accountant' })).status, 409)
})

test('GET /accounting/reports/sales-tax: JSON + CSV (BOM, หัวผู้ประกอบการ) · month ผิด 400 · พนักงาน 403', async () => {
  on('/rest/v1/tax_settings', () => json([{ company_name: 'บจก. ร้านอาหาร', tax_id: '0105551234567', branch_code: '00000', registered_address: 'กรุงเทพฯ' }]))
  on('/rest/v1/tax_documents?select=id,doc_type', () => json([doc({ id: 'a1', doc_number: 'ABB-POS01-202611-000001' })]))
  const r = await req(`/api/accounting/reports/sales-tax?restaurant_id=${RID}&month=2026-11`, { as: 'accountant' })
  const b = await body(r)
  assert.equal(r.status, 200)
  assert.equal(b.totals.vat, 7)
  assert.match(callsTo('/rest/v1/tax_documents?')[0].url, /status=eq\.confirmed&issue_date=gte\.2026-11-01&issue_date=lte\.2026-11-30/)
  const bytes = new Uint8Array(await (await req(`/api/accounting/reports/sales-tax?restaurant_id=${RID}&month=2026-11&format=csv`, { as: 'accountant' })).arrayBuffer())
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]) // UTF-8 BOM (text() ตัดทิ้งตอนถอดรหัส)
  const csv = new TextDecoder().decode(bytes)
  assert.ok(csv.startsWith('รายงานภาษีขาย'))
  assert.match(csv, /0105551234567/)
  assert.match(csv, /พฤศจิกายน 2569/)
  assert.equal((await req(`/api/accounting/reports/sales-tax?restaurant_id=${RID}&month=2026-1`, { as: 'accountant' })).status, 400)
  assert.equal((await req(`/api/accounting/reports/sales-tax?restaurant_id=${RID}&month=2026-11`, { as: 'staff' })).status, 403)
})

test('GET /accounting/reports/pp30-summary: ภาษีขาย - ภาษีซื้อ + เตือนรายจ่ายไม่มีใบกำกับ', async () => {
  on('/rest/v1/tax_settings', () => json([]))
  on('/rest/v1/tax_documents', () => json([doc({ id: 't', doc_type: 'TAX', doc_number: 'TAX-1', taxable_amount: 1000, vat_amount: 70, total_amount: 1070 })]))
  on('tax_invoice_no=not.is.null', () => json([{ tax_invoice_date: '2026-11-02', tax_invoice_no: 'IV1', supplier_name: 'ผู้ขาย', supplier_tax_id: '0105551234567', supplier_branch_code: '00000', amount: 535, vat_amount: 35, spent_on: '2026-11-02' }]))
  on('tax_invoice_no=is.null', () => json([{ vat_amount: 7 }]))
  const b = await body(await req(`/api/accounting/reports/pp30-summary?restaurant_id=${RID}&month=2026-11`, { as: 'owner' }))
  assert.deepEqual([b.summary.output_vat, b.summary.input_vat, b.summary.vat_payable], [70, 35, 35])
  assert.deepEqual(b.purchases_without_invoice, { count: 1, vat: 7 })
})

test('GET /accounting/reports/wht: กรองแบบ + type ผิด 400', async () => {
  on('/rest/v1/tax_settings', () => json([]))
  on('/rest/v1/expenses', () => json([]))
  assert.equal((await req(`/api/accounting/reports/wht?restaurant_id=${RID}&month=2026-11&type=pnd53`, { as: 'owner' })).status, 200)
  assert.match(callsTo('/rest/v1/expenses')[0].url, /wht_type=eq\.pnd53/)
  assert.equal((await req(`/api/accounting/reports/wht?restaurant_id=${RID}&month=2026-11&type=pnd1`, { as: 'owner' })).status, 400)
})

test('shifts: เปิด / เงินออก / ปิด + Z-Report · ครัว 403 · กะซ้ำ 409', async () => {
  on('/rpc/shift_open', () => json({ id: SHIFT, status: 'open' }))
  const o = await req('/api/shifts/open', { as: 'staff', body: { restaurant_id: RID, starting_cash: 1000 } })
  assert.equal(o.status, 201)
  assert.equal((await req('/api/shifts/open', { as: 'kitchen', body: { restaurant_id: RID, starting_cash: 1000 } })).status, 403)
  assert.equal((await req('/api/shifts/open', { as: 'staff', body: { restaurant_id: RID } })).status, 400)

  on('/rest/v1/cashier_shifts', () => json([{ id: SHIFT }]))
  on('/rpc/shift_cash_log', () => json({ id: 'l1' }))
  assert.equal((await req('/api/shifts/cash-movement', { as: 'staff', body: { restaurant_id: RID, shift_id: SHIFT, type: 'cash_out', amount: 100, reason: 'ซื้อน้ำแข็ง' } })).status, 201)
  assert.equal((await req('/api/shifts/cash-movement', { as: 'staff', body: { restaurant_id: RID, shift_id: SHIFT, type: 'cash_out', amount: 100 } })).status, 400)

  const closed = { id: SHIFT, terminal_id: null, cashier_id: USERS.staff, cashier_name: 'staff', status: 'closed', starting_cash: 1000, actual_cash: 1900, variance_cash: 0, opened_at: '2026-11-09T08:00:00+07:00', closed_at: '2026-11-09T16:00:00+07:00' }
  on('/rpc/shift_close', () => json(closed))
  on('/rpc/shift_report', () => json({ shift: closed, cash_sales: 1000, cash_in_total: 0, cash_out_total: 100, expected_cash: 1900, sales_by_method: { cash: { bills: 4, total: 1000 } }, cancelled_after_paid: 0, drawer_logs: [] }))
  on('/rest/v1/tax_documents', () => json([]))
  const c = await req('/api/shifts/close', { as: 'staff', body: { restaurant_id: RID, shift_id: SHIFT, actual_cash: 1900 } })
  const cb = await body(c)
  assert.equal(c.status, 200)
  assert.deepEqual([cb.z_report.expected_cash, cb.z_report.cash_status, cb.z_report.total_bills], [1900, 'balanced', 4])
  const docsUrl = callsTo('/rest/v1/tax_documents')[0].url
  assert.match(docsUrl, new RegExp(`confirmed_by=eq\\.${USERS.staff}`))
  assert.match(docsUrl, /confirmed_at=gte\.2026-11-09T08%3A00%3A00%2B07%3A00/)

  handlers = []
  on('/rpc/shift_open', () => dbError('shift_already_open'))
  assert.equal((await req('/api/shifts/open', { as: 'staff', body: { restaurant_id: RID, starting_cash: 0 } })).status, 409)
})

test('POST /accounting/expenses: ใบกำกับภาษีซื้อ / หัก ณ ที่จ่าย ส่งต่อฐานข้อมูล · ข้อมูลไม่ครบ 400', async () => {
  on('/rest/v1/expenses', () => json([{ id: 'e1' }], 201), 'POST')
  const base = { restaurant_id: RID, account_id: DOC, amount: 1070, vat_amount: 70 }
  const ok = await req('/api/accounting/expenses', {
    as: 'accountant',
    body: { ...base, supplier_name: 'บจก. ค', supplier_tax_id: '0105551234567', tax_invoice_no: 'IV-1', tax_invoice_date: '2026-11-05', wht_rate: 3 },
  })
  assert.equal(ok.status, 201)
  const sent = callsTo('/rest/v1/expenses')[0].body as Record<string, unknown>
  assert.deepEqual([sent.supplier_tax_id, sent.tax_invoice_no, sent.wht_rate], ['0105551234567', 'IV-1', 3])
  assert.equal('supplier_branch_code' in sent, false)
  assert.equal((await req('/api/accounting/expenses', { as: 'accountant', body: { ...base, tax_invoice_no: 'IV-2', tax_invoice_date: '2026-11-05' } })).status, 400)
  assert.equal((await req('/api/accounting/expenses', { as: 'accountant', body: { ...base, supplier_name: 'x', supplier_tax_id: '0105551234567', wht_rate: 4 } })).status, 400)
})
