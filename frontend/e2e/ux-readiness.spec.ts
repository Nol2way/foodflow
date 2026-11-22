import { test, expect } from '@playwright/test'

test('readiness uses a responsive skeleton until the schema check finishes', async ({ page }) => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let dataReads = 0
  await page.route('**/api/readyz', async route => { await pending; await route.fulfill({ status: 503, json: { error: 'schema_not_ready' } }) })
  await page.route('**/rest/v1/**', route => { dataReads++; return route.fulfill({ json: [] }) })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/pos')
  const skeleton = page.getByRole('main', { name: 'กำลังโหลดระบบ' })
  await expect(skeleton).toHaveAttribute('aria-busy', 'true')
  await expect(page.getByRole('status')).toHaveText('กำลังตรวจความพร้อมและโหลดหน้าจอ')
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `e2e-results/skeleton-${width}.png`, fullPage: true })
  }
  expect(await page.locator('.skeleton-block').first().evaluate(el => getComputedStyle(el).animationName)).toBe('none')
  expect(dataReads).toBe(0)
  release()
  await expect(skeleton).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'ระบบกำลังรออัปเดตฐานข้อมูล' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'ตรวจอีกครั้ง' })).toBeEnabled()
})

test('password change validates inline and replaces the revoked session token', async ({ page }) => {
  const user = { id: '00000000-0000-4000-8000-000000000002', email: 'mock@example.test', must_change_password: true }
  await page.addInitScript(user => localStorage.setItem('plato.session', JSON.stringify({ access_token: 'old-synthetic', expires_at: Date.now() + 600000, user })), user)
  let writes = 0
  await page.route('**/api/readyz', route => route.fulfill({ json: { ok: true, schema_version: '0011' } }))
  await page.route('**/api/auth/password', route => { writes++; return route.fulfill({ json: { changed: true, access_token: 'renewed-synthetic', expires_at: Date.now() + 600000, user: { ...user, must_change_password: false } } }) })
  await page.route('**/rest/v1/**', route => route.fulfill({ json: [] }))
  await page.goto('/set-password')
  await page.getByRole('button', { name: 'บันทึกรหัสผ่าน' }).click()
  await expect(page.getByLabel('รหัสชั่วคราว', { exact: true })).toBeFocused()
  expect(writes).toBe(0)
  await page.getByLabel('รหัสชั่วคราว', { exact: true }).fill('current-test')
  await page.getByLabel('รหัสผ่านใหม่', { exact: true }).fill('new-test-password')
  await page.getByLabel('ยืนยันรหัสผ่านใหม่', { exact: true }).fill('new-test-password')
  await page.getByRole('button', { name: 'บันทึกรหัสผ่าน' }).click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('plato.session')!).access_token)).toBe('renewed-synthetic')
  expect(writes).toBe(1)
})

for (const theme of ['light', 'dark']) {
  test(`readable ${theme} controls with reduced motion`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/login')
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme)
    const contrast = await page.locator('.btn-primary').evaluate(el => {
      const rgb = (color: string) => (color.match(/[\d.]+/g) || []).slice(0, 3).map(Number)
      const luminance = (color: string) => rgb(color).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0)
      const s = getComputedStyle(el), a = luminance(s.color), b = luminance(s.backgroundColor)
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
    })
    expect(contrast).toBeGreaterThanOrEqual(4.5)
    await page.screenshot({ path: `e2e-results/ux-login-${theme}.png`, fullPage: true })
  })
}

test('old schema stops page queries and retry mounts only a compatible app', async ({ page }) => {
  let ready = false
  let reads = 0
  await page.addInitScript(() => localStorage.setItem('plato.session', JSON.stringify({ access_token: 'synthetic', expires_at: Date.now() + 600000, user: { id: '00000000-0000-4000-8000-000000000002', email: 'mock@example.test' } })))
  await page.route('**/api/readyz', route => route.fulfill({ status: ready ? 200 : 503, json: ready ? { ok: true, schema_version: '0011' } : { error: 'schema_not_ready' } }))
  await page.route('**/rest/v1/**', route => { reads++; return route.fulfill({ json: [] }) })
  await page.goto('/pos')
  await expect(page.getByRole('heading', { name: 'ระบบกำลังรออัปเดตฐานข้อมูล' })).toBeVisible()
  expect(reads).toBe(0)
  await expect(page.getByRole('button', { name: 'ส่งเข้าครัว', exact: true })).toHaveCount(0)
  ready = true
  await page.getByRole('button', { name: 'ตรวจอีกครั้ง' }).click()
  await expect.poll(() => reads).toBeGreaterThan(0)
})

for (const width of [375, 768, 1024, 1440]) {
  test(`login layout, labels and inline validation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    let submissions = 0
    await page.route('**/api/auth/login', route => { submissions++; return route.fulfill({ status: 401, json: { error: 'invalid_credentials' } }) })
    await page.goto('/login')
    const email = page.getByLabel('อีเมล', { exact: true })
    const password = page.getByLabel('รหัสผ่าน', { exact: true })
    await expect(email).toBeVisible()
    expect(await email.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16)
    const submit = page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true })
    expect((await submit.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await submit.click()
    await expect(email).toHaveAttribute('aria-invalid', 'true')
    await expect(password).toHaveAttribute('aria-describedby', 'login-password-error')
    await expect(page.getByRole('alert')).toBeFocused()
    expect(submissions).toBe(0)
    await email.fill('owner@example.test')
    await password.fill('test-only-placeholder')
    await expect(email).toHaveAttribute('aria-invalid', 'false')
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

test('mobile navigation is a keyboard-contained dialog and restores menu focus', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.addInitScript(() => localStorage.setItem('plato.session', JSON.stringify({ access_token: 'synthetic', expires_at: Date.now() + 600000, user: { id: '00000000-0000-4000-8000-000000000002', email: 'mock@example.test' } })))
  await page.route('**/api/**', route => route.fulfill({ json: route.request().url().endsWith('/readyz') ? { ok: true, schema_version: '0011' } : {} }))
  await page.route('**/rest/v1/**', route => route.fulfill({ json: route.request().url().includes('/staff_members') ? [{ restaurant_id: '00000000-0000-4000-8000-000000000001', role: 'owner' }] : [] }))
  await page.routeWebSocket('**/*', ws => ws.close())
  await page.goto('/pos')
  const menu = page.getByRole('button', { name: 'เปิดเมนู', exact: true })
  await menu.click()
  const dialog = page.getByRole('dialog', { name: 'เมนูหลัก' })
  await expect(dialog).toBeVisible()
  expect(await dialog.evaluate(el => el.parentElement === document.body && el.matches(':modal'))).toBe(true)
  await page.keyboard.press('Tab')
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(menu).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
