import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { createMiddleware } from 'hono/factory'
import { MANAGER_CANNOT_ASSIGN, ROLES, type AppEnv, type Env, type Role } from './env.ts'
import { DbError, asService, asUser, type Db } from './supabase.ts'
import { signJwt, verifyJwt } from './jwt.ts'
import { allow } from './guards.ts'
import { parseSales } from './csv.ts'
import { AiError, MAX_QUESTION, askGemini, collectFacts } from './ai.ts'
import { openapi, swaggerHtml } from './openapi.ts'
import { LineError, pushLine } from './reports.ts'
import { askGeminiPromos } from './promo.ts'
import { reportText, type DailyReport } from '../../frontend/src/lib/report.ts'
import { ruleSuggestions, type Insights } from '../../frontend/src/lib/promoSuggest.ts'
import { ACCOUNTING_ERRORS, accountingErrorCode } from '../../frontend/src/lib/accounting.ts'
import { registerAccounting } from './accounting.ts'
import { registerStock } from './stock.ts'
import { STOCK_CONFLICTS, stockError, stockErrorCode } from '../../frontend/src/lib/stockMath.ts'

export const AI_PER_MINUTE = 6
export const LOGIN_PER_MINUTE = 10
export const MIN_PASSWORD = 8
// ฟังก์ชันวิเคราะห์ในฐานข้อมูลดูย้อนหลังได้สูงสุด 120 วัน (0004) ถ้ารับมากกว่านี้ AI จะถูกบอกช่วงเวลาผิด
export const MAX_AI_DAYS = 120
const MAX_CSV_CHARS = 3_000_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

type Ctx = Context<AppEnv>
const fail = (c: Ctx, status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 502 | 503, error: string, extra: object = {}) =>
  c.json({ error, ...extra }, status)

