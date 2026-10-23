import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { createMiddleware } from 'hono/factory'
import { MANAGER_CANNOT_ASSIGN, ROLES, type AppEnv, type Env, type Role } from './env.ts'
import { DbError, asService, asUser, getUserId, inviteUser, type Db } from './supabase.ts'
import { allow } from './guards.ts'
import { parseSales } from './csv.ts'
import { AiError, MAX_QUESTION, askGemini, collectFacts } from './ai.ts'
import { openapi, swaggerHtml } from './openapi.ts'
import { LineError, pushLine } from './reports.ts'
import { askGeminiPromos } from './promo.ts'
import { reportText, type DailyReport } from '../../frontend/src/lib/report.ts'
import { ruleSuggestions, type Insights } from '../../frontend/src/lib/promoSuggest.ts'

export const AI_PER_MINUTE = 6
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

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

// บทบาทของผู้ใช้ในร้าน (อ่านด้วย JWT ของผู้ใช้เอง ผ่าน RLS staff_read_self)
async function roleOf(db: Db, userId: string, restaurantId: string): Promise<Role | null> {
  const rows = await db.select<{ role: Role }>(
    `staff_members?select=role&user_id=eq.${userId}&restaurant_id=eq.${restaurantId}`,
  )
  return rows[0]?.role ?? null
}

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
  const auth = createMiddleware<AppEnv>(async (c, next) => {
    const h = c.req.header('Authorization') ?? ''
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : ''
    const userId = token ? await getUserId(c.env, token) : null
    if (!userId) return fail(c, 401, 'unauthorized')
    c.set('userId', userId)
    c.set('token', token)
    await next()
  })

  async function requireRole(c: Ctx, restaurantId: unknown, roles: Role[]): Promise<string | Response> {
    const rid = String(restaurantId ?? '')
    if (!UUID.test(rid)) return fail(c, 400, 'invalid_restaurant_id')
    const role = await roleOf(asUser(c.env, c.var.token), c.var.userId, rid)
    if (!role || !roles.includes(role)) return fail(c, 403, 'forbidden')
    c.set('role', role)
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
    const role = String(b.role ?? '') as Role
    if (!EMAIL.test(email) || email.length > 254) return fail(c, 400, 'invalid_email')
    if (!ROLES.includes(role)) return fail(c, 400, 'invalid_role')
    if (c.var.role === 'manager' && MANAGER_CANNOT_ASSIGN.includes(role)) {
      return fail(c, 403, 'role_not_allowed', { message: 'ผู้จัดการแต่งตั้งเจ้าของหรือผู้จัดการไม่ได้' })
    }

    let userId = await asService(c.env).rpc<string | null>('staff_find_user', { p_email: email })
    let invited = false
    if (!userId) {
      // ลิงก์ในอีเมลเชิญพากลับมาหน้าตั้งรหัสผ่านของเว็บที่เจ้าของใช้อยู่ (โดเมนเดียวกัน หรือที่อยู่ใน ALLOWED_ORIGINS)
      const origin = c.req.header('Origin') ?? ''
      const trusted = origin === new URL(c.req.url).origin || allowedOrigins(c.env).includes(origin)
      const redirect = trusted ? `${origin}/set-password` : undefined
      try {
        userId = await inviteUser(c.env, email, redirect)
      } catch (e) {
        console.error('invite failed', e)
        return fail(c, 502, 'invite_failed', { message: 'ส่งอีเมลเชิญไม่สำเร็จ ตรวจการตั้งค่าอีเมลใน Supabase' })
      }
      invited = true
    }
    // เพิ่มด้วย JWT ของเจ้าของ: RLS owner_manage_staff ตรวจซ้ำอีกชั้น
    await asUser(c.env, c.var.token).insert('staff_members', { user_id: userId, restaurant_id: rid, role })
    return c.json({ user_id: userId, email, role, invited }, 201)
  })

  app.patch('/staff/:userId', auth, async (c) => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, ['owner', 'manager'])
    if (typeof rid !== 'string') return rid
    const target = c.req.param('userId')
    const role = String(b.role ?? '') as Role
    if (!UUID.test(target)) return fail(c, 400, 'invalid_user_id')
    if (!ROLES.includes(role)) return fail(c, 400, 'invalid_role')
    if (c.var.role === 'manager' && MANAGER_CANNOT_ASSIGN.includes(role)) {
      return fail(c, 403, 'role_not_allowed', { message: 'ผู้จัดการแต่งตั้งเจ้าของหรือผู้จัดการไม่ได้' })
    }
    const rows = await asUser(c.env, c.var.token).update(
      `staff_members?user_id=eq.${target}&restaurant_id=eq.${rid}`,
      { role },
    )
    if (rows.length === 0) return fail(c, 404, 'not_found')
    return c.json({ user_id: target, role })
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

  // ----- เอกสาร API (Swagger) -----
  app.get('/openapi.json', (c) => c.json(openapi))
  app.get('/docs', (c) => c.html(swaggerHtml))

  app.notFound((c) => c.json({ error: 'not_found' }, 404))
  return app
}
