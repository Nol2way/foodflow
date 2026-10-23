import { defineConfig } from '@playwright/test'

// ทดสอบหน้าเว็บจริง (E2E) กับ Supabase จริง ด้วยบัญชีทดสอบจาก database/seed/seed_test_users.sql
// ก่อนรัน: รัน migration ครบ + seed.sql + seed_test_users.sql ในโปรเจกต์ Supabase ที่ใช้ทดสอบ
// รัน: npm run test:e2e   (ใช้ dev server ที่เปิดอยู่ หรือเปิดให้เองที่พอร์ต 5173)
// หมายเหตุ: ชุด order-flow สร้างออเดอร์จริงในฐานข้อมูล (ลูกค้าชื่อขึ้นต้นด้วย E2E-)
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1, // ใช้บัญชีและข้อมูลชุดเดียวกัน รันทีละไฟล์
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]],
  outputDir: 'e2e-results',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
