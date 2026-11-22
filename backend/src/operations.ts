import type { Hono, Context } from 'hono'
import type { AppEnv, Role } from './env.ts'
import type { Helpers } from './accounting.ts'
import { asUser } from './supabase.ts'
import { InputError, validDate, money, optionalText } from './validation.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const idOf = (v: unknown) => { if (typeof v !== 'string' || !UUID.test(v)) throw new InputError(400, 'invalid_id'); return v }
const STAFF: Role[] = ['owner', 'manager', 'staff']
const MANAGERS: Role[] = ['owner', 'manager']

export function registerOperations(app: Hono<AppEnv>, h: Helpers) {
  const { auth, requireRole, body, fail } = h
  const db = (c: Context<AppEnv>) => asUser(c.env, c.var.token)
  app.post('/staff/:userId/active', auth, async c => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, ['owner'])
    if (typeof rid !== 'string') return rid
    if (typeof b.is_active !== 'boolean') return fail(c, 400, 'invalid_request')
    const is_active = await db(c).rpc('staff_set_active', { p_restaurant_id: rid, p_user_id: idOf(c.req.param('userId')), p_active: b.is_active })
    return c.json({ is_active })
  })
  app.get('/members/find', auth, async c => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), STAFF)
    if (typeof rid !== 'string') return rid
    const phone = c.req.query('phone') ?? ''
    if (!/^(?:\d{4}|0\d{8,9})$/.test(phone)) return fail(c, 400, 'invalid_phone')
    return c.json({ members: await db(c).rpc('member_find', { p_restaurant_id: rid, p_phone: phone }) })
  })
  app.get('/members/:id/export', auth, async c => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), ['owner'])
    if (typeof rid !== 'string') return rid
    return c.json(await db(c).rpc('member_export', { p_restaurant_id: rid, p_member_id: idOf(c.req.param('id')) }))
  })
  app.delete('/members/:id', auth, async c => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), ['owner'])
    if (typeof rid !== 'string') return rid
    return c.json(await db(c).rpc('member_delete', { p_restaurant_id: rid, p_member_id: idOf(c.req.param('id')) }))
  })
  app.post('/feedback', auth, async c => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, STAFF)
    if (typeof rid !== 'string') return rid
    if (typeof b.rating !== 'number' || !Number.isInteger(b.rating) || b.rating < 1 || b.rating > 5) return fail(c, 400, 'invalid_rating')
    const id = await db(c).rpc('submit_feedback', { p_restaurant_id: rid, p_rating: b.rating, p_client_ref: idOf(b.client_ref) })
    return c.json({ id }, 201)
  })
  app.get('/promotions/coupon', auth, async c => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), STAFF)
    if (typeof rid !== 'string') return rid
    const code = optionalText(c.req.query('code'), 40)
    if (!code) return fail(c, 400, 'invalid_coupon')
    return c.json({ promotion: await db(c).rpc('coupon_lookup', { p_restaurant_id: rid, p_code: code }) })
  })
  // Date-bound reports use database snapshots, not browser aggregation.
  for (const [path, fn, roles] of [
    ['/promotions/report', 'promo_report', ['owner', 'manager', 'accountant']],
    ['/feedback/report', 'feedback_report', MANAGERS],
    ['/stock/supplier-report', 'supplier_receiving_report', ['owner', 'manager', 'stock', 'accountant']],
  ] as [string, string, Role[]][]) {
    app.get(path, auth, async c => {
      const rid = await requireRole(c, c.req.query('restaurant_id'), roles)
      if (typeof rid !== 'string') return rid
      const from = c.req.query('from'), to = c.req.query('to')
      if (!validDate(from) || !validDate(to) || from > to || (Date.parse(to)-Date.parse(from))/86400000 > 3660) return fail(c, 400, 'invalid_range')
      return c.json({ report: await db(c).rpc(fn, { p_restaurant_id: rid, p_from: from, p_to: to }) })
    })
  }
  app.post('/stock/receipts/:id/claim', auth, async c => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, ['owner', 'manager', 'stock', 'accountant'])
    if (typeof rid !== 'string') return rid
    const id = idOf(c.req.param('id'))
    if (!(await db(c).select(`stock_receipts?select=id&id=eq.${id}&restaurant_id=eq.${rid}`)).length) return fail(c, 404, 'not_found')
    if (!['pending', 'credited', 'accepted'].includes(String(b.status))) return fail(c, 400, 'invalid_status')
    await db(c).rpc('set_receipt_claim', { p_receipt_id: id, p_ingredient_id: idOf(b.ingredient_id), p_status: b.status })
    return c.json({ updated: true })
  })
  app.patch('/tax/documents/:id', auth, async c => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, [...STAFF, 'accountant'])
    if (typeof rid !== 'string') return rid
    const id = idOf(c.req.param('id'))
    const [old] = await db(c).select<Record<string, unknown>>(`tax_documents?select=*&id=eq.${id}&restaurant_id=eq.${rid}`)
    if (!old) return fail(c, 404, 'not_found')
    const fields: Record<string, unknown> = { p_document_id: id }
    for (const [key, max] of [['buyer_name', 200], ['buyer_tax_id', 13], ['buyer_branch_code', 5], ['buyer_address', 500], ['credit_note_reason', 300]] as const) {
      fields['p_' + key] = key in b ? optionalText(b[key], max) : key === 'credit_note_reason' ? null : old[key]
    }
    for (const key of ['amount', 'exempt_amount']) fields['p_' + key] = b[key] == null ? null : money(b[key])
    const document = await db(c).rpc<Record<string, unknown>>('tax_doc_update_draft', fields)
    const { xml_payload: _xml, ...safe } = document
    return c.json({ document: safe })
  })
  app.post('/tax/documents/:id/void', auth, async c => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, [...MANAGERS, 'accountant'])
    if (typeof rid !== 'string') return rid
    const id = idOf(c.req.param('id'))
    if (!(await db(c).select(`tax_documents?select=id&id=eq.${id}&restaurant_id=eq.${rid}`)).length) return fail(c, 404, 'not_found')
    const reason = optionalText(b.reason, 300)
    if (!reason) return fail(c, 400, 'reason_required')
    await db(c).rpc('tax_doc_void_draft', { p_document_id: id, p_reason: reason })
    return c.json({ voided: id })
  })

  app.get('/tax/settings', auth, async c => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), [...MANAGERS, 'accountant'])
    if (typeof rid !== 'string') return rid
    const [settings] = await db(c).select(`tax_settings?select=*&restaurant_id=eq.${rid}`)
    return c.json({ settings: settings ?? null })
  })
  app.put('/tax/settings', auth, async c => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, ['owner'])
    if (typeof rid !== 'string') return rid
    const values: Record<string, unknown> = {}
    for (const [key, max] of [['tax_id', 13], ['company_name', 200], ['branch_code', 5], ['branch_name', 100], ['registered_address', 500], ['postcode', 5]] as const) values[key] = optionalText(b[key], max)
    values.branch_code ??= '00000'
    const existing = await db(c).select(`tax_settings?select=restaurant_id&restaurant_id=eq.${rid}`)
    const [settings] = existing.length ? await db(c).update(`tax_settings?restaurant_id=eq.${rid}`, values) : await db(c).insert('tax_settings', { ...values, restaurant_id: rid })
    return c.json({ settings })
  })
  app.get('/tax/terminals', auth, async c => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), [...STAFF, 'accountant'])
    if (typeof rid !== 'string') return rid
    return c.json({ terminals: await db(c).select(`pos_terminals?select=*&restaurant_id=eq.${rid}&order=terminal_code`) })
  })
  const terminalValues = (b: Record<string, unknown>, partial: boolean) => {
    const out: Record<string, unknown> = {}
    for (const [key, max] of [['terminal_code', 10], ['name', 80], ['pos_reg_no', 30]] as const) if (!partial || key in b) out[key] = optionalText(b[key], max)
    if (typeof out.terminal_code === 'string') out.terminal_code = out.terminal_code.toUpperCase()
    if ('is_active' in b) { if (typeof b.is_active !== 'boolean') throw new InputError(400, 'invalid_request'); out.is_active = b.is_active }
    return out
  }
  app.post('/tax/terminals', auth, async c => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, MANAGERS)
    if (typeof rid !== 'string') return rid
    const [terminal] = await db(c).insert('pos_terminals', { ...terminalValues(b, false), restaurant_id: rid })
    return c.json({ terminal }, 201)
  })
  app.patch('/tax/terminals/:id', auth, async c => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, MANAGERS)
    if (typeof rid !== 'string') return rid
    const [terminal] = await db(c).update(`pos_terminals?id=eq.${idOf(c.req.param('id'))}&restaurant_id=eq.${rid}`, terminalValues(b, true))
    return terminal ? c.json({ terminal }) : fail(c, 404, 'not_found')
  })
  app.delete('/tax/terminals/:id', auth, async c => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), MANAGERS)
    if (typeof rid !== 'string') return rid
    const rows = await db(c).remove(`pos_terminals?id=eq.${idOf(c.req.param('id'))}&restaurant_id=eq.${rid}`)
    return rows.length ? c.json({ deleted: true }) : fail(c, 404, 'not_found')
  })
}
