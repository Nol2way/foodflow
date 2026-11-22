// @ts-nocheck
import assert from 'node:assert/strict';
import { test, expect } from '@playwright/test';

const origin = 'http://localhost:5173';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const restaurant = '00000000-0000-4000-8000-000000000001';
const user = '00000000-0000-4000-8000-000000000002';
const date = '2026-04-02';
const report = (day, revenue) => ({
  date: day, restaurant: 'Mock Shop', revenue, orders: 1, avg_bill: revenue,
  revenue_yesterday: 0, revenue_last_week: 0, cancelled: 0, payments: {},
  top_items: [], peak_hour: null, waste: [], expenses: 0, new_members: 0,
  points_earned: 0, points_redeemed: 0,
});
const menu = { id: 'mock-menu', name: 'Mock Menu', category_id: null, price: 100, is_available: true, sold_by_weight: false, option_choices: [{ id: 'egg', name: 'Extra egg', price: 15 }] };
const members = ['Mock Alice', 'Mock Bob'].map((name, i) => ({
  id: 'mock-member-' + i, phone: '080000000' + i, name, points: 10, created_at: date,
}));
const order = (id) => ({
  id, status: 'served', total: 100, subtotal: 100, discount_total: 0,
  created_at: date, table_id: 'mock-table', order_type: 'dine_in',
  dining_tables: { label: 'Mock Table' }, order_promotions: [],
  order_items: [{ id: id + '-item', menu_item_id: menu.id, quantity: 1, unit_price: 100, menu_items: { name: menu.name } }],
});

async function pageFor(browser, mock, role = 'owner') {
  const context = await browser.newContext({
    timezoneId: 'Asia/Bangkok',
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
  });
  await context.addInitScript(({ origin, user }) => {
    if (location.origin !== origin) return;
    localStorage.setItem('plato.session', JSON.stringify({
      access_token: 'synthetic-audit-token',
      expires_at: Date.now() + 60000,
      user: { id: user, email: 'mock@example.test', must_change_password: false },
    }));
  }, { origin, user });
  await context.routeWebSocket('**/*', (ws) => ws.close());
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const isDataRequest = path.startsWith('/rest/v1/') || path.startsWith('/api/');
    if (!isDataRequest) {
      if (url.origin === origin && request.method() === 'GET') return route.continue();
      return route.abort();
    }
    const param = (name) => url.searchParams.get(name);
    const body = () => request.postDataJSON();
    const fulfill = async (json, status = 200) => {
      await route.fulfill({
      status, json, headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      },
      });
      return true;
    };
    if (request.method() === 'OPTIONS') return fulfill({});
    if (path === '/api/readyz') return fulfill({ ok: true, schema_version: '0011' });
    if (path.endsWith('/staff_members')) return fulfill([{ restaurant_id: restaurant, role }]);
    if (path === '/rest/v1/menu_items') return fulfill([menu]);
    const result = await mock({ path, param, body, fulfill });
    if (result !== undefined) return;
    return fulfill(path.startsWith('/api/') ? {} : []);
  });
  const page = await context.newPage();
  return { page, context };
}

async function posDoubleSend(browser) {
  let submitted = 0;
  let reads = 0;
  const { page, context } = await pageFor(browser, async ({ path, param, fulfill }) => {
    if (path.endsWith('/staff_place_order')) return fulfill('mock-order-' + ++submitted);
    if (path.endsWith('/orders') && param('select') === 'total,discount_total') {
      reads++;
      await pause(1200);
      return fulfill({ total: 100, discount_total: 0 });
    }
  });
  try {
    await page.goto(origin + '/pos');
    await page.getByRole('button', { name: 'กลับบ้าน', exact: true }).click();
    await page.getByRole('button', { name: /Mock Menu/ }).click();
    const send = page.getByRole('button', { name: 'ส่งเข้าครัว', exact: true });
    await send.click();
    await expect.poll(() => reads).toBe(1);
    await expect(send).toBeDisabled();
    await pause(1500);
    assert.equal(submitted, 1);

  } finally {
    await context.close();
  }
}

async function reportDateRace(browser) {
  const older = '2026-04-01';
  const { page, context } = await pageFor(browser, async ({ path, body, fulfill }) => {
    if (!path.endsWith('/daily_report')) return;
    const day = body().p_date;
    if (day === older) await pause(900);
    return fulfill(report(day, day === older ? 111 : 222));
  });
  try {
    await page.goto(origin + '/report');
    const input = page.locator('input[type=date]');
    await input.fill(older);
    await input.fill(date);
    await expect(page.locator('pre')).toContainText('222');
    await pause(1100);
    await expect(page.locator('pre')).not.toContainText('111');
    await expect(input).toHaveValue(date);

  } finally {
    await context.close();
  }
}