async function body(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json()
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// รหัสผ่านชั่วคราว 10 ตัว (ตัดตัวที่สับสนง่าย เช่น 0/O 1/l)
function tempPassword(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  return Array.from(bytes, (b) => chars[b % chars.length]).join('')
}

interface LoginRow {
  id: string
  email: string
  display_name: string | null
  must_change_password: boolean
}

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

// บทบาทของผู้ใช้ในร้าน 1 แถวต่อ 1 บทบาท (อ่านด้วย JWT ของผู้ใช้เอง ผ่าน RLS staff_read_self)
async function rolesOf(db: Db, userId: string, restaurantId: string): Promise<Role[]> {
  const rows = await db.select<{ role: Role }>(
    `staff_members?select=role&user_id=eq.${userId}&restaurant_id=eq.${restaurantId}`,
  )
  return rows.map((r) => r.role)
}

// รับ roles (array) หรือ role (ค่าเดียว แบบเดิม) · ตัดซ้ำ ต้องมีอย่างน้อย 1 บทบาทและเป็นบทบาทที่รู้จัก
function parseRoles(b: Record<string, unknown>): Role[] | null {
  const raw = Array.isArray(b.roles) ? b.roles : b.role === undefined ? [] : [b.role]
  const roles = [...new Set(raw.map((r) => String(r)))] as Role[]
  return roles.length > 0 && roles.every((r) => ROLES.includes(r)) ? roles : null
}

// ผู้จัดการ (ที่ไม่ใช่เจ้าของ) มอบบทบาทเจ้าของ/ผู้จัดการไม่ได้
const managerBlocked = (mine: Role[], wanted: Role[]) =>
  !mine.includes('owner') && wanted.some((r) => MANAGER_CANNOT_ASSIGN.includes(r))

export function createApp() {
  const app = new Hono<AppEnv>().basePath('/api')

  app.use('*', async (c, next) => {
    const origins = allowedOrigins(c.env)
    return cors({
      origin: (o) => (origins.includes(o) ? o : null),
      allowHeaders: ['Content-Type', 'Authorization'],
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    })(c, next)
  })

  app.onError((err, c) => {
    if (err instanceof DbError) {
      const msg = err.message
      if (msg === 'forbidden') return fail(c, 403, 'forbidden')
      if (msg === 'last_owner') return fail(c, 409, 'last_owner', { message: 'ร้านต้องมีเจ้าของอย่างน้อย 1 คน' })
      if (msg === 'weak_password') return fail(c, 400, 'weak_password', { message: `รหัสผ่านต้องยาว ${MIN_PASSWORD}-72 ตัวอักษร` })
      // สต็อก (0027-0029): ข้อความไทยจากรหัสข้อผิดพลาด (เช่น "insufficient_stock: กุ้ง") · สถานะชนกันตอบ 409
      const stock = stockErrorCode(msg)
      if (stock && c.req.path.startsWith('/api/stock') && (err.code === 'P0001' || err.code === '')) {
        return fail(c, STOCK_CONFLICTS.has(stock) ? 409 : 400, stock, { message: stockError(msg) })
      }
      // บัญชี (0026): ข้อความไทยจากรหัสข้อผิดพลาดของฐานข้อมูล · สถานะชนกันตอบ 409
      const acct = accountingErrorCode(msg)
      if (acct && (err.code === 'P0001' || err.code === '')) {
        const conflict = ['day_closed', 'already_closed', 'already_reversed', 'expense_posted_use_void', 'order_posted_use_cancel', 'journal_immutable']
        return fail(c, conflict.includes(acct) ? 409 : 400, acct, { message: ACCOUNTING_ERRORS[acct] })
      }
      if (err.code === '23505') return fail(c, 409, 'duplicate')
      if (err.code === '42501') return fail(c, 403, 'forbidden')
      if (err.status === 401 || err.code === 'PGRST301') return fail(c, 401, 'unauthorized')
      if (err.code === 'P0001' || err.code === '22P02' || err.code === '22007' || err.code === '22008') {
        return fail(c, 400, 'invalid_request', { message: msg })
      }
    }
    console.error('unhandled', err)
    return c.json({ error: 'internal_error' }, 500)
  })

  app.get('/health', (c) =>
    c.json({
      ok: true,
      ai: Boolean(c.env.GEMINI_API_KEY),
      line: Boolean(c.env.LINE_CHANNEL_ACCESS_TOKEN),
    }),
  )

  // ===== ต้องล็อกอิน =====
  // ตรวจลายเซ็น JWT ที่ backend ออกเอง แล้วเช็กว่าบัญชียังเปิดใช้งาน (ปิดบัญชีแล้วโทเคนเดิมใช้ต่อไม่ได้)
  const auth = createMiddleware<AppEnv>(async (c, next) => {
    if (!c.env.SUPABASE_JWT_SECRET) return fail(c, 503, 'auth_not_configured', { message: 'ยังไม่ได้ตั้ง SUPABASE_JWT_SECRET ที่ backend' })
    const h = c.req.header('Authorization') ?? ''
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : ''
    const claims = token ? await verifyJwt(token, c.env.SUPABASE_JWT_SECRET) : null
    if (!claims || !UUID.test(claims.sub)) return fail(c, 401, 'unauthorized')
    if (!(await asService(c.env).rpc<boolean>('app_user_active', { p_user_id: claims.sub }))) return fail(c, 401, 'unauthorized')
    c.set('userId', claims.sub)
    c.set('email', claims.email ?? '')
    c.set('token', token)
    await next()
  })

  // ----- ล็อกอิน / บัญชีผู้ใช้ (ตาราง app_users ของระบบเอง) -----
  app.post('/auth/login', async (c) => {
    if (!c.env.SUPABASE_JWT_SECRET) return fail(c, 503, 'auth_not_configured', { message: 'ยังไม่ได้ตั้ง SUPABASE_JWT_SECRET ที่ backend' })
    const b = await body(c)
    const email = String(b.email ?? '').trim().toLowerCase()
    const password = String(b.password ?? '')
    if (!EMAIL.test(email) || email.length > 254 || !password || password.length > 72) {
      return fail(c, 400, 'invalid_request', { message: 'กรอกอีเมลและรหัสผ่าน' })
    }
    // กันสุ่มรหัส: จำกัดต่อ IP และต่ออีเมล
    const ip = c.req.header('CF-Connecting-IP') ?? 'local'
    const okIp = await allow(undefined, `login-ip:${ip}`, LOGIN_PER_MINUTE)
    const okEmail = await allow(undefined, `login-email:${email}`, LOGIN_PER_MINUTE)
    if (!okIp || !okEmail) return fail(c, 429, 'too_many_requests', { message: 'ลองเข้าสู่ระบบถี่เกินไป รอ 1 นาทีแล้วลองใหม่' })

    const rows = await asService(c.env).rpc<LoginRow[]>('app_login', { p_email: email, p_password: password })
    const user = rows[0]
    if (!user) return fail(c, 401, 'invalid_credentials', { message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' })

    const hours = Math.min(Math.max(Number(c.env.SESSION_HOURS) || 12, 1), 24 * 30)
    const iat = Math.floor(Date.now() / 1000)
    const exp = iat + hours * 3600
    const access_token = await signJwt(
      { sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', iat, exp },
      c.env.SUPABASE_JWT_SECRET,
    )
    return c.json({ access_token, expires_at: exp * 1000, user })
  })

  app.get('/auth/me', auth, async (c) => {
    const rows = await asService(c.env).rpc<unknown[]>('app_user_profile', { p_user_id: c.var.userId })
    if (!rows[0]) return fail(c, 401, 'unauthorized')
    return c.json({ user: rows[0] })
  })

  app.patch('/auth/me', auth, async (c) => {
    const b = await body(c)
    await asService(c.env).rpc('app_update_profile', {
      p_user_id: c.var.userId,
      p_display_name: String(b.display_name ?? ''),
      p_phone: String(b.phone ?? ''),
    })
    const rows = await asService(c.env).rpc<unknown[]>('app_user_profile', { p_user_id: c.var.userId })
    return c.json({ user: rows[0] })
  })

  // เปลี่ยนรหัสผ่านตัวเอง: ต้องยืนยันรหัสปัจจุบัน (รวมรหัสชั่วคราวที่ได้จากเจ้าของร้าน)
  app.post('/auth/password', auth, async (c) => {
    const b = await body(c)
    const current = String(b.current_password ?? '')
    const next = String(b.new_password ?? '')
    if (next.length < MIN_PASSWORD || next.length > 72) {
      return fail(c, 400, 'weak_password', { message: `รหัสผ่านต้องยาว ${MIN_PASSWORD}-72 ตัวอักษร` })
    }
    if (next === current) return fail(c, 400, 'same_password', { message: 'รหัสผ่านใหม่ต้องไม่ซ้ำรหัสเดิม' })
    if (!(await allow(undefined, `password:${c.var.userId}`, LOGIN_PER_MINUTE))) return fail(c, 429, 'too_many_requests')
    const svc = asService(c.env)
    const ok = await svc.rpc<LoginRow[]>('app_login', { p_email: c.var.email, p_password: current })
    if (!ok[0] || ok[0].id !== c.var.userId) {
      return fail(c, 400, 'wrong_password', { message: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' })
    }
    await svc.rpc('app_set_password', { p_user_id: c.var.userId, p_password: next, p_must_change: false })
    return c.json({ changed: true })
  })

  async function requireRole(c: Ctx, restaurantId: unknown, roles: Role[]): Promise<string | Response> {
    const rid = String(restaurantId ?? '')
    if (!UUID.test(rid)) return fail(c, 400, 'invalid_restaurant_id')
    const mine = await rolesOf(asUser(c.env, c.var.token), c.var.userId, rid)
    if (!mine.some((r) => roles.includes(r))) return fail(c, 403, 'forbidden')
    c.set('roles', mine)
    return rid
  }

  // ----- นำเข้ายอดขาย CSV (เจ้าของร้าน, ผู้จัดการ) -----
  app.post('/import/sales', auth, async (c) => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, ['owner', 'manager'])
    if (typeof rid !== 'string') return rid
    if (typeof b.csv !== 'string' || b.csv.length === 0) return fail(c, 400, 'invalid_request', { message: 'ไม่มีไฟล์ CSV' })
    if (b.csv.length > MAX_CSV_CHARS) return fail(c, 413, 'too_large', { message: 'ไฟล์ใหญ่เกิน 3 MB' })

    const { rows, errors } = parseSales(b.csv)
    if (errors.length) {
      return fail(c, 400, 'invalid_rows', { errors: errors.slice(0, 100), error_count: errors.length })
    }
    // เรียกด้วย JWT ของผู้ใช้ ฐานข้อมูลตรวจ has_role(owner) ซ้ำอีกชั้น
    const result = await asUser(c.env, c.var.token).rpc('import_sales_history', {
      p_restaurant_id: rid,
      p_rows: rows,
      p_dry_run: b.dry_run === true,
      p_skip_unknown: b.skip_unknown === true,
    })
    return c.json(result)
  })

  app.delete('/import/:batch', auth, async (c) => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), ['owner', 'manager'])
    if (typeof rid !== 'string') return rid
    const batch = c.req.param('batch')
    if (!UUID.test(batch)) return fail(c, 400, 'invalid_batch')
    const deleted = await asUser(c.env, c.var.token).remove<{ id: string }>(
      `orders?import_batch=eq.${batch}&restaurant_id=eq.${rid}&select=id`,
    )
    if (deleted.length === 0) return fail(c, 404, 'not_found')
    return c.json({ deleted_orders: deleted.length })
  })

  // ----- สรุป/ถามด้วย AI (เจ้าของ, บัญชี) -----
  app.post('/ai/summary', auth, async (c) => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, ['owner', 'accountant'])
    if (typeof rid !== 'string') return rid
    const days = Number(b.days ?? 28)
    if (!Number.isInteger(days) || days < 1 || days > MAX_AI_DAYS) return fail(c, 400, 'invalid_days')
    const question = typeof b.question === 'string' ? b.question : undefined
    if (question && question.length > MAX_QUESTION) {
      return fail(c, 400, 'question_too_long', { message: `คำถามยาวได้ไม่เกิน ${MAX_QUESTION} ตัวอักษร` })
    }
    if (!c.env.GEMINI_API_KEY) return fail(c, 503, 'ai_disabled', { message: 'ยังไม่ได้ตั้งค่า GEMINI_API_KEY' })
    if (!(await allow(c.env.AI_LIMITER, `ai:${c.var.userId}`, AI_PER_MINUTE))) {
      return fail(c, 429, 'too_many_requests', { message: 'เรียก AI ถี่เกินไป กรุณารอสักครู่' })
    }

    const facts = await collectFacts(asUser(c.env, c.var.token), rid, days)
    if (facts.orders === 0) {
      return c.json({ answer: 'ยังไม่มีออเดอร์ในช่วงนี้ จึงยังสรุปไม่ได้ ลองเลือกช่วงเวลาที่ยาวขึ้นหรือนำเข้ายอดขายย้อนหลังก่อน', facts, ai: false })
    }
    try {
      const answer = await askGemini(c.env, facts, question)
      return c.json({ answer, facts, ai: true })
    } catch (e) {
      if (e instanceof AiError) {
        console.error('ai error', e.message)
        return fail(c, 502, 'ai_unavailable', { message: 'บริการ AI ไม่ตอบสนอง ลองใหม่ภายหลัง', facts })
      }
      throw e
    }
  })

  // ----- แนะนำโปรจากยอดขาย (เจ้าของ, ผู้จัดการ) -----
  // กติกาในระบบคิดให้เสมอ · มี GEMINI_API_KEY = ให้ AI เสนอเพิ่ม (ผ่านการตรวจความปลอดภัยทุกข้อ)
  app.post('/ai/promo-suggestions', auth, async (c) => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, ['owner', 'manager'])
    if (typeof rid !== 'string') return rid
    const days = Number(b.days ?? 28)
    if (!Number.isInteger(days) || days < 7 || days > MAX_AI_DAYS) return fail(c, 400, 'invalid_days')
    const insights = await asUser(c.env, c.var.token).rpc<Insights>('promo_insights', { p_restaurant_id: rid, p_days: days })
    const rules = ruleSuggestions(insights)
    if (b.ai !== true || !c.env.GEMINI_API_KEY) return c.json({ rules, ai: [], ai_enabled: Boolean(c.env.GEMINI_API_KEY) })
    if (!(await allow(c.env.AI_LIMITER, `ai:${c.var.userId}`, AI_PER_MINUTE))) {
      return fail(c, 429, 'too_many_requests', { message: 'เรียก AI ถี่เกินไป กรุณารอสักครู่' })
    }
    try {
      return c.json({ rules, ai: await askGeminiPromos(c.env, insights, rules), ai_enabled: true })
    } catch (e) {
      if (e instanceof AiError) {
        console.error('ai promo error', e.message)
        return c.json({ rules, ai: [], ai_enabled: true, ai_error: 'บริการ AI ไม่ตอบสนอง แสดงเฉพาะคำแนะนำจากกติกา' })
      }
      throw e
    }
  })

  // ----- ส่งรายงานรายวันทาง LINE ทันที (เจ้าของ, ผู้จัดการ) -----
  app.post('/reports/daily/send', auth, async (c) => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, ['owner', 'manager'])
    if (typeof rid !== 'string') return rid
    if (b.date !== undefined && (typeof b.date !== 'string' || !DATE.test(b.date))) return fail(c, 400, 'invalid_date')
    if (!c.env.LINE_CHANNEL_ACCESS_TOKEN) {
      return fail(c, 503, 'line_disabled', { message: 'ยังไม่ได้ตั้ง LINE_CHANNEL_ACCESS_TOKEN ที่ backend' })
    }
    const db = asUser(c.env, c.var.token)
    const settings = await db.select<{ line_to: string | null }>(`shop_settings?select=line_to&restaurant_id=eq.${rid}`)
    const to = settings[0]?.line_to
    if (!to) return fail(c, 400, 'line_not_set', { message: 'ยังไม่ได้ตั้ง LINE ID ผู้รับที่หน้าตั้งค่าร้าน' })
    const report = await db.rpc<DailyReport>('daily_report', { p_restaurant_id: rid, p_date: b.date ?? null })
    try {
      await pushLine(c.env.LINE_CHANNEL_ACCESS_TOKEN, to, reportText(report))
    } catch (e) {
      if (e instanceof LineError) {
        console.error('line push failed', e.message)
        return fail(c, 502, 'line_failed', { message: 'ส่ง LINE ไม่สำเร็จ ตรวจ token และ LINE ID ผู้รับ (ต้องเพิ่มบัญชีร้านเป็นเพื่อนก่อน)' })
      }
      throw e
    }
    return c.json({ sent: true, date: report.date })
  })

  // ----- จัดการพนักงาน (เจ้าของร้าน, ผู้จัดการ: เฉพาะบทบาทต่ำกว่าผู้จัดการ) -----
  app.get('/staff', auth, async (c) => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), ['owner', 'manager'])
    if (typeof rid !== 'string') return rid
    const staff = await asService(c.env).rpc('staff_list', { p_restaurant_id: rid })
    return c.json({ staff })
  })

  app.post('/staff', auth, async (c) => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, ['owner', 'manager'])
    if (typeof rid !== 'string') return rid
    const email = String(b.email ?? '').trim().toLowerCase()
    const roles = parseRoles(b)
    if (!EMAIL.test(email) || email.length > 254) return fail(c, 400, 'invalid_email')
    if (!roles) return fail(c, 400, 'invalid_role')
    if (managerBlocked(c.var.roles, roles)) {
      return fail(c, 403, 'role_not_allowed', { message: 'ผู้จัดการแต่งตั้งเจ้าของหรือผู้จัดการไม่ได้' })
    }

    // ยังไม่มีบัญชี: สร้างให้พร้อมรหัสชั่วคราว (แสดงให้ผู้เพิ่มครั้งเดียว พนักงานต้องเปลี่ยนหลังล็อกอินครั้งแรก)
    const displayName = typeof b.display_name === 'string' ? b.display_name : null
    let userId = await asService(c.env).rpc<string | null>('staff_find_user', { p_email: email })
    let temp: string | undefined
    if (!userId) {
      temp = tempPassword()
      userId = await asService(c.env).rpc<string>('app_create_user', {
        p_email: email,
        p_password: temp,
        p_display_name: displayName,
        p_must_change: true,
      })
    }
    // เพิ่มด้วย JWT ของผู้เรียก: RLS owner_manage_staff / manager_manage_staff ตรวจซ้ำอีกชั้น
    const db = asUser(c.env, c.var.token)
    if (!temp && (await rolesOf(db, userId, rid)).length > 0) return fail(c, 409, 'duplicate')
    await db.insert('staff_members', roles.map((role) => ({ user_id: userId, restaurant_id: rid, role })))
    return c.json({ user_id: userId, email, roles, created: Boolean(temp), ...(temp ? { temp_password: temp } : {}) }, 201)
  })

  app.patch('/staff/:userId', auth, async (c) => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, ['owner', 'manager'])
    if (typeof rid !== 'string') return rid
    const target = c.req.param('userId')
    const roles = parseRoles(b)
    if (!UUID.test(target)) return fail(c, 400, 'invalid_user_id')
    if (!roles) return fail(c, 400, 'invalid_role')
    if (managerBlocked(c.var.roles, roles)) {
      return fail(c, 403, 'role_not_allowed', { message: 'ผู้จัดการแต่งตั้งเจ้าของหรือผู้จัดการไม่ได้' })
    }
    // ตั้งบทบาททั้งชุดในธุรกรรมเดียว (0020) ด้วย JWT ของผู้เรียก
    try {
      const saved = await asUser(c.env, c.var.token).rpc<Role[]>('staff_set_roles', {
        p_restaurant_id: rid,
        p_user_id: target,
        p_roles: roles,
      })
      return c.json({ user_id: target, roles: saved })
    } catch (e) {
      if (e instanceof DbError && e.message === 'not_found') return fail(c, 404, 'not_found')
      throw e
    }
  })

  // รีเซ็ตรหัสผ่านพนักงาน (ลืมรหัส): ได้รหัสชั่วคราวใหม่ พนักงานต้องเปลี่ยนหลังล็อกอิน
  // ผู้จัดการรีเซ็ตได้เฉพาะพนักงานที่ไม่มีบทบาทเจ้าของ/ผู้จัดการ · รีเซ็ตของตัวเองไม่ได้ (ใช้เปลี่ยนรหัสแทน)
  app.post('/staff/:userId/reset-password', auth, async (c) => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, ['owner', 'manager'])
    if (typeof rid !== 'string') return rid
    const target = c.req.param('userId')
    if (!UUID.test(target)) return fail(c, 400, 'invalid_user_id')
    if (target === c.var.userId) return fail(c, 400, 'use_change_password', { message: 'เปลี่ยนรหัสของตัวเองที่เมนู "เปลี่ยนรหัสผ่าน"' })
    const staff = await asService(c.env).rpc<{ user_id: string; roles: Role[] }[]>('staff_list', { p_restaurant_id: rid })
    const member = staff.find((m) => m.user_id === target)
    if (!member) return fail(c, 404, 'not_found')
    if (managerBlocked(c.var.roles, member.roles)) return fail(c, 403, 'forbidden')
    const temp = tempPassword()
    await asService(c.env).rpc('app_set_password', { p_user_id: target, p_password: temp, p_must_change: true })
    return c.json({ user_id: target, temp_password: temp })
  })

  app.delete('/staff/:userId', auth, async (c) => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), ['owner', 'manager'])
    if (typeof rid !== 'string') return rid
    const target = c.req.param('userId')
    if (!UUID.test(target)) return fail(c, 400, 'invalid_user_id')
    const rows = await asUser(c.env, c.var.token).remove(`staff_members?user_id=eq.${target}&restaurant_id=eq.${rid}`)
    if (rows.length === 0) return fail(c, 404, 'not_found')
    return c.json({ removed: target })
  })

  // ----- บัญชี (0026) -----
  registerAccounting(app, { auth, requireRole, fail, body })

  // ----- สต็อกวัตถุดิบ (0027-0030) -----
  registerStock(app, { auth, requireRole, fail, body })

  // ----- เอกสาร API (Swagger) -----
  app.get('/openapi.json', (c) => c.json(openapi))
  app.get('/docs', (c) => c.html(swaggerHtml))

  app.notFound((c) => c.json({ error: 'not_found' }, 404))
  return app
}
