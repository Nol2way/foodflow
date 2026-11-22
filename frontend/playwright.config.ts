import { defineConfig } from '@playwright/test'
import { loadEnv } from 'vite'

const remote = process.env.E2E_ALLOW_REMOTE === '1'
if (remote) {
  const env = loadEnv('development', process.cwd(), 'VITE_')
  if (!process.env.E2E_SUPABASE_URL || process.env.E2E_SUPABASE_URL !== env.VITE_SUPABASE_URL) {
    throw new Error('Set E2E_SUPABASE_URL to the exact disposable/staging database URL in VITE_SUPABASE_URL.')
  }
  if (!process.env.E2E_PASSWORD) throw new Error('Remote tests require a dedicated E2E_PASSWORD.')
}

// ทดสอบหน้าเว็บจริง (E2E) กับ Supabase จริง ด้วยบัญชีทดสอบจาก database/seed/seed_test_users.sql
// ก่อนรัน: รัน migration ครบ + seed.sql + seed_test_users.sql ในโปรเจกต์ Supabase ที่ใช้ทดสอบ
// รัน: npm run test:e2e   (ใช้ dev server ที่เปิดอยู่ หรือเปิดให้เองที่พอร์ต 5173)
// หมายเหตุ: ชุด order-flow สร้างออเดอร์จริงในฐานข้อมูล (ลูกค้าชื่อขึ้นต้นด้วย E2E-)
export default defineConfig({
  testDir: './e2e',
  testIgnore: remote ? undefined : ['**/roles.spec.ts', '**/order-flow.spec.ts'],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1, // ใช้บัญชีและข้อมูลชุดเดียวกัน รันทีละไฟล์
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]],
  outputDir: 'e2e-results',
  use: {
    channel: process.env.E2E_BROWSER_CHANNEL || undefined,
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