async function importPreviewRace(browser) {
  let previewed = 0;
  let imported = null;
  const { page, context } = await pageFor(browser, async ({ path, body, fulfill }) => {
    if (path !== '/api/import/sales') return;
    const data = body();
    if (data.dry_run) {
      previewed++;
      await pause(800);
    } else imported = data.csv;
    return fulfill({ dry_run: data.dry_run, blocked: false, orders: 1, lines: 1, skipped_lines: 0, unknown_items: [] });
  });
  try {
    await page.goto(origin + '/import');
    const input = page.locator('input[type=file]');
    const select = (name) => input.setInputFiles({ name: name + '.csv', mimeType: 'text/csv', buffer: Buffer.from(name) });
    await select('a');
    const check = page.getByRole('button', { name: 'ตรวจไฟล์ก่อนนำเข้า', exact: true });
    await check.click();
    await expect.poll(() => previewed).toBe(1);
    await select('b');
    await pause(1000);
    await expect(page.getByText('ผลตรวจ b.csv')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'นำเข้า', exact: true })).toBeDisabled();
    assert.equal(imported, null);

  } finally {
    await context.close();
  }
}

async function memberLedgerRace(browser) {
  const { page, context } = await pageFor(browser, async ({ path, param, fulfill }) => {
    if (path.endsWith('/members')) return fulfill(members);
    if (!path.endsWith('/point_ledger')) return;
    const alice = param('member_id') === 'eq.' + members[0].id;
    if (alice) await pause(850);
    return fulfill([{ id: 'mock-ledger', change: 10, reason: 'adjust', note: alice ? 'Alice note' : 'Bob note', created_at: date }]);
  });
  try {
    await page.goto(origin + '/members');
    await page.getByText(members[0].name, { exact: true }).click();
    await page.getByText(members[1].name, { exact: true }).click();
    await expect(page.getByText(/Bob note/)).toBeVisible();
    await pause(1000);
    await expect(page.getByText(/Alice note/)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: members[1].name })).toBeVisible();

  } finally {
    await context.close();
  }
}

async function counterSettingsFailure(browser) {
  let paid;
  let receiptRequested = false;
  let settingsFailed = false;
  const { page, context } = await pageFor(browser, async ({ path, body, fulfill }) => {
    if (path.endsWith('/shop_settings')) {
      settingsFailed = true;
      return fulfill({ message: 'synthetic settings read failure' }, 500);
    }
    if (path.endsWith('/orders')) return fulfill(paid ? [] : [order('mock-order-one')]);
    if (path.endsWith('/counter_pay_bill')) {
      paid = body();
      return fulfill([]);
    }
    if (path.endsWith('/bill_receipt')) {
      receiptRequested = true;
      return fulfill({});
    }
  });
  try {
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(origin + '/counter');
    await expect.poll(() => settingsFailed).toBe(true);
    await expect(page.getByRole('button', { name: /^รับชำระ ฿/ })).toBeDisabled();
    assert.equal(paid, undefined);
    assert.equal(receiptRequested, false);

  } finally {
    await context.close();
  }
}

async function counterQuoteChanged(browser) {
  let orders = [order('mock-order-one')];
  let paid;
  const { page, context } = await pageFor(browser, async ({ path, body, fulfill }) => {
    if (path.endsWith('/shop_settings')) return fulfill({
      restaurant_id: restaurant, promptpay_id: '0812345678', loyalty_enabled: false, loyalty_point_value: 1,
    });
    if (path.endsWith('/orders')) return fulfill(paid ? [] : orders);
    if (path.endsWith('/counter_pay_bill')) {
      paid = body();
      return fulfill([]);
    }
    if (path.endsWith('/bill_receipt')) return fulfill(null);
  });
  try {
    await page.goto(origin + '/counter');
    await page.getByRole('radio', { name: 'พร้อมเพย์' }).click();
    const trigger = page.getByRole('button', { name: /แสดง QR/ });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'QR พร้อมเพย์' });
    await expect(dialog).toContainText('100');
    await expect(dialog.locator('svg')).toHaveCount(1);
    await expect(trigger).not.toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();

    await page.setViewportSize({ width: 640, height: 320 });
    const confirm = dialog.getByRole('button', { name: 'ได้รับเงินแล้ว' });
    const box = await confirm.boundingBox();
    const scroll = await dialog.evaluate((element) => getComputedStyle(element).overflowY);
    assert.equal(scroll, 'auto');
    await confirm.scrollIntoViewIfNeeded();
    await page.setViewportSize({ width: 1440, height: 900 });

    orders = [...orders, order('mock-order-two')];
    await pause(16000);
    await expect(dialog).toContainText('100');
    await expect(dialog).not.toContainText('200');
    await dialog.getByRole('button', { name: 'ได้รับเงินแล้ว' }).click();
    await expect.poll(() => paid?.p_order_ids.length).toBe(1);
    assert.equal(paid.p_expected_total, 100);
    assert.equal(paid.p_payment_method, 'promptpay');

  } finally {
    await context.close();
  }
}

