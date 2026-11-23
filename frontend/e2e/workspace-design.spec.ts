import { test, expect, type Page } from '@playwright/test'

const restaurant = '00000000-0000-4000-8000-000000000001'
const tables = Array.from({ length: 8 }, (_, i) => ({ id: `table-${i}`, label: i === 5 ? 'โต๊ะระเบียงสำหรับลูกค้ากลุ่มใหญ่ 6' : `โต๊ะ ${i + 1}`, floor_x: 0, floor_y: 0, zone: 'Main', seats: 4 }))
const orders = [
  { id: 'new', status: 'received', table_id: 'table-0' },
  { id: 'ready', status: 'ready', table_id: 'table-0' },
  { id: 'served-a', status: 'served', table_id: 'table-0' },
  { id: 'served-b', status: 'served', table_id: 'table-0' },
  { id: 'takeaway', status: 'served', table_id: null },
].map(order => ({ ...order, order_type: order.table_id ? 'dine_in' : 'takeaway', total: 209, created_at: new Date().toISOString(), bill_requested_at: null, order_items: [], order_promotions: [] }))

async function mockWorkspace(page: Page, options: { role?: string; tablesResponse?: (route: import('@playwright/test').Route) => Promise<void>; write?: () => void; ordersResponse?: (route: import('@playwright/test').Route) => Promise<void> } = {}) {
  await page.addInitScript(() => localStorage.setItem('plato.session', JSON.stringify({ access_token: 'workspace-test-token', expires_at: Date.now() + 600000, user: { id: '00000000-0000-4000-8000-000000000002', email: 'workspace@example.test' } })))
  await page.routeWebSocket('**/*', ws => ws.close())
  await page.route('**/api/**', route => route.fulfill({ json: route.request().url().endsWith('/readyz') ? { ok: true, schema_version: '0011' } : {} }))
  await page.route('**/rest/v1/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204 })
    if (path.endsWith('/staff_members')) return route.fulfill({ json: [{ restaurant_id: restaurant, role: options.role ?? 'owner' }] })
    if (path.endsWith('/dining_tables')) return options.tablesResponse ? options.tablesResponse(route) : route.fulfill({ json: tables })
    if (path.endsWith('/orders')) return options.ordersResponse ? options.ordersResponse(route) : route.fulfill({ json: orders })
    if (path.endsWith('/table_request_bill')) { options.write?.(); return route.fulfill({ json: null }) }
    return route.fulfill({ json: [] })
  })
}

test('table cards never overlap at mobile, tablet and desktop widths in either view', async ({ page }) => {
  await mockWorkspace(page)
  await page.goto('/tables')
  await expect(page.locator('[data-table-card]')).toHaveCount(tables.length)
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    for (const view of ['ภาพรวม', 'ผังร้าน']) {
      await page.getByRole('button', { name: view, exact: true }).click()
      const rects = await page.locator('[data-table-card]').evaluateAll(elements => elements.map(element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom } }))
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j]
        expect(a.x >= b.right || a.right <= b.x || a.y >= b.bottom || a.bottom <= b.y).toBe(true)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
  }
  await page.getByRole('button', { name: 'ภาพรวม', exact: true }).click()
  await page.screenshot({ path: 'e2e-results/tables-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 375, height: 900 })
  await page.screenshot({ path: 'e2e-results/tables-mobile.png', fullPage: true })
})

test('a failed table request replaces the skeleton with retry and does not claim tables are empty', async ({ page }) => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let fail = true
  await mockWorkspace(page, { tablesResponse: async route => { await pending; await route.fulfill(fail ? { status: 503, json: { message: 'Test unavailable' } } : { json: tables }) } })
  await page.goto('/tables')
  await expect(page.getByRole('status', { name: 'กำลังโหลดโต๊ะและออเดอร์' })).toHaveAttribute('aria-busy', 'true')
  await expect(page.getByText('ยังไม่มีโต๊ะในระบบ', { exact: true })).toHaveCount(0)
  release()
  await expect(page.getByRole('alert')).toContainText('โหลดสถานะโต๊ะไม่สำเร็จ')
  await expect(page.getByRole('status', { name: 'กำลังโหลดโต๊ะและออเดอร์' })).toHaveCount(0)
  fail = false
  await page.getByRole('button', { name: 'ลองใหม่', exact: true }).click()
  await expect(page.locator('[data-table-card]')).toHaveCount(tables.length)
})

