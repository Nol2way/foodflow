import { test, expect } from '@playwright/test'

test('production shell is hardened and usable offline without caching API data', async ({ page, context, request }) => {
  const response = await request.get('/login')
  for (const name of ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy']) {
    expect(response.headers()[name], name).toBeTruthy()
  }
  await page.goto('/login')
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload()
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
  const urls = await page.evaluate(async () => {
    const result: string[] = []
    for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) result.push(request.url)
    return result
  })
  expect(urls.length).toBeGreaterThan(10)
  expect(urls.some(url => new URL(url).pathname.startsWith('/api/'))).toBe(false)
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true })).toBeVisible()
})