async function partialAbb(browser) {
  const first = order('mock-order-one');
  const second = order('mock-order-two');
  let paid = false;
  const { page, context } = await pageFor(browser, async ({ path, body, fulfill }) => {
    if (path.endsWith('/shop_settings')) return fulfill(null);
    if (path.endsWith('/orders')) return fulfill(paid ? [] : [first, second]);
    if (path.endsWith('/counter_pay_bill')) {
      paid = true;
      return fulfill([]);
    }
    if (path.endsWith('/tax_documents')) return fulfill([{
      id: 'mock-abb', order_id: first.id, doc_type: 'ABB', status: 'confirmed',
      doc_number: 'MOCK-ABB-0001', seller_name: 'Mock Shop',
      total_amount: 100, taxable_amount: 93.46, exempt_amount: 0, vat_amount: 6.54, vat_rate: 7,
    }]);
    if (path.endsWith('/bill_receipt')) {
      const rows = body().p_order_ids.map((id) => ({
        name: id === first.id ? 'Item covered by ABB' : 'Item outside ABB',
        quantity: 1, unit_price: 100, amount: 100,
      }));
      return fulfill({
        bill_no: 'MOCKBILL', items: rows, total: rows.length * 100,
        subtotal: rows.length * 100, promotions: [],
      });
    }
  });
  try {
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(origin + '/counter');
    await expect(page.getByRole('radio', { name: 'เงินสด' })).toBeVisible();
    await page.getByRole('button', { name: /^รับชำระ ฿/ }).click();
    const receipt = page.getByRole('dialog', { name: 'ใบเสร็จ' });
    await expect(receipt).toContainText('MOCK-ABB-0001');
    await expect(receipt.locator('[data-abb]')).not.toContainText('Item outside ABB');
    await expect(receipt.locator('[data-abb]').getByText('ส่วนลด', { exact: true })).toHaveCount(0);

  } finally {
    await context.close();
  }
}

async function lateUnauthorized(browser) {
  const { page, context } = await pageFor(browser, async ({ path, fulfill }) => {
    if (path !== '/api/frontend-audit-unauthorized') return;
    await pause(700);
    return fulfill({ error: 'unauthorized' }, 401);
  });
  try {
    await page.goto(origin + '/login');
    const observed = await page.evaluate(async () => {
      const { api } = await import('/src/lib/api.ts');
      const { getSession, setSession } = await import('/src/lib/session.ts');
      const pending = api('/frontend-audit-unauthorized').catch((error) => error.status);
      setSession({
        ...getSession(), access_token: 'synthetic-new-session',
        user: { id: 'mock-new-user', email: 'new-user@example.test' },
      });
      return { status: await pending, signedOut: getSession() === null };
    });
    assert.deepEqual(observed, { status: 401, signedOut: false });

  } finally {
    await context.close();
  }
}


for (const scenario of [posDoubleSend, reportDateRace, importPreviewRace, memberLedgerRace, counterSettingsFailure, counterQuoteChanged, partialAbb, lateUnauthorized]) {
  test(scenario.name, async ({ browser }) => { await scenario(browser) });
}

test('durable retry preserves client reference after a lost acknowledgement', async ({ browser }) => {
  const references = [];
  const { page, context } = await pageFor(browser, async ({ path, body, fulfill }) => {
    if (!path.endsWith('/staff_place_order')) return;
    references.push(body().p_client_ref);
    return references.length === 1 ? fulfill({ message: 'lost acknowledgement' }, 503) : fulfill('saved-order');
  });
  try {
    await page.goto(origin + '/pos');
    const result = await page.evaluate(async ({ user, restaurant }) => {
      const queue = await import('/src/lib/orderQueue.ts');
      const row = await queue.queueOrder(user, restaurant, { p_items: [{ menu_item_id: 'mock-menu', quantity: 1 }] });
      await queue.sendQueuedOrder(row).catch(() => undefined);
      const pending = await queue.queuedOrders(user, restaurant);
      const other = await queue.queuedOrders('other-user', restaurant);
      await queue.sendQueuedOrder(pending[0]);
      return { pending: pending.length, other: other.length, remaining: (await queue.queuedOrders(user, restaurant)).length };
    }, { user, restaurant });
    assert.deepEqual(result, { pending: 1, other: 0, remaining: 0 });
    assert.equal(references.length, 2);
    assert.equal(references[0], references[1]);
  } finally { await context.close(); }
});

test('idle expired session leaves protected screen', async ({ browser }) => {
  const { page, context } = await pageFor(browser, async () => undefined);
  try {
    await page.goto(origin + '/members');
    await expect(page.getByRole('heading', { name: 'สมาชิกสะสมแต้ม' })).toBeVisible();
    await page.evaluate(() => {
      const key = 'plato.session';
      const value = JSON.stringify({ ...JSON.parse(localStorage.getItem(key)), expires_at: Date.now() + 300 });
      localStorage.setItem(key, value);
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: value, storageArea: localStorage }));
    });
    await expect(page).toHaveURL(/\/login/);
  } finally { await context.close(); }
});

test('priced option is included in preview and queued payload', async ({ browser }) => {
  let submitted;
  const { page, context } = await pageFor(browser, async ({ path, param, body, fulfill }) => {
    if (path.endsWith('/staff_place_order')) { submitted = body(); return fulfill('new-order'); }
    if (path.endsWith('/orders') && param('select') === 'total,discount_total') return fulfill({ total: 115, discount_total: 0 });
  });
  try {
    await page.goto(origin + '/pos');
    await page.getByRole('button', { name: 'กลับบ้าน', exact: true }).click();
    await page.getByRole('button', { name: /Mock Menu/ }).click();
    await page.getByRole('checkbox', { name: /Extra egg/ }).check();
    await expect(page.locator('aside.card')).toContainText('115');
    await page.getByRole('button', { name: 'ส่งเข้าครัว', exact: true }).click();
    await expect.poll(() => submitted?.p_items[0].selected_option_ids).toEqual(['egg']);
    assert.ok(submitted.p_client_ref);
  } finally { await context.close(); }
});

