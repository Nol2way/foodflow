// ตัวเรียก Supabase แบบเบา (PostgREST + Auth) ด้วย fetch ตรงๆ
// - asUser(token): ใช้ JWT ของผู้ใช้ => RLS และ has_role ทำงานตามสิทธิ์จริง
// - asService(): ใช้ service role => ข้าม RLS ใช้เฉพาะงานที่ตรวจสิทธิ์ใน backend แล้ว
import type { Env } from './env.ts'

export class DbError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export interface Db {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T>
  select<T = unknown>(pathAndQuery: string): Promise<T[]>
  insert<T = unknown>(table: string, body: unknown): Promise<T[]>
  update<T = unknown>(pathAndQuery: string, body: unknown): Promise<T[]>
  remove<T = unknown>(pathAndQuery: string): Promise<T[]>
}

function client(env: Env, apikey: string, bearer: string): Db {
  const base = env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/'
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(base + path, {
      method,
      headers: {
        apikey,
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    const data = text ? JSON.parse(text) : null
    if (!res.ok) {
      throw new DbError(res.status, data?.code ?? '', data?.message ?? `supabase ${res.status}`)
    }
    return data as T
  }
  return {
    rpc: (fn, args) => call('POST', `rpc/${fn}`, args),
    select: (p) => call('GET', p),
    insert: (t, b) => call('POST', t, b),
    update: (p, b) => call('PATCH', p, b),
    remove: (p) => call('DELETE', p),
  }
}

export const asUser = (env: Env, token: string) => client(env, env.SUPABASE_ANON_KEY, token)
export const asService = (env: Env) => client(env, env.SUPABASE_SERVICE_ROLE_KEY, env.SUPABASE_SERVICE_ROLE_KEY)

// ตรวจ JWT กับ Supabase Auth (ไม่ถอด JWT เองในโค้ด)
export async function getUserId(env: Env, token: string): Promise<string | null> {
  const res = await fetch(env.SUPABASE_URL.replace(/\/+$/, '') + '/auth/v1/user', {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  const user = (await res.json()) as { id?: string }
  return user.id ?? null
}

// เชิญผู้ใช้ใหม่ทางอีเมล (Supabase ส่งอีเมลให้ตั้งรหัสผ่าน)
export async function inviteUser(env: Env, email: string, redirectTo?: string): Promise<string> {
  const url = new URL(env.SUPABASE_URL.replace(/\/+$/, '') + '/auth/v1/invite')
  if (redirectTo) url.searchParams.set('redirect_to', redirectTo)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email }),
  })
  const data = (await res.json().catch(() => ({}))) as { id?: string; msg?: string; message?: string }
  if (!res.ok || !data.id) throw new DbError(res.status, 'invite_failed', data.msg ?? data.message ?? 'invite failed')
  return data.id
}
