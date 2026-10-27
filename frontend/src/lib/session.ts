// เซสชันล็อกอินของระบบเอง (ตาราง app_users ผ่าน backend ไม่ใช้ Supabase Auth)
// เก็บ access_token ใน localStorage แล้วแจ้งทุกคอมโพเนนต์ที่ฟังอยู่เมื่อเปลี่ยน
export interface SessionUser {
  id: string
  email: string
  display_name: string | null
  must_change_password: boolean
}

export interface Session {
  access_token: string
  expires_at: number // มิลลิวินาที
  user: SessionUser
}

const KEY = 'plato.session'
const listeners = new Set<(s: Session | null) => void>()
let current: Session | null = read()

function read(): Session | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as Session
    return s.access_token && s.expires_at > Date.now() ? s : null
  } catch {
    return null
  }
}

export function getSession(): Session | null {
  if (current && current.expires_at <= Date.now()) setSession(null) // หมดอายุ: ออกจากระบบ
  return current
}

export function setSession(s: Session | null) {
  current = s
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s))
    else localStorage.removeItem(KEY)
  } catch {
    // เบราว์เซอร์ปิด storage: ใช้ได้เฉพาะแท็บนี้
  }
  for (const fn of listeners) fn(s)
}

export function updateUser(patch: Partial<SessionUser>) {
  if (current) setSession({ ...current, user: { ...current.user, ...patch } })
}

export function onSessionChange(fn: (s: Session | null) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export const getToken = () => getSession()?.access_token ?? null

// ล็อกอิน/ออกจากระบบในอีกแท็บ ให้แท็บนี้ตามด้วย
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    current = read()
    for (const fn of listeners) fn(current)
  })
}
