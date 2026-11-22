import { test, expect, type Page } from '@playwright/test'

const origin = 'http://localhost:5173'
async function fixture(page: Page, handler?: () => Promise<unknown>) {
  page.on('pageerror', (error) => console.error('Modal harness:', error.message))
  await page.routeWebSocket('**/*', (socket) => socket.close())
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/readyz') return route.fulfill({ json: { ok: true, schema_version: '0011' } })
    if (url.pathname.endsWith('/rpc/shift_open')) {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } })
      await handler?.()
      return route.fulfill({ status: 400, json: { message: 'Mock cash action failed' }, headers: { 'Access-Control-Allow-Origin': '*' } })
    }
    if (url.pathname === '/modal-fixture') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="fixture"></main><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
      const React = (await import('/node_modules/.vite/deps/react.js')).default;
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      const {createRoot}=ReactDOM;
      const ShiftModal = (await import('/src/components/ShiftModal.tsx')).default;
      const Modal = (await import('/src/components/Modal.tsx')).default;
      import '/src/index.css';
      const h=React.createElement;
      window.parentSubmits=0;
      function App(){
        const [kind,setKind]=React.useState(null),[nested,setNested]=React.useState(false);
        const setup={loaded:true,terminals:[],terminal:null,chooseTerminal:()=>{}};
        return h('form',{id:'background-form',onSubmit:e=>{e.preventDefault();window.parentSubmits++},style:{transform:'translate(35px, 70px)',contain:'paint',width:'230px',height:'180px',overflow:'hidden'}},
          h('button',{type:'button',onClick:()=>setKind('shift')},'Open shift'),
          h('button',{type:'button',onClick:()=>setKind('nested')},'Open nested'),
          kind==='shift'&&h(ShiftModal,{restaurantId:'00000000-0000-4000-8000-000000000001',setup,current:{shift:null,loaded:true,reload:async()=>{}},onClose:()=>setKind(null),onPrint:()=>{}}),
          kind==='nested'&&h(Modal,{label:'Parent dialog',onClose:()=>setKind(null)},
            h('button',{type:'button',onClick:()=>setNested(true)},'Open child'),
            h('div',{style:{height:'1200px'}},'Scrollable modal content'),
            h('button',{type:'button',onClick:()=>setKind(null)},'Close parent'),
            nested&&h(Modal,{label:'Child dialog',onClose:()=>setNested(false)},h('button',{type:'button',onClick:()=>setNested(false)},'Close child'))));
      }
      createRoot(document.getElementById('fixture')).render(h(App));
    </script></body></html>` })
    if (url.origin === origin && route.request().method() === 'GET' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/rest/')) return route.continue()
    return route.abort()
  })
  await page.goto(origin + '/modal-fixture')
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 375, height: 667 }, { width: 844, height: 390 }]) {
  test(`shift dialog escapes transformed form and restores focus at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    await fixture(page)
    const opener = page.getByRole('button', { name: 'Open shift' })
    await opener.click()
    const dialog = page.getByRole('dialog', { name: 'จัดการกะ' })
    await expect(dialog).toBeVisible()
    const rect = await dialog.boundingBox()
    expect(rect).not.toBeNull()
    expect(Math.abs(rect!.x + rect!.width / 2 - viewport.width / 2)).toBeLessThan(2)
    expect(Math.abs(rect!.y + rect!.height / 2 - viewport.height / 2)).toBeLessThan(2)
    expect(rect!.width).toBeLessThanOrEqual(viewport.width - 24)
    expect(rect!.height).toBeLessThanOrEqual(viewport.height - 24)
    expect(await dialog.evaluate((el) => el.parentElement === document.body && el.matches(':modal'))).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`shift-modal-${viewport.width}.png`) })
    await expect(dialog.getByLabel('เงินทอนตั้งต้นในลิ้นชัก (บาท)')).toBeFocused()
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab')
      expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('')
  })
}

test('shift validation stays inline and busy operation cannot submit background form or dismiss', async ({ page }) => {
  let requests = 0
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  await fixture(page, async () => { requests++; await pending })
  await page.getByRole('button', { name: 'Open shift' }).click()
  const dialog = page.getByRole('dialog', { name: 'จัดการกะ' })
  const cash = dialog.getByLabel('เงินทอนตั้งต้นในลิ้นชัก (บาท)')
  await cash.fill('-1')
  await dialog.getByRole('button', { name: 'เปิดกะ', exact: true }).click()
  await expect(cash).toHaveAttribute('aria-invalid', 'true')
  await expect(dialog.locator('#shift-starting-error')).toBeVisible()
  expect(requests).toBe(0)
  await cash.fill('100')
  await dialog.locator('form').evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit() })
  await expect.poll(() => requests).toBe(1)
  await expect(dialog).toHaveAttribute('aria-busy', 'true')
  await expect(dialog.getByRole('button', { name: 'ปิด', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { parentSubmits: number }).parentSubmits)).toBe(0)
  release()
  await expect(dialog.getByRole('alert')).toHaveText('Mock cash action failed')
  await expect(cash).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('nested dialogs retain scroll lock and restore focus to their own trigger', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page)
  await page.getByRole('button', { name: 'Open nested' }).click()
  const parent = page.getByRole('dialog', { name: 'Parent dialog' })
  const opener = parent.getByRole('button', { name: 'Open child' })
  await opener.click()
  const child = page.getByRole('dialog', { name: 'Child dialog' })
  await expect(child).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(child).toHaveCount(0)
  await expect(opener).toBeFocused()
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden')
  await parent.evaluate((el) => { el.scrollTop = el.scrollHeight })
  await expect(parent.getByRole('button', { name: 'Close parent' })).toBeInViewport()
  await page.keyboard.press('Escape')
  await expect(parent).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open nested' })).toBeFocused()
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('')
})
