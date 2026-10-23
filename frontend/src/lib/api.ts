// เรียก backend (Cloudflare Pages Functions /api หรือ Worker แยก ถ้าตั้ง VITE_API_URL)
import { supabase } from './supabase'

const BASE = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/+$/, '')

export class ApiError extends Error {
  status: number
  code: string
  data: Record<string, unknown>
  constructor(status: number, data: Record<string, unknown>) {
    super(String(data.message ?? data.error ?? `HTTP ${status}`))
    this.status = status
    this.code = String(data.error ?? '')
    this.data = data
  }
}

export async function api<T = Record<string, unknown>>(
  path: string,
  opts: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.auth !== false) {
    const { data } = await supabase.auth.getSession()
    if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`
  }
  let res: Response
  try {
    res = await fetch(`${BASE}/api${path}`, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
  } catch {
    throw new ApiError(0, { error: 'network', message: 'เชื่อมต่อ backend ไม่ได้' })
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new ApiError(res.status, data)
  return data as T
}

// ข้อความภาษาไทยสำหรับข้อผิดพลาดทั่วไป
export function apiMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return 'เกิดข้อผิดพลาด กรุณาลองใหม่'
  if (e.data.message) return String(e.data.message)
  switch (e.status) {
    case 0:
      return 'เชื่อมต่อ backend ไม่ได้ (ตรวจว่าเปิด backend อยู่ และตั้ง VITE_API_URL ถูกต้อง)'
    case 401:
      return 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'
    case 403:
      return 'ไม่มีสิทธิ์ทำรายการนี้'
    case 404:
      return 'ไม่พบข้อมูล หรือยังไม่ได้ดีพลอย backend'
    case 429:
      return 'เรียกใช้ถี่เกินไป กรุณารอสักครู่'
    default:
      return 'เกิดข้อผิดพลาด กรุณาลองใหม่'
  }
}
