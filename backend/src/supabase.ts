// ตัวเรียก Supabase แบบเบา (PostgREST) ด้วย fetch ตรงๆ
// - asUser(token): ใช้ JWT ของผู้ใช้ (backend ออกเองตอนล็อกอิน) => RLS และ has_role ทำงานตามสิทธิ์จริง
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