test('table move and bill request use selected table identities', async ({ browser }) => {
  let moved, requested;
  const { page, context } = await pageFor(browser, async ({ path, body, fulfill }) => {
    if (path.endsWith('/dining_tables')) return fulfill([{ id: 'a', label: 'Table A', floor_x: 5, floor_y: 5, zone: 'Main' }, { id: 'b', label: 'Table B', floor_x: 40, floor_y: 5, zone: 'Main' }]);
    if (path.endsWith('/table_move_orders')) { moved = body(); return fulfill(1); }
    if (path.endsWith('/table_request_bill')) { requested = body(); return fulfill(null); }
  });
  try {
    await page.goto(origin + '/tables');
    await page.getByRole('button', { name: /Table A/ }).click();
    await page.getByLabel('โต๊ะปลายทาง').selectOption('b');
    await page.getByRole('button', { name: 'ย้าย / รวมออเดอร์' }).click();
    await expect.poll(() => moved?.p_target_table_id).toBe('b');
    assert.equal(moved.p_source_table_id, 'a');
    await page.getByRole('button', { name: 'ขอเช็คบิล' }).click();
    await expect.poll(() => requested?.p_table_id).toBe('a');
  } finally { await context.close(); }
});

test('received order editor saves quantity and note', async ({ browser }) => {
  let edited;
  const fixture = { ...order('edit-me'), status: 'received' };
  const { page, context } = await pageFor(browser, async ({ path, body, fulfill }) => {
    if (path.endsWith('/orders')) return fulfill([fixture]);
    if (path.endsWith('/staff_edit_order')) { edited = body(); return fulfill('edit-me'); }
  });
  try {
    await page.goto(origin + '/bills');
    await page.getByLabel('สถานะ').selectOption('received');
    await page.locator('article summary').first().click();
    await page.getByRole('button', { name: 'แก้ไขรายการ' }).click();
    const dialog = page.getByRole('dialog', { name: 'แก้ไขออเดอร์ก่อนครัวรับ' });
    await dialog.getByLabel('จำนวน', { exact: true }).fill('3');
    await dialog.getByLabel('หมายเหตุรายการ', { exact: true }).fill('No chilli');
    await dialog.getByRole('button', { name: 'บันทึกออเดอร์' }).click();
    await expect.poll(() => edited?.p_items[0].quantity).toBe(3);
    assert.equal(edited.p_items[0].note, 'No chilli');
  } finally { await context.close(); }
});

test('kitchen ticket renders option snapshot without current menu prices', async ({ browser }) => {
  const fixture = order('ticket'); fixture.status = 'received';
  fixture.order_items[0].options_snapshot = [{ id: 'historic-option', name: 'Historic choice', price: 7 }];
  const { page, context } = await pageFor(browser, async ({ path, fulfill }) => {
    if (path.endsWith('/orders')) return fulfill([fixture]);
    if (path.endsWith('/shop_settings')) return fulfill(null);
  });
  try {
    await page.goto(origin + '/kitchen');
    await page.getByRole('button', { name: 'พิมพ์ใบงานครัว' }).click();
    const ticket = page.getByRole('dialog', { name: 'ใบงานครัว 80 มม.' });
    await expect(ticket).toContainText('Historic choice');
    await expect(ticket).toContainText('Mock Table');
  } finally { await context.close(); }
});

test('member lookup cannot attach the phone edited while pending', async ({ browser }) => {
  let lookup = false;
  const { page, context } = await pageFor(browser, async ({ path, fulfill }) => {
    if (path.endsWith('/orders')) return fulfill([order('member-bill')]);
    if (path.endsWith('/shop_settings')) return fulfill({ restaurant_id: restaurant, loyalty_enabled: true, loyalty_point_value: 1, loyalty_min_redeem: 1, loyalty_baht_per_point: 10 });
    if (path.endsWith('/member_find')) { lookup = true; await pause(700); return fulfill([members[0]]); }
  });
  try {
    await page.goto(origin + '/counter');
    const phone = page.getByLabel('เบอร์สมาชิก', { exact: true });
    await phone.fill('0800000000');
    await page.getByRole('button', { name: 'ค้นหา', exact: true }).click();
    await expect.poll(() => lookup).toBe(true);
    await phone.fill('0800000001');
    await pause(900);
    await expect(phone).toHaveValue('0800000001');
    await expect(page.getByText('Mock Alice', { exact: false })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'สมัครสมาชิก' })).toHaveCount(0);
  } finally { await context.close(); }
});

test('incomplete promotion links block checkout', async ({ browser }) => {
  const { page, context } = await pageFor(browser, async ({ path, fulfill }) => {
    if (path.endsWith('/orders')) return fulfill([order('promo-bill')]);
    if (path.endsWith('/shop_settings')) return fulfill(null);
    if (path.endsWith('/promotion_items')) return fulfill({ message: 'link read failed' }, 500);
  });
  try {
    await page.goto(origin + '/counter');
    await expect(page.getByRole('button', { name: /^รับชำระ ฿/ })).toBeDisabled();
    await expect(page.getByText(/โหลดโปรโมชันไม่ครบ/)).toBeVisible();
  } finally { await context.close(); }
});

