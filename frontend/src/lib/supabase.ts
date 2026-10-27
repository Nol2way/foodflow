import { createClient } from '@supabase/supabase-js'
import { getToken, onSessionChange } from './session'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

// ถ้ายังไม่ได้ตั้งค่า .env จะไม่ให้แอปพังทั้งหน้า แต่แสดงคำเตือนแทน
export const isConfigured = Boolean(url && key)

// ใช้โทเคนที่ backend ออกให้ตอนล็อกอิน (ไม่ใช้ Supabase Auth) · ยังไม่ล็อกอิน = ใช้ anon key (เช่น จอ iPad)
export const supabase = createClient(url ?? 'http://localhost:54321', key ?? 'missing-key', {
  accessToken: async () => getToken(),
})

// Realtime ต้องได้โทเคนใหม่ทุกครั้งที่ล็อกอิน/ออกจากระบบ
onSessionChange((s) => void supabase.realtime.setAuth(s?.access_token ?? null))
