import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

// ถ้ายังไม่ได้ตั้งค่า .env จะไม่ให้แอปพังทั้งหน้า แต่แสดงคำเตือนแทน
export const isConfigured = Boolean(url && key)

export const supabase = createClient(url ?? 'http://localhost:54321', key ?? 'missing-key')