test('stock filter failure removes earlier reversible rows', async ({ browser }) => {
  const { page, context } = await pageFor(browser, async ({ path, param, fulfill }) => {
    if (path === '/api/stock/ingredients') return fulfill({ ingredients: [] });
    if (path === '/api/stock/history') {
      if (param('type')) { await pause(500); return fulfill({ message: 'filter unavailable' }, 500); }
      return fulfill({ movements: [{ id: 'movement', ingredient_name: 'Old ingredient', type: 'receive', change: 1, unit: 'kg', created_at: date, cost: 10 }] });
    }
  });
  try {
    await page.goto(origin + '/stock-history');
    await expect(page.getByText('Old ingredient')).toBeVisible();
    await page.getByLabel(/^ประเภท/).selectOption('count_adjust');
    await expect(page.getByText('Old ingredient')).toHaveCount(0);
    await pause(700);
    await expect(page.getByRole('button', { name: 'กลับรายการ', exact: true })).toHaveCount(0);
  } finally { await context.close(); }
});

test('English and dark preferences persist without translating customer data', async ({ browser }) => {
  const { page, context } = await pageFor(browser, async ({ path, fulfill }) => {
    if (path.endsWith('/shop_settings')) return fulfill(null);
  });
  try {
    await page.goto(origin + '/settings');
    await page.locator('#rh').fill('ร้านข้าวของคุณแม่');
    await page.getByLabel(/^ภาษา/).selectOption('en');
    await expect(page.getByRole('heading', { name: 'Shop settings', exact: true })).toBeVisible();
    await expect(page.locator('#rh')).toHaveValue('ร้านข้าวของคุณแม่');
    await page.getByLabel(/^Theme/).selectOption('dark');
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.reload();
    await expect(page.getByLabel(/^Language/)).toHaveValue('en');
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(page.locator('body')).toHaveCSS('color', 'rgb(0, 0, 0)');
  } finally { await context.close(); }
});

test('a late display token response cannot replace the revoked next token', async ({ browser }) => {
  let release, started = false;
  const pending = new Promise((resolve) => { release = resolve; });
  const { page, context } = await pageFor(browser, async ({ path, body, fulfill }) => {
    if (!path.endsWith('/display_content')) return;
    if (body().p_token === 'old') {
      started = true; await pending;
      return fulfill({ restaurant: 'Old shop', items: [{ id: 'item', name: 'Old item', price: 10, media: [] }], ads: [], promotions: [] });
    }
    return fulfill(null);
  });
  try {
    await page.goto(origin + '/display/old');
    await expect.poll(() => started).toBe(true);
    await page.evaluate(() => { history.pushState({}, '', '/display/revoked'); window.dispatchEvent(new PopStateEvent('popstate')); });
    await expect(page.getByText(/ลิงก์จอแสดงผลนี้ใช้ไม่ได้แล้ว/)).toBeVisible();
    release();
    await pause(300);
    await expect(page.getByText(/ลิงก์จอแสดงผลนี้ใช้ไม่ได้แล้ว/)).toBeVisible();
    await expect(page.getByText('Old shop')).toHaveCount(0);
  } finally { release(); await context.close(); }
});

test('a table with 51 tickets is payable in batches within the RPC cap', async ({ browser }) => {
  let paid;
  const { page, context } = await pageFor(browser, async ({ path, body, fulfill }) => {
    if (path.endsWith('/orders')) return fulfill(paid ? [order('ticket-50')] : Array.from({ length: 51 }, (_, i) => order(`ticket-${i}`)));
    if (path.endsWith('/shop_settings')) return fulfill(null);
    if (path.endsWith('/counter_pay_bill')) { paid = body(); return fulfill([]); }
    if (path.endsWith('/bill_receipt')) return fulfill(null);
  });
  try {
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(origin + '/counter');
    const buttons = page.getByRole('button', { name: /^รับชำระ ฿/ });
    await expect(buttons).toHaveCount(2);
    await buttons.first().click();
    await expect.poll(() => paid?.p_order_ids.length).toBe(50);
    assert.equal(paid.p_expected_total, 5000);
  } finally { await context.close(); }
});

test('coupon is excluded from auto selection and replaces conflicting promotions after code entry', async ({ browser }) => {
  const automatic = { id: 'auto', name: 'Automatic discount', discount_type: 'amount', value: 10, min_subtotal: 0, stackable: true };
  const coupon = { id: 'coupon', name: 'Secret coupon', coupon_code: 'SECRET', discount_type: 'amount', value: 30, min_subtotal: 0, stackable: false };
  let paid;
  const { page, context } = await pageFor(browser, async ({ path, body, fulfill }) => {
    if (path.endsWith('/orders')) return fulfill(paid ? [] : [order('coupon-order')]);
    if (path.endsWith('/shop_settings')) return fulfill(null);
    if (path.endsWith('/promotions') || path.endsWith('/promotions_available')) return fulfill([automatic, coupon]);
    if (path.endsWith('/coupon_lookup')) { assert.equal(body().p_code, 'SECRET'); return fulfill(coupon); }
    if (path.endsWith('/counter_pay_bill')) { paid = body(); return fulfill([]); }
    if (path.endsWith('/bill_receipt')) return fulfill(null);
  });
  try {
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(origin + '/counter');
    await expect(page.getByRole('button', { name: /Automatic discount/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: /Secret coupon/ })).toHaveCount(0);
    await page.getByLabel('รหัสคูปอง', { exact: true }).fill('secret');
    await page.getByRole('button', { name: 'ใช้คูปอง', exact: true }).click();
    await expect(page.getByRole('button', { name: /Secret coupon/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: /Automatic discount/ })).toBeDisabled();
    await page.getByRole('button', { name: /^รับชำระ ฿/ }).click();
    await expect.poll(() => paid?.p_promotion_ids).toEqual(['coupon']);
    assert.equal(paid.p_expected_total, 70);
  } finally { await context.close(); }
});

