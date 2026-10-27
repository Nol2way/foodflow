// ตัวแปรของ Worker (ตั้งใน wrangler.toml [vars] หรือ `wrangler secret put`)
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export interface Env {
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
  SUPABASE_SERVICE_ROLE_KEY: string // secret: ห้ามอยู่ในหน้าเว็บ
  SUPABASE_JWT_SECRET: string // secret: JWT secret ของโปรเจกต์ (Settings > API) ใช้ลงนามโทเคนล็อกอิน
  SESSION_HOURS?: string // อายุโทเคนล็อกอิน (ชั่วโมง) ค่าเริ่มต้น 12
  GEMINI_API_KEY?: string // secret: ไม่ตั้ง = ปิดฟีเจอร์ AI
  GEMINI_MODEL?: string
  ALLOWED_ORIGINS?: string // คั่นด้วยจุลภาค เช่น "https://foodflow.pages.dev,http://localhost:5173"
  AI_LIMITER?: RateLimiter // Cloudflare Rate Limiting binding (ไม่บังคับ) เรียก AI ต่อผู้ใช้
  LINE_CHANNEL_ACCESS_TOKEN?: string // secret: LINE Messaging API ไม่ตั้ง = ส่งรายงานทาง LINE อัตโนมัติไม่ได้
  REPORT_HOUR?: string // ชั่วโมงที่ส่งรายงานรายวัน (เวลาร้าน) ค่าเริ่มต้น 22
}

export type Role = 'owner' | 'manager' | 'staff' | 'kitchen' | 'accountant' | 'stock'
export const ROLES: Role[] = ['owner', 'manager', 'staff', 'kitchen', 'accountant', 'stock']
// ผู้จัดการมอบ/แก้บทบาทเหล่านี้ไม่ได้ (กันเลื่อนสิทธิ์) ฐานข้อมูลบังคับซ้ำใน 0009
export const MANAGER_CANNOT_ASSIGN: Role[] = ['owner', 'manager']

export interface Vars {
  userId: string
  email: string
  token: string
  roles: Role[] // บทบาทของผู้ใช้ในร้านที่เรียก (มีได้หลายบทบาท)
}

export type AppEnv = { Bindings: Env; Variables: Vars }
