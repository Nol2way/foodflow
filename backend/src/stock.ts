// API โมดูลสต็อกวัตถุดิบ (0027-0030) · ทุก endpoint เรียกฐานข้อมูลด้วย JWT ของผู้ใช้ (RLS + has_role ตรวจซ้ำ)
// ยอดคงเหลือ/ต้นทุนมาจาก ledger + ล็อตในฐานข้อมูลเท่านั้น backend แค่ตรวจรูปแบบข้อมูลแล้วส่งต่อ
// สูตรคำนวณใช้ร่วมกับหน้าเว็บ (frontend/src/lib/stockMath.ts)
import type { Context, Hono } from 'hono'
import type { AppEnv, Role } from './env.ts'
import { asUser } from './supabase.ts'
import type { Helpers } from './accounting.ts'
import { COUNT_TYPES, round } from '../../frontend/src/lib/stockMath.ts'

type Ctx = Context<AppEnv>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/
export const MAX_HISTORY_DAYS = 366

// ใครทำอะไรได้ (ฐานข้อมูลบังคับซ้ำใน 0030 และในฟังก์ชัน)
export const STOCK_READ: Role[] = ['owner', 'manager', 'stock', 'accountant'] // ดูภาพรวม รายงาน ประวัติ
export const STOCK_WRITE: Role[] = ['owner', 'manager', 'stock'] // วัตถุดิบ ผู้ขาย สูตร รับเข้า นับ yield test
export const STOCK_APPROVE: Role[] = ['owner', 'manager'] // รับรองใบนับ กลับรายการ

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'))
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

// ===== ตรวจข้อมูลวัตถุดิบ =====
type Spec = { kind: 'text'; max: number; required?: boolean } | { kind: 'num'; min: number; max: number; int?: boolean; nullable?: boolean }
  | { kind: 'enum'; values: readonly string[] } | { kind: 'bool' } | { kind: 'uuid'; nullable?: boolean }

const INGREDIENT: Record<string, Spec> = {
  name: { kind: 'text', max: 100, required: true },
  unit: { kind: 'text', max: 30 },
  category: { kind: 'text', max: 40 },
  purchase_unit: { kind: 'text', max: 30 },
  conversion_factor: { kind: 'num', min: 0.0001, max: 1_000_000 },
  display_unit: { kind: 'text', max: 30 },
  display_factor: { kind: 'num', min: 0.0001, max: 1_000_000 },
  trim_yield_pct: { kind: 'num', min: 0.01, max: 100 },
  cook_yield_pct: { kind: 'num', min: 0.01, max: 400 },
  abc_class: { kind: 'enum', values: ['A', 'B', 'C'] },
  storage_location: { kind: 'text', max: 40 },
  shelf_order: { kind: 'num', min: 0, max: 100_000, int: true },
  reorder_level: { kind: 'num', min: 0, max: 100_000_000 },
  par_level: { kind: 'num', min: 0, max: 100_000_000, nullable: true },
  safety_stock: { kind: 'num', min: 0, max: 100_000_000 },
  variance_threshold_pct: { kind: 'num', min: 0, max: 100 },
  supplier_id: { kind: 'uuid', nullable: true },
  count_weekly: { kind: 'bool' },
  is_active: { kind: 'bool' },
}
// สร้างใหม่เท่านั้น: หน่วยฐาน (เปลี่ยนไม่ได้หลังมีประวัติ) · ยอดยกมา + ราคาเริ่มต้นต่อหน่วยฐาน (กลายเป็นล็อตแรก)
const INGREDIENT_CREATE: Record<string, Spec> = {
  recipe_unit: { kind: 'enum', values: ['g', 'ml', 'pcs'] },
  quantity_on_hand: { kind: 'num', min: 0, max: 100_000_000 },
  cost_per_unit: { kind: 'num', min: 0, max: 1_000_000 },
}