test('last four digits require an explicit member choice', async ({ browser }) => {
  const { page, context } = await pageFor(browser, async ({ path, body, fulfill }) => {
    if (path.endsWith('/orders')) return fulfill([order('ambiguous-member')]);
    if (path.endsWith('/shop_settings')) return fulfill({ restaurant_id: restaurant, loyalty_enabled: true, loyalty_point_value: 1, loyalty_min_redeem: 1, loyalty_baht_per_point: 10 });
    if (path.endsWith('/member_find')) { assert.equal(body().p_phone, '0000'); return fulfill(members); }
  });
  try {
    await page.goto(origin + '/counter');
    await page.getByLabel('เบอร์สมาชิก', { exact: true }).fill('0000');
    await page.getByRole('button', { name: 'ค้นหา', exact: true }).click();
    await expect(page.getByText('พบหลายคน โปรดยืนยันสมาชิกก่อนเลือก')).toBeVisible();
    await expect(page.getByRole('button', { name: /ใช้สูงสุด/ })).toHaveCount(0);
    await page.getByRole('button', { name: /Mock Bob.*0800000001/ }).click();
    await expect(page.getByRole('button', { name: /ใช้สูงสุด/ })).toBeVisible();
    await expect(page.getByText('พบหลายคน โปรดยืนยันสมาชิกก่อนเลือก')).toHaveCount(0);
    await expect(page.getByText(/สมาชิก Mock Bob/)).toBeVisible();
  } finally { await context.close(); }
});

test('member export and deletion are offered only to the owner', async ({ browser }) => {
  let exported, deleted;
  const mock = async ({ path, body, fulfill }) => {
    if (path.endsWith('/members')) return fulfill(deleted ? [] : members);
    if (path.endsWith('/member_export')) { exported = body(); return fulfill({ member: members[0], ledger: [] }); }
    if (path.endsWith('/member_delete')) { deleted = body(); return fulfill({ deleted: true }); }
  };
  const manager = await pageFor(browser, mock, 'manager');
  try {
    await manager.page.goto(origin + '/members');
    await manager.page.getByRole('button', { name: members[0].phone, exact: true }).click();
    await expect(manager.page.getByRole('button', { name: 'ส่งออกข้อมูลสมาชิก' })).toHaveCount(0);
    await expect(manager.page.getByRole('button', { name: 'ลบข้อมูลสมาชิก' })).toHaveCount(0);
  } finally { await manager.context.close(); }
  const { page, context } = await pageFor(browser, mock);
  try {
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(origin + '/members');
    await page.getByRole('button', { name: members[0].phone, exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'ส่งออกข้อมูลสมาชิก' }).click();
    await download;
    assert.equal(exported.p_member_id, members[0].id);
    await page.getByRole('button', { name: 'ลบข้อมูลสมาชิก' }).click();
    await expect.poll(() => deleted?.p_member_id).toBe(members[0].id);
    await expect(page.getByRole('heading', { name: 'Mock Alice' })).toHaveCount(0);
  } finally { await context.close(); }
});