test('notifications count actionable work, group table bills and link to the right page', async ({ page }) => {
  await mockWorkspace(page)
  await page.goto('/tables')
  const bell = page.getByRole('button', { name: 'การแจ้งเตือน (4)', exact: true })
  await bell.click()
  const dialog = page.getByRole('dialog', { name: 'การแจ้งเตือน', exact: true })
  await expect(dialog).toContainText('4 งานรอดำเนินการ')
  await expect(dialog.getByRole('link', { name: /รับชำระเงิน/ })).toContainText('2')
  await dialog.getByRole('link', { name: /เสิร์ฟอาหาร/ }).click()
  await expect(page).toHaveURL(/\/serve$/)
  await expect(dialog).toHaveCount(0)
})

test('kitchen users only receive notifications for pages they can access', async ({ page }) => {
  await mockWorkspace(page, { role: 'kitchen' })
  await page.goto('/kitchen')
  await page.getByRole('button', { name: 'การแจ้งเตือน (1)', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'การแจ้งเตือน', exact: true })
  await expect(dialog.getByRole('link')).toHaveCount(1)
  await expect(dialog.getByRole('link')).toContainText('หน้าจอครัว')
})

test('SweetAlert cancel writes nothing and duplicate clicks create only one bill request', async ({ page }) => {
  let writes = 0
  await mockWorkspace(page, { write: () => { writes++ } })
  await page.goto('/tables')
  await page.locator('[data-table-card="table-0"]').click()
  const request = page.getByRole('button', { name: 'ขอเช็คบิล', exact: true })
  await request.click()
  await expect(page.locator('.swal2-cancel')).toBeFocused()
  await page.locator('.swal2-cancel').click()
  expect(writes).toBe(0)
  await request.evaluate((button: HTMLButtonElement) => { button.click(); button.click() })
  await page.locator('.swal2-confirm').click()
  await expect.poll(() => writes).toBe(1)
  await expect(page.locator('.swal2-title')).toHaveText('สำเร็จ')
  await page.locator('.swal2-confirm').click()
  await expect(request).toBeEnabled()
})

test('notification errors show retry rather than a false zero badge', async ({ page }) => {
  let fail = true
  await mockWorkspace(page, { ordersResponse: route => route.fulfill(fail ? { status: 503, json: { message: 'Test unavailable' } } : { json: orders }) })
  await page.goto('/tables')
  const bell = page.getByRole('button', { name: 'การแจ้งเตือน', exact: true })
  await bell.click()
  const dialog = page.getByRole('dialog', { name: 'การแจ้งเตือน', exact: true })
  await expect(dialog.getByRole('alert')).toContainText('โหลดการแจ้งเตือนไม่สำเร็จ')
  await expect(dialog.getByText('ไม่มีงานค้างในตอนนี้')).toHaveCount(0)
  fail = false
  await dialog.getByRole('button', { name: 'ลองใหม่' }).click()
  await expect(dialog).toContainText('4 งานรอดำเนินการ')
})

for (const route of ['/kitchen', '/serve', '/counter']) {
  test(`${route} keeps a skeleton until orders resolve and then shows a real empty state`, async ({ page }) => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    await mockWorkspace(page, { ordersResponse: async request => { await pending; await request.fulfill({ json: [] }) } })
    await page.goto(route)
    const label = route === '/kitchen' ? 'กำลังโหลดออเดอร์' : 'กำลังโหลดข้อมูล'
    const loading = page.getByRole('status', { name: label, exact: true })
    await expect(loading).toHaveAttribute('aria-busy', 'true')
    await expect(page.locator('.empty')).toHaveCount(0)
    release()
    await expect(loading).toHaveCount(0)
    await expect(page.locator('.empty').first()).toBeVisible()
  })
}

test('POS does not show an empty menu while the first menu request is pending', async ({ page }) => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  await mockWorkspace(page)
  await page.route('**/rest/v1/menu_items?**', async route => { await pending; await route.fulfill({ json: [] }) })
  await page.goto('/pos')
  const loading = page.getByRole('status', { name: 'กำลังโหลดเมนูและโต๊ะ', exact: true })
  await expect(loading).toBeVisible()
  await expect(page.getByText('ไม่พบเมนู', { exact: true })).toHaveCount(0)
  release()
  await expect(loading).toHaveCount(0)
  await expect(page.getByText('ไม่พบเมนู', { exact: true })).toBeVisible()
})