export function pickFields(b: Record<string, unknown>, spec: Record<string, Spec>, create: boolean): Record<string, unknown> | string {
  const out: Record<string, unknown> = {}
  for (const [k, s] of Object.entries(spec)) {
    const v = b[k]
    if (v === undefined) {
      if (create && s.kind === 'text' && s.required) return k
      continue
    }
    if (s.kind === 'text') {
      const t = text(v, s.max)
      if (s.required && !t) return k
      out[k] = t || null
    } else if (s.kind === 'num') {
      if (v === null && s.nullable) {
        out[k] = null
        continue
      }
      const n = num(v)
      if (!Number.isFinite(n) || n < s.min || n > s.max || (s.int && !Number.isInteger(n))) return k
      out[k] = n
    } else if (s.kind === 'enum') {
      if (!s.values.includes(String(v))) return k
      out[k] = v
    } else if (s.kind === 'bool') {
      if (typeof v !== 'boolean') return k
      out[k] = v
    } else if (s.kind === 'uuid') {
      if (v === null && s.nullable) out[k] = null
      else if (!isUuid(v)) return k
      else out[k] = v
    }
  }
  return out
}

// ===== ตรวจบรรทัดเอกสาร =====
export function receiptLines(v: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 200) return null
  const out: Record<string, unknown>[] = []
  for (const l of v as Record<string, unknown>[]) {
    if (!l || typeof l !== 'object' || !isUuid(l.ingredient_id)) return null
    const packQty = num(l.pack_qty)
    const packSize = num(l.pack_size)
    const packPrice = num(l.pack_price)
    const qty = num(l.quantity)
    const cost = num(l.unit_cost)
    const byPack = Number.isFinite(packQty) && Number.isFinite(packSize) && Number.isFinite(packPrice)
    if (byPack ? packQty < 0 || packSize <= 0 || packPrice < 0 : !(qty >= 0 && cost >= 0)) return null
    if (l.expiry_date != null && l.expiry_date !== '' && !isDate(l.expiry_date)) return null
    out.push({
      ingredient_id: l.ingredient_id,
      ...(byPack ? { pack_qty: packQty, pack_size: packSize, pack_price: packPrice } : { quantity: qty, unit_cost: cost }),
      ...(isDate(l.expiry_date) ? { expiry_date: l.expiry_date } : {}),
      ...(Number.isFinite(num(l.invoice_qty)) ? { invoice_qty: num(l.invoice_qty) } : {}),
      ...(typeof l.note === 'string' && l.note.trim() ? { note: text(l.note, 200) } : {}),
    })
  }
  return new Set(out.map((l) => l.ingredient_id)).size === out.length ? out : null
}

export function countLines(v: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 1000) return null
  const out: Record<string, unknown>[] = []
  for (const l of v as Record<string, unknown>[]) {
    const counted = num(l?.counted_qty)
    if (!l || !isUuid(l.ingredient_id) || !Number.isFinite(counted) || counted < 0) return null
    out.push({
      ingredient_id: l.ingredient_id,
      counted_qty: round(counted, 3),
      ...(typeof l.entered_text === 'string' && l.entered_text.trim() ? { entered_text: text(l.entered_text, 100) } : {}),
      ...(typeof l.note === 'string' && l.note.trim() ? { note: text(l.note, 200) } : {}),
    })
  }
  return new Set(out.map((l) => l.ingredient_id)).size === out.length ? out : null
}

export function recipeLines(v: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(v) || v.length > 100) return null
  const out: Record<string, unknown>[] = []
  for (const l of v as Record<string, unknown>[]) {
    const qty = num(l?.qty)
    const ing = l?.ingredient_id ?? null
    const sub = l?.sub_recipe_id ?? null
    if (!(qty > 0) || (ing === null) === (sub === null) || (ing !== null && !isUuid(ing)) || (sub !== null && !isUuid(sub))) return null
    out.push(ing ? { ingredient_id: ing, qty } : { sub_recipe_id: sub, qty })
  }
  return out
}

function historyRange(c: Ctx): { from: string; to: string } | null {
  const from = c.req.query('from')
  const to = c.req.query('to')
  if (!isDate(from) || !isDate(to) || from > to) return null
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_HISTORY_DAYS) return null
  return { from, to }
}

const INGREDIENT_COLUMNS =
  'id,name,unit,recipe_unit,category,quantity_on_hand,cost_per_unit,last_unit_cost,purchase_unit,conversion_factor,display_unit,display_factor,' +
  'trim_yield_pct,cook_yield_pct,abc_class,storage_location,shelf_order,reorder_level,par_level,safety_stock,variance_threshold_pct,' +
  'supplier_id,count_weekly,is_active'