test('xlsx preview sends exact bytes and changing options requires a new preview', async ({ browser }) => {
  const calls = [];
  const bytes = Buffer.from([80, 75, 3, 4, 0, 255]);
  const { page, context } = await pageFor(browser, async ({ path, body, fulfill }) => {
    if (path !== '/api/import/sales') return;
    const request = body(); calls.push(request);
    if (!request.dry_run) await pause(400);
    return fulfill({ batch_id: request.dry_run ? null : 'batch-xlsx', preview_token: 'preview-' + calls.length, dry_run: request.dry_run, blocked: false, orders: 1, lines: 1, skipped_lines: 0, unknown_items: [] });
  });
  try {
    await page.goto(origin + '/import');
    const file = page.locator('input[type=file]');
    await file.setInputFiles({ name: 'sales.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes });
    await page.getByRole('button', { name: 'ตรวจไฟล์ก่อนนำเข้า', exact: true }).click();
    const commit = page.getByRole('button', { name: 'นำเข้า', exact: true });
    await expect(commit).toBeEnabled();
    assert.equal(calls[0].xlsx_base64, bytes.toString('base64'));
    assert.equal(calls[0].csv, undefined);
    await page.getByRole('checkbox').check();
    await expect(commit).toBeDisabled();
    await page.getByRole('button', { name: 'ตรวจไฟล์ก่อนนำเข้า', exact: true }).click();
    await expect(commit).toBeEnabled();
    await commit.click();
    await expect(file).toBeDisabled();
    await expect(page.getByRole('checkbox')).toBeDisabled();
    await expect.poll(() => calls.length).toBe(3);
    assert.equal(calls[2].preview_token, 'preview-2');
    assert.equal(calls[2].skip_unknown, true);
    assert.equal(calls[2].xlsx_base64, bytes.toString('base64'));
    await expect(page.getByText('batch-xlsx')).toBeVisible();
  } finally { await context.close(); }
});

test('feedback guards duplicate clicks and retries the same intent and rating', async ({ browser }) => {
  const ratings = []; let paid = false;
  const { page, context } = await pageFor(browser, async ({ path, body, fulfill }) => {
    if (path.endsWith('/orders')) return fulfill(paid ? [] : [order('feedback')]);
    if (path.endsWith('/shop_settings')) return fulfill(null);
    if (path.endsWith('/counter_pay_bill')) { paid = true; return fulfill([]); }
    if (path.endsWith('/bill_receipt')) return fulfill(null);
    if (path.endsWith('/submit_feedback')) { ratings.push(body()); await pause(300); return ratings.length === 1 ? fulfill({ message: 'lost acknowledgement' }, 503) : fulfill({ ok: true }); }
  });
  try {
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(origin + '/counter');
    await page.getByRole('button', { name: /^รับชำระ ฿/ }).click();
    await page.getByRole('dialog', { name: 'ใบเสร็จ' }).getByRole('button', { name: 'ปิด', exact: true }).click();
    await page.getByRole('button', { name: '5 ดาว', exact: true }).evaluate((button) => { button.click(); button.click(); });
    await expect(page.getByText('ส่งคะแนนไม่สำเร็จ ลองอีกครั้งได้')).toBeVisible();
    assert.equal(ratings.length, 1);
    await expect(page.getByRole('button', { name: '4 ดาว', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '5 ดาว', exact: true }).click();
    await expect(page.getByText('ขอบคุณสำหรับความคิดเห็น')).toBeVisible();
    assert.equal(ratings.length, 2);
    assert.equal(ratings[0].p_client_ref, ratings[1].p_client_ref);
    assert.equal(ratings[1].p_rating, 5);
  } finally { await context.close(); }
});

test('audit history paginates with the oldest loaded event cursor', async ({ browser }) => {
  const calls = [];
  const row = (id) => ({ id, created_at: date, actor_id: user, action: 'update', entity: 'order', record_id: 'record-' + id, details: { changed: ['status'] } });
  const { page, context } = await pageFor(browser, async ({ path, body, fulfill }) => {
    if (!path.endsWith('/audit_events')) return;
    calls.push(body());
    return fulfill(body().p_before === null ? Array.from({ length: body().p_limit }, (_, i) => row(200 - i)) : [row(190), row(189)]);
  });
  try {
    await page.goto(origin + '/audit');
    await expect(page.locator('tbody tr')).toHaveCount(10);
    await page.getByRole('button', { name: 'ถัดไป', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(2);
    assert.equal(calls.at(-1).p_before, 191);
    assert.equal(calls.at(-1).p_limit, 11);
    await expect(page.getByRole('button', { name: 'ถัดไป', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'ก่อนหน้า', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(10);
    assert.equal(calls.at(-1).p_before, null);
  } finally { await context.close(); }
});

test('English main workflow translates payment and status controls without changing table names', async ({ browser }) => {
  const fixture = order('english-order'); fixture.dining_tables.label = 'โต๊ะคุณแม่';
  const { page, context } = await pageFor(browser, async ({ path, fulfill }) => {
    if (path.endsWith('/orders')) return fulfill([fixture]);
    if (path.endsWith('/shop_settings')) return fulfill(null);
    if (path === '/api/auth/login') { await pause(500); return fulfill({ error: 'invalid_credentials' }, 401); }
  });
  try {
    await page.goto(origin + '/counter');
    await page.evaluate(async () => { const { setPreferences } = await import('/src/lib/preferences.ts'); setPreferences({ language: 'en' }); });
    await expect(page.getByRole('radio', { name: 'Cash', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Receive payment ฿/ })).toBeVisible();
    await expect(page.getByText('Served', { exact: true })).toBeVisible();
    await expect(page.getByText('โต๊ะคุณแม่', { exact: true })).toBeVisible();
    await page.goto(origin + '/kitchen');
    await expect(page.getByRole('heading', { name: /New orders/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Preparing/ })).toBeVisible();
    await page.goto(origin + '/pos');
    await expect(page.getByRole('button', { name: 'Takeaway', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send to kitchen', exact: true })).toBeVisible();
    await page.goto(origin + '/login');
    await page.locator('input[type=email]').fill('test@example.test');
    await page.locator('input[type=password]').fill('synthetic-test-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Working...', exact: true })).toBeDisabled();
    await expect(page.getByText('Incorrect email or password')).toBeVisible();
  } finally { await context.close(); }
});

test('split orders can be paid separately without applying allocated discounts twice', async ({ browser }) => {
  let paid;
  const split = ['split-a', 'split-b'].map((id) => ({ ...order(id), total: 80, discount_total: 20 }));
  const { page, context } = await pageFor(browser, async ({ path, body, fulfill }) => {
    if (path.endsWith('/orders')) return fulfill(paid ? split.filter((o) => !paid.p_order_ids.includes(o.id)) : split);
    if (path.endsWith('/shop_settings')) return fulfill(null);
    if (path.endsWith('/counter_pay_bill')) { paid = body(); return fulfill([]); }
    if (path.endsWith('/bill_receipt')) return fulfill(null);
  });
  try {
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(origin + '/counter');
    await page.getByRole('checkbox', { name: 'แยกชำระรายออเดอร์ (คงส่วนลดเดิม)' }).check();
    const pay = page.getByRole('button', { name: 'รับชำระ ฿80', exact: true });
    await expect(pay).toHaveCount(2);
    await pay.first().click();
    await expect.poll(() => paid?.p_order_ids.length).toBe(1);
    assert.equal(paid.p_expected_total, 80);
    assert.equal(paid.p_promotion_ids, null);
  } finally { await context.close(); }
});

test('bill history replaces compact pages with stable cursors and resets for exact ID searches', async ({ browser }) => {
  const calls = [];
  const exact = '00000000-0000-4000-8000-000000000099';
  const { page, context } = await pageFor(browser, async ({ path, param, fulfill }) => {
    if (!path.endsWith('/orders')) return;
    calls.push({ cursor: param('or'), ordering: param('order'), id: param('id'), customer: param('customer_label') });
    if (param('id')) return fulfill([{ ...order(exact), status: 'paid' }]);
    if (param('customer_label')) return fulfill([]);
    return fulfill(param('or') ? [{ ...order('older-bill'), status: 'paid' }] : Array.from({ length: Number(param('limit')) }, (_, i) => ({ ...order('bill-' + i), status: 'paid' })));
  });
  try {
    await page.goto(origin + '/bills');
    await expect(page.locator('article')).toHaveCount(10);
    await expect(page.locator('article details[open]')).toHaveCount(0);
    expect((await page.locator('.history-scroll').boundingBox()).height).toBeLessThanOrEqual(585);
    await page.getByRole('button', { name: 'ถัดไป', exact: true }).click();
    await expect(page.locator('article')).toHaveCount(1);
    assert.equal(calls.at(-1).ordering, 'created_at.desc,id.desc');
    assert.ok(calls.at(-1).cursor.includes('id.lt.bill-9'));
    await page.getByRole('button', { name: 'ก่อนหน้า', exact: true }).click();
    await expect(page.locator('article')).toHaveCount(10);
    assert.equal(calls.at(-1).cursor, null);
    await page.getByLabel('แบ่งหน้าบิล: ต่อหน้า', { exact: true }).selectOption('20');
    await expect(page.locator('article')).toHaveCount(20);
    const search = page.getByLabel('ค้นหาเลขออเดอร์หรือชื่อลูกค้า');
    await search.fill(exact);
    await expect(page.locator('article')).toHaveCount(1);
    assert.equal(calls.at(-1).id, 'eq.' + exact);
    assert.equal(calls.at(-1).cursor, null);
    await search.fill('Alice');
    await expect(page.locator('article')).toHaveCount(0);
    assert.equal(calls.at(-1).customer, 'ilike.%Alice%');
  } finally { await context.close(); }
});

test('member pages are bounded and filtering resets the server offset', async ({ browser }) => {
  const calls = [];
  const { page, context } = await pageFor(browser, async ({ path, param, fulfill }) => {
    if (!path.endsWith('/members')) return;
    const offset = Number(param('offset') ?? 0);
    calls.push(offset);
    const list = Array.from({ length: 25 }, (_, i) => ({ id: 'member-' + i, phone: '08000000' + String(i).padStart(2, '0'), name: 'Member ' + i, points: 10, created_at: date }));
    return fulfill(list.slice(offset, offset + Number(param('limit') ?? 11)));
  });
  try {
    await page.goto(origin + '/members');
    await expect(page.locator('tbody tr')).toHaveCount(10);
    await page.getByRole('button', { name: 'ถัดไป', exact: true }).click();
    await expect.poll(() => calls.at(-1)).toBe(10);
    await expect(page.locator('tbody tr').first()).toContainText('Member 10');
    await page.getByLabel('ค้นหาเบอร์โทรหรือชื่อ', { exact: true }).fill('Member');
    await expect.poll(() => calls.at(-1)).toBe(0);
    await expect(page.locator('tbody tr')).toHaveCount(10);
  } finally { await context.close(); }
});

test('table map preserves zero coordinates and guards same-frame duplicate bill requests', async ({ browser }) => {
  let requests = 0;
  const { page, context } = await pageFor(browser, async ({ path, fulfill }) => {
    if (path.endsWith('/dining_tables')) return fulfill([
      { id: 'a', label: 'Table A', floor_x: 40, floor_y: 0, zone: 'Main', seats: 4 },
      { id: 'b', label: 'Table B', floor_x: 0, floor_y: 40, zone: 'Main', seats: 4 },
    ]);
    if (path.endsWith('/table_request_bill')) { requests++; await pause(300); return fulfill(null); }
  });
  try {
    await page.goto(origin + '/tables');
    const table = page.getByRole('button', { name: /Table B/ });
    await expect(table).toHaveCSS('left', '0px');
    await table.click();
    await page.getByRole('button', { name: 'ขอเช็คบิล', exact: true }).evaluate((button) => { button.click(); button.click(); });
    await expect.poll(() => requests).toBe(1);
    await pause(400);
    assert.equal(requests, 1);
  } finally { await context.close(); }
});
