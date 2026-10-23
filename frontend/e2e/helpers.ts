import { readFileSync } from 'node:fs'
import { expect, type Page } from '@playwright/test'

// รหัสผ่านบัญชีทดสอบ: E2E_PASSWORD หรืออ่านจาก v_password ใน seed_test_users.sql
function testPassword(): string {
  if (process.env.E2E_PASSWORD) return process.env.E2E_PASSWORD
  const sql = readFileSync(new URL('../../database/seed/seed_test_users.sql', import.meta.url), 'utf8')
  const m = sql.match(/v_password text := '([^']+)'/)
  if (!m) throw new Error('ไม่พบ v_password ใน seed_test_users.sql ตั้ง E2E_PASSWORD แทน')
  return m[1]
}

export const PASSWORD = testPassword()
export const USERS = {
  owner: 'owner@foodflow.test',
  manager: 'manager@foodflow.test',
  staff: 'staff@foodflow.test',
  kitchen: 'kitchen@foodflow.test',
  accountant: 'accountant@foodflow.test',
  stock: 'stock@foodflow.test',
  otherOwner: 'other-owner@foodflow.test',
  noRole: 'norole@foodflow.test',
} as const

export async function login(page: Page, email: string) {
  await page.goto('/login')
  await page.getByPlaceholder('อีเมล').fill(email)
  await page.getByPlaceholder('รหัสผ่าน').fill(PASSWORD)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page).not.toHaveURL(/\/login/)
  await expect(page.getByText('กำลังโหลด...')).toHaveCount(0)
}