export function registerStock(app: Hono<AppEnv>, h: Helpers) {
  const { auth, requireRole, fail, body } = h
  const db = (c: Ctx) => asUser(c.env, c.var.token)
  const rid = (c: Ctx, roles: Role[], from?: unknown) => requireRole(c, from ?? c.req.query('restaurant_id'), roles)

  // ----- ภาพรวม -----
  app.get('/stock/overview', auth, async (c) => {
    const r = await rid(c, STOCK_READ)
    if (typeof r !== 'string') return r
    return c.json(await db(c).rpc('stock_overview', { p_restaurant_id: r }))
  })

  app.get('/stock/reorder', auth, async (c) => {
    const r = await rid(c, STOCK_READ)
    if (typeof r !== 'string') return r
    const days = Number(c.req.query('days') ?? 28)
    if (!Number.isInteger(days) || days < 1 || days > 365) return fail(c, 400, 'invalid_days')
    return c.json({ suggestions: await db(c).rpc('stock_reorder_suggestions', { p_restaurant_id: r, p_days: days }) })
  })

  // ----- วัตถุดิบ -----
  app.get('/stock/ingredients', auth, async (c) => {
    const r = await rid(c, STOCK_READ)
    if (typeof r !== 'string') return r
    const active = c.req.query('include_inactive') === 'true' ? '' : '&is_active=eq.true'
    return c.json({ ingredients: await db(c).select(`ingredients?select=${INGREDIENT_COLUMNS}&restaurant_id=eq.${r}${active}&order=name`) })
  })

  app.post('/stock/ingredients', auth, async (c) => {
    const b = await body(c)
    const r = await rid(c, STOCK_WRITE, b.restaurant_id)
    if (typeof r !== 'string') return r
    const row = pickFields(b, { ...INGREDIENT, ...INGREDIENT_CREATE }, true)
    if (typeof row === 'string') return fail(c, 400, 'invalid_field', { field: row })
    if (!row.recipe_unit) return fail(c, 400, 'invalid_field', { field: 'recipe_unit', message: 'เลือกหน่วยฐาน g / ml / pcs' })
    if (row.recipe_unit !== 'pcs' || !row.unit) row.unit = row.recipe_unit
    const [saved] = await db(c).insert('ingredients', { ...row, restaurant_id: r })
    return c.json({ ingredient: saved }, 201)
  })

  app.patch('/stock/ingredients/:id', auth, async (c) => {
    const b = await body(c)
    const r = await rid(c, STOCK_WRITE, b.restaurant_id)
    if (typeof r !== 'string') return r
    const id = c.req.param('id')
    if (!isUuid(id)) return fail(c, 400, 'invalid_id')
    const row = pickFields(b, INGREDIENT, false)
    if (typeof row === 'string') return fail(c, 400, 'invalid_field', { field: row })
    if (Object.keys(row).length === 0) return fail(c, 400, 'nothing_to_update')
    const saved = await db(c).update(`ingredients?id=eq.${id}&restaurant_id=eq.${r}`, row)
    if (saved.length === 0) return fail(c, 404, 'not_found')
    return c.json({ ingredient: saved[0] })
  })

  // ----- ผู้ขาย -----
  app.get('/stock/suppliers', auth, async (c) => {
    const r = await rid(c, STOCK_READ)
    if (typeof r !== 'string') return r
    return c.json({ suppliers: await db(c).select(`suppliers?select=*&restaurant_id=eq.${r}&order=name`) })
  })

  const supplierRow = (b: Record<string, unknown>, create: boolean): Record<string, unknown> | string => {
    const row = pickFields(b, {
      name: { kind: 'text', max: 100, required: true },
      phone: { kind: 'text', max: 30 },
      note: { kind: 'text', max: 200 },
      lead_time_days: { kind: 'num', min: 0, max: 60, int: true },
      is_active: { kind: 'bool' },
    }, create)
    if (typeof row === 'string') return row
    if (b.delivery_days !== undefined) {
      const d = b.delivery_days
      if (!Array.isArray(d) || d.length === 0 || d.length > 7 || d.some((x) => !Number.isInteger(x) || x < 0 || x > 6) || new Set(d).size !== d.length) {
        return 'delivery_days'
      }
      row.delivery_days = [...d].sort()
    }
    return row
  }

  app.post('/stock/suppliers', auth, async (c) => {
    const b = await body(c)
    const r = await rid(c, STOCK_WRITE, b.restaurant_id)
    if (typeof r !== 'string') return r
    const row = supplierRow(b, true)
    if (typeof row === 'string') return fail(c, 400, 'invalid_field', { field: row })
    const [saved] = await db(c).insert('suppliers', { ...row, restaurant_id: r })
    return c.json({ supplier: saved }, 201)
  })

  app.patch('/stock/suppliers/:id', auth, async (c) => {
    const b = await body(c)
    const r = await rid(c, STOCK_WRITE, b.restaurant_id)
    if (typeof r !== 'string') return r
    const id = c.req.param('id')
    if (!isUuid(id)) return fail(c, 400, 'invalid_id')
    const row = supplierRow(b, false)
    if (typeof row === 'string') return fail(c, 400, 'invalid_field', { field: row })
    const saved = await db(c).update(`suppliers?id=eq.${id}&restaurant_id=eq.${r}`, row)
    if (saved.length === 0) return fail(c, 404, 'not_found')
    return c.json({ supplier: saved[0] })
  })

  // ----- สูตร (รองรับสูตรย่อย) -----
  app.get('/stock/recipes', auth, async (c) => {
    const r = await rid(c, STOCK_READ)
    if (typeof r !== 'string') return r
    const [recipes, menus] = await Promise.all([
      db(c).select(`recipes?select=id,name,menu_item_id,output_qty,output_unit,cost_per_output,cost_updated_at,note,recipe_lines!recipe_lines_recipe_id_fkey(id,ingredient_id,sub_recipe_id,qty)&restaurant_id=eq.${r}&order=name`),
      db(c).rpc('stock_menu_items', { p_restaurant_id: r }),
    ])
    return c.json({ recipes, menus })
  })

  const saveRecipe = async (c: Ctx, id: string | null) => {
    const b = await body(c)
    const r = await rid(c, STOCK_WRITE, b.restaurant_id)
    if (typeof r !== 'string') return r
    const name = text(b.name, 100)
    const output = num(b.output_qty ?? 1)
    const lines = recipeLines(b.lines ?? [])
    if (!name) return fail(c, 400, 'invalid_field', { field: 'name' })
    if (!(output > 0) || output > 1_000_000) return fail(c, 400, 'invalid_field', { field: 'output_qty' })
    if (b.menu_item_id != null && !isUuid(b.menu_item_id)) return fail(c, 400, 'invalid_field', { field: 'menu_item_id' })
    if (!lines) return fail(c, 400, 'invalid_lines', { message: 'แต่ละบรรทัดเลือกวัตถุดิบหรือสูตรย่อย และปริมาณมากกว่า 0' })
    const saved = await db(c).rpc<string>('stock_save_recipe', {
      p_restaurant_id: r, p_id: id, p_name: name, p_menu_item_id: b.menu_item_id ?? null, p_output_qty: output,
      p_output_unit: text(b.output_unit, 20) || 'จาน', p_lines: lines, p_note: text(b.note, 300) || null,
    })
    const [recipe] = await db(c).select(`recipes?select=id,name,menu_item_id,output_qty,output_unit,cost_per_output,recipe_lines!recipe_lines_recipe_id_fkey(id,ingredient_id,sub_recipe_id,qty)&id=eq.${saved}`)
    return c.json({ recipe }, id ? 200 : 201)
  }
  app.post('/stock/recipes', auth, (c) => saveRecipe(c, null))
  app.put('/stock/recipes/:id', auth, (c) => (isUuid(c.req.param('id')) ? saveRecipe(c, c.req.param('id')) : fail(c, 400, 'invalid_id')))

  app.delete('/stock/recipes/:id', auth, async (c) => {
    const r = await rid(c, STOCK_WRITE)
    if (typeof r !== 'string') return r
    const id = c.req.param('id')
    if (!isUuid(id)) return fail(c, 400, 'invalid_id')
    const rows = await db(c).remove(`recipes?id=eq.${id}&restaurant_id=eq.${r}`)
    if (rows.length === 0) return fail(c, 404, 'not_found')
    return c.json({ deleted: id })
  })

  // ----- รับเข้า -----
  app.get('/stock/last-purchases', auth, async (c) => {
    const r = await rid(c, STOCK_READ)
    if (typeof r !== 'string') return r
    const sup = c.req.query('supplier_id') || null
    if (sup && !isUuid(sup)) return fail(c, 400, 'invalid_supplier')
    return c.json({ last: await db(c).rpc('stock_last_purchases', { p_restaurant_id: r, p_supplier_id: sup }) })
  })

  app.post('/stock/receipts', auth, async (c) => {
    const b = await body(c)
    const r = await rid(c, STOCK_WRITE, b.restaurant_id)
    if (typeof r !== 'string') return r
    if (b.supplier_id != null && !isUuid(b.supplier_id)) return fail(c, 400, 'invalid_supplier')
    if (b.received_on != null && !isDate(b.received_on)) return fail(c, 400, 'invalid_date')
    const lines = receiptLines(b.lines)
    if (!lines) return fail(c, 400, 'invalid_lines', { message: 'ทุกบรรทัดต้องมีวัตถุดิบ (ไม่ซ้ำ) จำนวนและราคาไม่ติดลบ วันหมดอายุเป็น YYYY-MM-DD' })
    const result = await db(c).rpc('stock_receive', {
      p_restaurant_id: r, p_supplier_id: b.supplier_id ?? null, p_lines: lines, p_invoice_no: text(b.invoice_no, 50) || null,
      p_received_on: b.received_on ?? null, p_note: text(b.note, 300) || null, p_record_expense: b.record_expense !== false,
    })
    return c.json(result, 201)
  })

  app.get('/stock/receipts', auth, async (c) => {
    const r = await rid(c, STOCK_READ)
    if (typeof r !== 'string') return r
    const range = historyRange(c)
    if (!range) return fail(c, 400, 'invalid_range', { message: `ใส่ from/to เป็น YYYY-MM-DD (ไม่เกิน ${MAX_HISTORY_DAYS} วัน)` })
    return c.json({
      receipts: await db(c).select(
        `stock_receipts?select=id,supplier,supplier_id,invoice_no,received_on,total_cost,invoice_total,received_by_name,created_at,` +
          `stock_receipt_lines(ingredient_id,ingredient_name,unit,quantity,unit_cost,pack_qty,pack_size,pack_price,expiry_date,price_change_pct,pack_changed)` +
          `&restaurant_id=eq.${r}&received_on=gte.${range.from}&received_on=lte.${range.to}&order=created_at.desc`,
      ),
    })
  })

  // ----- นับสต็อก -----
  app.get('/stock/count-sheet', auth, async (c) => {
    const r = await rid(c, STOCK_WRITE)
    if (typeof r !== 'string') return r
    const abc = (c.req.query('abc') ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    if (abc.some((x) => !['A', 'B', 'C'].includes(x))) return fail(c, 400, 'invalid_abc')
    return c.json({ items: await db(c).rpc('stock_count_sheet', { p_restaurant_id: r, p_abc: abc.length ? abc : null }) })
  })

  app.post('/stock/counts', auth, async (c) => {
    const b = await body(c)
    const r = await rid(c, STOCK_WRITE, b.restaurant_id)
    if (typeof r !== 'string') return r
    const kind = String(b.count_type ?? 'spot')
    if (!(kind in COUNT_TYPES)) return fail(c, 400, 'invalid_count_type')
    const lines = countLines(b.lines)
    if (!lines) return fail(c, 400, 'invalid_lines', { message: 'ทุกบรรทัดต้องมีวัตถุดิบ (ไม่ซ้ำ) และจำนวนที่นับไม่ติดลบ' })
    const id = await db(c).rpc<string>('submit_stock_count', { p_restaurant_id: r, p_lines: lines, p_note: text(b.note, 300) || null, p_count_type: kind })
    // ผู้นับเห็นผลต่างได้หลังบันทึกแล้วเท่านั้น (ใบนับเป็น blind)
    return c.json({ count_id: id }, 201)
  })

  app.get('/stock/counts', auth, async (c) => {
    const r = await rid(c, STOCK_READ)
    if (typeof r !== 'string') return r
    return c.json({
      counts: await db(c).select(
        `stock_counts?select=id,count_type,note,item_count,diff_count,diff_value,counted_by,counted_by_name,verified_by_name,verified_at,created_at` +
          `&restaurant_id=eq.${r}&order=created_at.desc&limit=100`,
      ),
    })
  })

  app.post('/stock/counts/:id/verify', auth, async (c) => {
    const b = await body(c)
    const r = await rid(c, STOCK_APPROVE, b.restaurant_id)
    if (typeof r !== 'string') return r
    const id = c.req.param('id')
    if (!isUuid(id)) return fail(c, 400, 'invalid_id')
    await db(c).rpc('verify_stock_count', { p_count_id: id })
    return c.json({ verified: id })
  })

  app.get('/stock/counts/:id/variance', auth, async (c) => {
    const r = await rid(c, STOCK_READ)
    if (typeof r !== 'string') return r
    const id = c.req.param('id')
    if (!isUuid(id)) return fail(c, 400, 'invalid_id')
    return c.json({ lines: await db(c).rpc('stock_variance_report', { p_restaurant_id: r, p_count_id: id }) })
  })

  // ----- Yield test -----
  app.get('/stock/yield-tests', auth, async (c) => {
    const r = await rid(c, STOCK_READ)
    if (typeof r !== 'string') return r
    const ing = c.req.query('ingredient_id')
    if (ing && !isUuid(ing)) return fail(c, 400, 'invalid_ingredient')
    return c.json({
      tests: await db(c).select(
        `yield_tests?select=*,ingredients(name,unit)&restaurant_id=eq.${r}${ing ? `&ingredient_id=eq.${ing}` : ''}&order=created_at.desc&limit=100`,
      ),
    })
  })

  app.post('/stock/yield-tests', auth, async (c) => {
    const b = await body(c)
    const r = await rid(c, STOCK_WRITE, b.restaurant_id)
    if (typeof r !== 'string') return r
    if (!isUuid(b.ingredient_id)) return fail(c, 400, 'invalid_ingredient')
    if (b.kind !== 'trim' && b.kind !== 'cook') return fail(c, 400, 'invalid_kind')
    const trials = b.trials
    if (!Array.isArray(trials) || trials.length !== 3 || trials.some((t) => !(num(t?.before) > 0) || !(num(t?.after) > 0))) {
      return fail(c, 400, 'three_trials_required', { message: 'ชั่งก่อน-หลัง 3 ครั้ง น้ำหนักมากกว่า 0' })
    }
    const result = await db(c).rpc('record_yield_test', {
      p_restaurant_id: r, p_ingredient_id: b.ingredient_id, p_kind: b.kind,
      p_trials: trials.map((t) => ({ before: num(t.before), after: num(t.after) })), p_apply: b.apply === true, p_note: text(b.note, 200) || null,
    })
    return c.json(result, 201)
  })

  // ----- ประวัติ + กลับรายการ -----
  app.get('/stock/history', auth, async (c) => {
    const r = await rid(c, STOCK_READ)
    if (typeof r !== 'string') return r
    const range = historyRange(c)
    if (!range) return fail(c, 400, 'invalid_range', { message: `ใส่ from/to เป็น YYYY-MM-DD (ไม่เกิน ${MAX_HISTORY_DAYS} วัน)` })
    const ing = c.req.query('ingredient_id') || null
    const actor = c.req.query('actor_id') || null
    const type = c.req.query('type') || null
    if ((ing && !isUuid(ing)) || (actor && !isUuid(actor))) return fail(c, 400, 'invalid_filter')
    if (type && !['receive', 'recipe_deduct', 'recipe_return', 'count_adjust', 'legacy'].includes(type)) return fail(c, 400, 'invalid_type')
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 200) || 200, 1), 1000)
    // ช่วงวันที่รวมวันสุดท้าย (เวลาไทย)
    const rows = await db(c).rpc('stock_history', {
      p_restaurant_id: r, p_from: `${range.from}T00:00:00+07:00`, p_to: new Date(Date.parse(`${range.to}T00:00:00+07:00`) + 86_400_000).toISOString(),
      p_ingredient_id: ing, p_actor_id: actor, p_type: type, p_limit: limit,
    })
    return c.json({ movements: rows })
  })

  app.post('/stock/movements/:id/reverse', auth, async (c) => {
    const b = await body(c)
    const r = await rid(c, STOCK_APPROVE, b.restaurant_id)
    if (typeof r !== 'string') return r
    const id = c.req.param('id')
    if (!isUuid(id)) return fail(c, 400, 'invalid_id')
    const reason = text(b.reason, 180)
    if (!reason) return fail(c, 400, 'reason_required', { message: 'ต้องใส่เหตุผล' })
    const reversal = await db(c).rpc<string>('stock_reverse_movement', { p_movement_id: id, p_reason: reason })
    return c.json({ reversal_id: reversal }, 201)
  })
}
