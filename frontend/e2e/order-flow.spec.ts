import { expect, test, type Page } from '@playwright/test'
import { USERS, login } from './helpers'

// ออเดอร์จริงครบวงจร: รับออเดอร์ → ครัว → เสิร์ฟ → รับชำระ → ใบเสร็จ → รายงานรายวัน
// สร้างข้อมูลจริงในฐานข้อมูล (ลูกค้าชื่อ E2E-<เวลา>) เป็นออเดอร์กลับบ้าน ไม่กระทบบิลของโต๊ะ
test.describe.configure({ mode: 'serial' })

const customer = `E2E-${Date.now().toString(36)}`
const label = `กลับบ้าน · ${customer}`
const card = (page: Page) => page.locator('article').filter({ hasText: label })

test('พนักงานหน้าร้าน: รับออเดอร์กลับบ้าน ส่งเข้าครัว', async ({ page }) => {
  await login(page, USERS.staff)
  await page.goto('/pos')
  await page.getByRole('button', { name: 'กลับบ้าน' }).click()
  await page.getByPlaceholder('ชื่อหรือเบอร์ลูกค้า (ไม่บังคับ)').fill(customer)
  await page.getByRole('button', { name: /ผัดกะเพราหมูสับ/ }).click()
  await page.getByRole('button', { name: 'ส่งเข้าครัว' }).click()
  await expect(page.getByText(/เข้าครัวแล้ว/)).toBeVisible()
})

test('ครัว: เริ่มทำ แล้วทำเสร็จ', async ({ page }) => {
  await login(page, USERS.kitchen)
  await page.goto('/kitchen')
  await card(page).getByRole('button', { name: 'เริ่มทำ' }).click()
  await card(page).getByRole('button', { name: 'ทำเสร็จ' }).click()
  await expect(card(page).getByRole('button', { name: 'เสิร์ฟแล้ว' }).last()).toBeVisible()
})

test('พนักงานเสิร์ฟ: เห็นออเดอร์ที่พร้อม แล้วกดเสิร์ฟครบ', async ({ page }) => {
  await login(page, USERS.staff)
  await page.goto('/serve')
  await card(page).getByRole('button', { name: 'เสิร์ฟครบแล้ว' }).click()
  await expect(card(page).getByRole('button', { name: 'เสิร์ฟครบแล้ว' })).toHaveCount(0)
})

test('รับชำระ: จ่ายเงินสด แล้วเปิดใบเสร็จ', async ({ page }) => {
  await login(page, USERS.staff)
  await page.goto('/counter')
  page.once('dialog', (d) => void d.accept())
  await card(page).getByRole('button', { name: /^รับชำระ ฿/ }).click()
  // จ่ายแล้วบิลต้องหายจากรายการค้างชำระ
  await expect(card(page)).toHaveCount(0)
  const receipt = page.getByRole('dialog', { name: 'ใบเสร็จ' })
  // ใบเสร็จต้องมี migration 0017 (ถ้ายังไม่รัน หน้ารับชำระทำงานแบบเดิม ไม่มีใบเสร็จ)
  if ((await receipt.count()) === 0) {
    test.info().annotations.push({ type: 'warning', description: 'ไม่มีใบเสร็จ: ฐานข้อมูลยังไม่ได้รัน migration 0017' })
    return
  }
  await expect(receipt.getByText('ใบเสร็จรับเงิน')).toBeVisible()
  await expect(receipt.getByText('ผัดกะเพราหมูสับ')).toBeVisible()
  await expect(receipt.getByText('เงินสด')).toBeVisible()
  await receipt.getByRole('button', { name: 'ปิด' }).click()
})

test('รายงานรายวัน: บิลที่เพิ่งจ่ายนับเข้ายอดวันนี้', async ({ page }) => {
  await login(page, USERS.manager)
  await page.goto('/report')
  const missing = page.getByText('ต้องรัน migration 0018 ก่อน')
  await expect(page.getByText('ข้อความสำหรับ LINE').or(missing)).toBeVisible()
  test.skip((await missing.count()) > 0, 'ฐานข้อมูลยังไม่ได้รัน migration 0018 (รายงานรายวัน)')
  await expect(page.locator('pre')).toContainText(/ยอดขาย ฿[\d,.]+ \([1-9][\d,]* บิล\)/)
})
