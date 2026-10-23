import { expect, test } from '@playwright/test'
import { STAFF_PAGES, type Role } from '../src/lib/roles'
import { USERS, login } from './helpers'

// แต่ละบทบาทเห็นเมนูหน้าแรกตรงตามสิทธิ์ (ตารางเดียวกับที่แอปใช้)
const ROLES: [keyof typeof USERS, Role][] = [
  ['owner', 'owner'],
  ['manager', 'manager'],
  ['staff', 'staff'],
  ['kitchen', 'kitchen'],
  ['accountant', 'accountant'],
  ['stock', 'stock'],
]

for (const [user, role] of ROLES) {
  test(`${role}: หน้าแรกแสดงเฉพาะหน้าที่มีสิทธิ์`, async ({ page }) => {
    await login(page, USERS[user])
    for (const p of STAFF_PAGES) {
      const tile = page.locator(`a[href="${p.path}"]`).filter({ hasText: p.label })
      if (p.roles.includes(role)) await expect(tile).toBeVisible()
      else await expect(tile).toHaveCount(0)
    }
  })
}

test('ไม่มีบทบาท: ล็อกอินได้แต่ไม่เห็นงาน', async ({ page }) => {
  await login(page, USERS.noRole)
  await expect(page.getByText('บัญชีนี้ยังไม่ได้ผูกกับร้านใด')).toBeVisible()
})

test('ครัวเปิดหน้าบัญชีตรงๆ ไม่ได้', async ({ page }) => {
  await login(page, USERS.kitchen)
  await page.goto('/accounting')
  await expect(page.getByText('ไม่มีสิทธิ์เข้าหน้านี้')).toBeVisible()
})

test('ผู้จัดการดูบัญชีได้ แต่ไม่มีฟอร์มบันทึกรายจ่าย', async ({ page }) => {
  await login(page, USERS.manager)
  await page.goto('/accounting')
  await expect(page.getByText('ผู้จัดการดูบัญชีได้อย่างเดียว')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'บันทึกรายจ่าย' })).toHaveCount(0)
})

test('ร้านอื่นไม่เห็นเมนูของร้านเรา', async ({ page }) => {
  await login(page, USERS.otherOwner)
  await page.goto('/pos')
  await expect(page.getByPlaceholder('ค้นหาเมนู')).toBeVisible()
  await expect(page.getByText('ผัดกะเพราหมูสับ')).toHaveCount(0)
})
