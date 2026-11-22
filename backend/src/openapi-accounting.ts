// เอกสาร OpenAPI ของโมดูลบัญชี (รวมเข้า openapi.ts) · route อยู่ที่ src/accounting.ts

const uuid = { type: 'string', format: 'uuid' } as const
const date = { type: 'string', format: 'date', examples: ['2026-10-26'] } as const
const money = { type: 'number', description: 'บาท' } as const
const bearer = [{ bearerAuth: [] }]
const errRef = { $ref: '#/components/schemas/Error' }
const json = (schema: object) => ({ 'application/json': { schema } })
const q = (name: string, schema: object, description: string, required = true) => ({ name, in: 'query', required, schema, description })
const restaurant = q('restaurant_id', uuid, 'ร้านที่ทำรายการ')
const from = q('from', date, 'วันที่เริ่ม (เวลาร้าน) YYYY-MM-DD')
const to = q('to', date, 'วันที่สิ้นสุด (รวมวันนั้น) ไม่เกิน 10 ปีจาก from')
const path = (name: string, description: string) => ({ name, in: 'path', required: true, schema: uuid, description })

const errors = (extra: Record<string, string> = {}) => ({
  '400': { description: 'ข้อมูลไม่ถูกต้อง (เช่น invalid_range, invalid_date, reason_required)', content: json(errRef) },
  '401': { description: 'ไม่ได้ล็อกอิน', content: json(errRef) },
  '403': { description: 'บทบาทไม่พอ', content: json(errRef) },
  ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { description: v, content: json(errRef) }])),
})
const ok = (description: string, schema: object, status = '200') => ({ [status]: { description, content: json(schema) } })
const body = (schema: object) => ({ required: true, content: json(schema) })
const op = (summary: string, who: string, operationId: string, rest: object, tag = 'บัญชี') => ({
  tags: [tag],
  summary,
  description: `สิทธิ์: ${who}`,
  operationId,
  security: bearer,
  ...rest,
})

const READ = 'เจ้าของ ผู้จัดการ พนักงานบัญชี'
const WRITE = 'เจ้าของ พนักงานบัญชี'

export const accountingTag = {
  name: 'บัญชี',
  description: [
    'บัญชีคู่ (double-entry) ลงอัตโนมัติจากบิล สต็อก และรายจ่าย · เดบิต = เครดิต ทุกรายการ · ลงแล้วแก้ไม่ได้ ใช้กลับรายการ',
    'แสดงผล 3 โหมดจากข้อมูลชุดเดียวกัน (ง่าย / มาตรฐาน / มืออาชีพ)',
    '**ไม่ใช่เครื่องมือยื่นภาษีอย่างเป็นทางการ ควรให้นักบัญชีตรวจ**',
  ].join('\n'),
}

export const taxTag = {
  name: 'ภาษีกรมสรรพากร',
  description: [
    'เอกสารภาษี ABB (ใบกำกับภาษีอย่างย่อ) · TAX (ใบเสร็จรับเงิน/ใบกำกับภาษี) · CN (ใบลดหนี้) · รายงานภาษีรายเดือน · กะแคชเชียร์',
    'สร้างฉบับร่าง → ยืนยันเอง: ออกเลขที่ต่อเนื่องไม่ขาดช่วง (ประเภท-เครื่อง-YYYYMM-NNNNNN) + สร้าง XML ETDA ขมธอ.3-2560 v2.0 (TypeCode TAX=T03 · ABB=T05 · CN=81) เก็บไว้ดาวน์โหลด',
    'VAT แยกจากยอดรวม: ROUND((ยอดรวม - ยกเว้น) x 7 / 107, 2) · ไม่มีการเรียก API ภายนอก',
    '**ไม่ใช่การยื่นภาษีอย่างเป็นทางการ ควรให้นักบัญชีตรวจ และตรวจ XML กับ XSD ก่อนใช้งานจริง**',
  ].join('\n'),
}

const TAX_ISSUE = 'เจ้าของ ผู้จัดการ พนักงานบัญชี พนักงาน (ใบลดหนี้: ไม่รวมพนักงาน)'
const SHIFT_WHO = 'เจ้าของ ผู้จัดการ พนักงาน (พนักงานเฉพาะกะของตัวเอง)'
const month = q('month', { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$', examples: ['2026-11'] }, 'เดือนภาษี YYYY-MM')
const reportFormat = q('format', { enum: ['json', 'csv'], default: 'json' }, 'csv = UTF-8 BOM พร้อมหัวรายงานผู้ประกอบการ', false)
const reportResponses = (description: string, schema: object) => ({
  '200': { description, content: { ...json(schema), 'text/csv': { schema: { type: 'string' } } } },
  ...errors(),
})

export const accountingSchemas = {
  TaxDocument: {
    type: 'object',
    properties: {
      id: uuid, order_id: uuid, ref_document_id: { type: ['string', 'null'], format: 'uuid' },
      doc_type: { enum: ['ABB', 'TAX', 'CN'] },
      doc_number: { type: ['string', 'null'], examples: ['ABB-POS01-202611-000001'] },
      status: { enum: ['draft', 'confirmed', 'voided'] },
      terminal_code: { type: ['string', 'null'] }, pos_reg_no: { type: ['string', 'null'] },
      buyer_name: { type: ['string', 'null'] }, buyer_tax_id: { type: ['string', 'null'] }, buyer_branch_code: { type: ['string', 'null'] },
      vat_rate: { type: 'number' }, taxable_amount: money, exempt_amount: money,
      vat_amount: { ...money, description: 'ROUND((total - exempt) x rate / (100 + rate), 2)' }, total_amount: money,
      credit_note_reason: { type: ['string', 'null'] }, issue_date: { type: ['string', 'null'], format: 'date' },
      created_by_name: { type: ['string', 'null'] }, created_at: { type: 'string' },
      confirmed_by_name: { type: ['string', 'null'] }, confirmed_at: { type: ['string', 'null'] },
      has_xml: { type: 'boolean' },
    },
  },
  TaxSeller: {
    type: ['object', 'null'],
    properties: { company_name: { type: 'string' }, tax_id: { type: 'string' }, branch_code: { type: 'string' }, registered_address: { type: 'string' } },
  },
  ZReport: {
    type: 'object',
    properties: {
      shift_id: uuid, cashier: { type: 'string' }, closed_by: { type: ['string', 'null'] }, opened_at: { type: 'string' }, closed_at: { type: 'string' },
      starting_cash: money, cash_sales: money, cash_in: money, cash_out: money,
      expected_cash: { ...money, description: 'เงินทอนตั้งต้น + ขายเงินสด + เงินเข้า - เงินออก' },
      actual_cash: money, variance_cash: { ...money, description: 'นับจริง - ที่ควรมี' }, cash_status: { enum: ['balanced', 'over', 'short'] },
      sales_by_method: { type: 'array', items: { type: 'object', properties: { method: { type: 'string' }, bills: { type: 'integer' }, total: money } } },
      total_bills: { type: 'integer' }, total_sales: money, cancelled_after_paid: { type: 'integer' },
      tax_documents: { type: 'object', description: 'ช่วงเลขที่ต่อประเภท (abb/tax/cn: count, first, last) + vat_total, gross_total' },
      drawer_logs: { type: 'array', items: { type: 'object' } },
      note: { type: ['string', 'null'] },
    },
  },
  AcctSummary: {
    type: 'object',
    description: 'ยอดดิบของช่วงวันที่จากสมุดรายวัน (acct_summary_data)',
    properties: {
      from: date, to: date,
      sales: { ...money, description: 'ยอดขายก่อนหักส่วนลด (ไม่รวม VAT)' },
      sales_by_account: { type: 'array', items: { $ref: '#/components/schemas/AcctAmount' } },
      discounts: { ...money, description: 'ส่วนลดโปรโมชัน + แต้ม' },
      other_income: money,
      cogs_recipe: { ...money, description: 'ต้นทุนขายตามสูตร (5010)' },
      stock_variance: { ...money, description: 'ส่วนต่างสต็อก: นับ ของเสีย ผลิต ปรับมูลค่า (5020)' },
      food_cost: { ...money, description: 'ต้นทุนอาหารที่ใช้จริงรวม (กลุ่ม food_cost)' },
      labor: money, opex: money,
      expenses_by_account: { type: 'array', items: { $ref: '#/components/schemas/AcctAmount' } },
      cash_open: money, cash_close: money, cash_in: money, cash_out: money,
      cash_drawer: { ...money, description: 'เงินสดในลิ้นชักตามบัญชี (ไม่รวมธนาคาร)' },
      cash_by_source: { type: 'array', items: { type: 'object', properties: { source_type: { type: 'string' }, in: money, out: money } } },
      stock_open: money, stock_close: money,
      stock_in: { ...money, description: 'รับเข้า (ใบรับของ + ยอดยกมา)' },
      vat_output: money, vat_input: money,
      bills: { type: 'integer' }, cancelled_bills: { type: 'integer' },
    },
  },
  AcctAmount: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' }, grp: { type: 'string' }, amount: money } },
  AcctMetrics: {
    type: 'object',
    properties: {
      netSales: money, foodCost: money, cogsActual: { ...money, description: 'ตามสูตร + ส่วนต่างสต็อก' },
      grossProfit: money, labor: money, opex: money, expenses: money, netProfit: money,
      foodCostPct: { type: ['number', 'null'], description: 'ต้นทุนอาหาร / ยอดขายสุทธิ x 100 (เป้า 28–35%)' },
      primeCostPct: { type: ['number', 'null'], description: '(ต้นทุนอาหาร + ค่าแรง) / ยอดขายสุทธิ x 100 (เป้า 60–65%)' },
      netMarginPct: { type: ['number', 'null'] },
    },
  },
  AcctAlert: { type: 'object', properties: { level: { enum: ['info', 'warn', 'danger'] }, code: { type: 'string' }, text: { type: 'string' } } },
  AcctReconcile: {
    type: 'object',
    properties: {
      stock_value: { ...money, description: 'มูลค่าสต็อกจากโมดูลสต็อก Σ round(คงเหลือ x ต้นทุนต่อหน่วย, 2)' },
      ledger_value: { ...money, description: 'ยอดบัญชีสต็อกวัตถุดิบ (1130)' },
      difference: money,
      ok: { type: 'boolean' },
    },
  },
  AcctSettings: {
    type: 'object',
    properties: {
      accounting_mode: { enum: ['simple', 'standard', 'pro'] },
      business_type: { enum: ['individual', 'company'] },
      vat_registered: { type: 'boolean' },
      vat_rate: { type: 'number' },
      receipt_payment_default: { enum: ['cash', 'bank', 'credit'], description: 'ใบรับของจ่ายด้วยอะไร (credit = ค้างเจ้าหนี้)' },
      food_cost_target_min: { type: 'number' }, food_cost_target_max: { type: 'number' },
      prime_cost_target_min: { type: 'number' }, prime_cost_target_max: { type: 'number' },
      onboarded: { type: 'boolean' },
    },
  },
  JournalRow: {
    type: 'object',
    properties: {
      entry_id: uuid, entry_no: { type: 'integer' }, entry_date: date,
      source_type: { enum: ['bill', 'stock_receipt', 'recipe_deduct', 'count_adjust', 'expense', 'reversal', 'day_close', 'waste', 'production', 'stock_revalue', 'supplier_claim', 'supplier_payment', 'opening'] },
      source_id: { type: ['string', 'null'] }, memo: { type: ['string', 'null'] }, reason: { type: ['string', 'null'] },
      reverses_entry_id: { type: ['string', 'null'] }, created_at: { type: 'string' }, created_by_name: { type: ['string', 'null'] },
      line_id: { type: 'integer' }, account_code: { type: 'string' }, account_name: { type: 'string' }, debit: money, credit: money,
      line_memo: { type: ['string', 'null'] },
    },
  },
  TrialRow: {
    type: 'object',
    properties: {
      account_id: uuid, code: { type: 'string' }, name: { type: 'string' },
      type: { enum: ['asset', 'liability', 'equity', 'revenue', 'expense'] }, grp: { type: 'string' },
      opening: money, debit: money, credit: money, closing: { ...money, description: 'เดบิต - เครดิต (บวก = ยอดดุลเดบิต)' },
    },
  },
}

const summaryRef = { $ref: '#/components/schemas/AcctSummary' }
const metricsRef = { $ref: '#/components/schemas/AcctMetrics' }

export const accountingPaths = {
  '/api/accounting/dashboard': {
    get: op('แดชบอร์ดบัญชี (วันนี้ / 7 วัน / 30 วัน / เดือนนี้ / เดือนก่อน / ทั้งปี)', READ, 'accountingDashboard', {
      description: `สิทธิ์: ${READ}\n\nรวมผลกระทบยอดสต็อก แจ้งเตือน (สต็อกไม่ตรงบัญชี เกณฑ์ VAT 1.8 ล้าน Food/Prime Cost เกินเป้า ยังไม่ปิดวัน) และเปรียบเทียบหักเหมา 60% vs ตามจริง (ข้อมูลประกอบ ไม่ใช่คำแนะนำภาษี)`,
      parameters: [restaurant],
      responses: {
        ...ok('ข้อมูลแดชบอร์ด', {
          type: 'object',
          properties: {
            today: date,
            periods: { type: 'object', additionalProperties: summaryRef },
            metrics: { type: 'object', additionalProperties: metricsRef },
            reconcile: { $ref: '#/components/schemas/AcctReconcile' },
            last_close: { type: ['string', 'null'] },
            unclosed_days: { type: 'integer' },
            settings: { $ref: '#/components/schemas/AcctSettings' },
            vat_threshold: { type: 'object', properties: { level: { enum: ['none', 'info', 'warn', 'danger'] }, pct: { type: 'number' }, remaining: money } },
            tax_compare: { type: 'object', properties: { income: money, flatExpense: money, flatNet: money, actualExpense: money, actualNet: money, lowerNet: { enum: ['flat', 'actual', 'same'] } } },
            alerts: { type: 'array', items: { $ref: '#/components/schemas/AcctAlert' } },
          },
        }),
        ...errors(),
      },
    }),
  },
  '/api/accounting/summary': {
    get: op('สรุปช่วงวันที่ (งบกำไรขาดทุน กระแสเงินสด ตรวจ perpetual)', READ, 'accountingSummary', {
      parameters: [restaurant, from, to],
      responses: {
        ...ok('สรุป', {
          type: 'object',
          properties: {
            summary: summaryRef,
            metrics: metricsRef,
            stock_check: { type: 'object', description: 'ต้นทุนขายจริง (ตามสูตร + ส่วนต่าง) = ต้นงวด + รับเข้า - ปลายงวด', properties: { opening: money, purchases: money, closing: money, usage: money, cogsActual: money, matches: { type: 'boolean' } } },
            cash: { type: 'object', properties: { in: money, out: money, net: money, balance: money } },
            cash_flow: { type: 'object' },
          },
        }),
        ...errors(),
      },
    }),
  },
  '/api/accounting/menu-profit': {
    get: op('กำไรขั้นต้นต่อเมนู', READ, 'accountingMenuProfit', {
      parameters: [restaurant, from, to],
      responses: {
        ...ok('เรียงจากกำไรมากไปน้อย', {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'object', properties: { menu_item_id: uuid, name: { type: 'string' }, quantity: { type: 'number' }, revenue: money, cost: money, gross_profit: money, has_recipe: { type: 'boolean' } } } },
          },
        }),
        ...errors(),
      },
    }),
  },
  '/api/accounting/trial-balance': {
    get: op('งบทดลอง + งบดุล (โหมดมืออาชีพ)', READ, 'accountingTrialBalance', {
      parameters: [restaurant, from, to],
      responses: {
        ...ok('ยอดยกมา เดบิต เครดิต คงเหลือ ต่อบัญชี', {
          type: 'object',
          properties: { rows: { type: 'array', items: { $ref: '#/components/schemas/TrialRow' } }, balance_sheet: { type: 'object' } },
        }),
        ...errors(),
      },
    }),
  },
  '/api/accounting/journal': {
    get: op('สมุดรายวัน / บัญชีแยกประเภท (ระบุ account_id)', READ, 'accountingJournal', {
      parameters: [restaurant, from, to, q('account_id', uuid, 'เฉพาะบัญชีนี้ (บัญชีแยกประเภท)', false)],
      responses: { ...ok('สูงสุด 5,000 บรรทัด', { type: 'object', properties: { rows: { type: 'array', items: { $ref: '#/components/schemas/JournalRow' } } } }), ...errors() },
    }),
  },
  '/api/accounting/reconcile': {
    get: op('กระทบยอด: มูลค่าในโมดูลสต็อก vs บัญชีสต็อก', `${READ} พนักงานสต็อก`, 'accountingReconcile', {
      parameters: [restaurant],
      responses: { ...ok('ok = false ให้แจ้งเตือน', { $ref: '#/components/schemas/AcctReconcile' }), ...errors() },
    }),
  },
  '/api/accounting/accounts': {
    get: op('ผังบัญชี', READ, 'accountingAccounts', {
      parameters: [restaurant],
      responses: { ...ok('เรียงตามรหัส', { type: 'object', properties: { accounts: { type: 'array', items: { type: 'object' } } } }), ...errors() },
    }),
    post: op('เพิ่มหมวด/บัญชีของร้านเอง', WRITE, 'accountingAddAccount', {
      requestBody: body({
        type: 'object',
        required: ['restaurant_id', 'code', 'name', 'type', 'grp'],
        properties: {
          restaurant_id: uuid,
          code: { type: 'string', pattern: '^[0-9]{4}$', examples: ['5300'] },
          name: { type: 'string', examples: ['ค่าซ่อมบำรุง'] },
          type: { enum: ['asset', 'liability', 'equity', 'revenue', 'expense'] },
          grp: { type: 'string', description: 'expense: food_cost | labor | opex · revenue: sales | other_income · ...' },
        },
      }),
      responses: { ...ok('สร้างแล้ว', { type: 'object' }, '201'), ...errors({ '409': 'รหัสซ้ำ (duplicate)' }) },
    }),
  },
  '/api/accounting/expenses': {
    get: op('รายการรายจ่าย', READ, 'accountingExpenses', {
      parameters: [restaurant, from, to],
      responses: { ...ok('สูงสุด 1,000 รายการ', { type: 'object', properties: { expenses: { type: 'array', items: { type: 'object' } } } }), ...errors() },
    }),
    post: op('บันทึกรายจ่าย (บังคับเลือกหมวด) ลงบัญชีอัตโนมัติ', WRITE, 'accountingAddExpense', {
      description: `สิทธิ์: ${WRITE}\n\nDr หมวดรายจ่าย (+ ภาษีซื้อ) / Cr เงินสด ธนาคาร หรือเจ้าหนี้ · วันที่ที่ปิดวันแล้วบันทึกไม่ได้ (409 day_closed) · รูปใบเสร็จอัปโหลดเข้า Storage bucket expense-receipts แล้วส่ง path มาใน receipt_url`,
      requestBody: body({
        type: 'object',
        required: ['restaurant_id', 'account_id', 'amount'],
        properties: {
          restaurant_id: uuid,
          account_id: { ...uuid, description: 'หมวดรายจ่าย (บัญชีประเภท expense)' },
          amount: { ...money, description: 'ยอดที่จ่ายจริง (รวม VAT)' },
          vat_amount: { ...money, default: 0 },
          payment_method: { enum: ['cash', 'bank', 'credit'], default: 'cash' },
          spent_on: date,
          note: { type: 'string' },
          receipt_url: { type: 'string', description: 'path รูปใบเสร็จใน bucket expense-receipts (<restaurant_id>/...)' },
          supplier_name: { type: 'string', maxLength: 200 },
          supplier_tax_id: { type: 'string', pattern: '^[0-9]{13}$', description: 'ขึ้นต้น 0 = นิติบุคคล (ภ.ง.ด.53) · อื่น = บุคคลธรรมดา (ภ.ง.ด.3)' },
          supplier_branch_code: { type: 'string', pattern: '^[0-9]{5}$', default: '00000' },
          tax_invoice_no: { type: 'string', maxLength: 50, description: 'เลขที่ใบกำกับภาษีซื้อ (ต้องมี tax_invoice_date + ผู้ขาย) → เข้ารายงานภาษีซื้อ' },
          tax_invoice_date: date,
          wht_rate: { enum: [1, 2, 3, 5], description: 'หัก ณ ที่จ่าย % ของยอดก่อน VAT (ต้องมีผู้ขาย) → ลงบัญชีภาษีหัก ณ ที่จ่ายค้างจ่าย' },
          wht_type: { enum: ['pnd3', 'pnd53'], description: 'แบบยื่น (ไม่ส่ง = เลือกจากเลขผู้เสียภาษี) · ต้องตรงประเภทผู้ขาย: ขึ้นต้น 0 = ภ.ง.ด.53' },
        },
      }),
      responses: { ...ok('บันทึกแล้ว', { type: 'object' }, '201'), ...errors({ '409': 'วันนั้นปิดวันแล้ว (day_closed)' }) },
    }),
  },
  '/api/accounting/expenses/{id}/void': {
    post: op('ยกเลิกรายจ่าย (กลับรายการ ต้องมีเหตุผล)', WRITE, 'accountingVoidExpense', {
      parameters: [path('id', 'รายจ่าย')],
      requestBody: body({ type: 'object', required: ['restaurant_id', 'reason'], properties: { restaurant_id: uuid, reason: { type: 'string' } } }),
      responses: { ...ok('กลับรายการแล้ว', { type: 'object', properties: { voided: uuid, reversal_entry_id: uuid } }), ...errors({ '409': 'ยกเลิกไปแล้ว (already_reversed)' }) },
    }),
  },
  '/api/accounting/supplier-payments': {
    post: op('จ่ายเจ้าหนี้ (ใบรับของแบบเครดิต)', WRITE, 'accountingPaySupplier', {
      requestBody: body({
        type: 'object',
        required: ['restaurant_id', 'amount', 'payment_method'],
        properties: { restaurant_id: uuid, amount: money, payment_method: { enum: ['cash', 'bank'] }, supplier: { type: 'string' }, date, note: { type: 'string' } },
      }),
      responses: { ...ok('Dr เจ้าหนี้ / Cr เงินสดหรือธนาคาร', { type: 'object', properties: { entry_id: uuid } }, '201'), ...errors() },
    }),
  },
  '/api/accounting/bills/{order_id}/cancel': {
    post: op('ยกเลิกบิลหลังจ่าย (กลับรายการรายได้ + ย้ายต้นทุนเป็นส่วนต่างสต็อก)', 'เจ้าของเท่านั้น', 'accountingCancelBill', {
      parameters: [path('order_id', 'ออเดอร์ที่จ่ายแล้ว')],
      requestBody: body({ type: 'object', required: ['restaurant_id', 'reason'], properties: { restaurant_id: uuid, reason: { type: 'string', maxLength: 200 } } }),
      responses: { ...ok('ยกเลิกแล้ว', { type: 'object', properties: { cancelled: uuid } }), ...errors({ '404': 'ไม่พบบิลที่จ่ายแล้ว' }) },
    }),
  },
  '/api/accounting/entries/{id}/reverse': {
    post: op('กลับรายการ (ยอดยกมา จ่ายเจ้าหนี้ ปิดวัน)', 'เจ้าของเท่านั้น', 'accountingReverseEntry', {
      description: 'สิทธิ์: เจ้าของเท่านั้น\n\nบิลใช้ยกเลิกบิล รายจ่ายใช้ยกเลิกรายจ่าย รายการสต็อกใช้ตรวจนับ (400 reverse_not_allowed)',
      parameters: [path('id', 'รายการในสมุดรายวัน')],
      requestBody: body({ type: 'object', required: ['restaurant_id', 'reason'], properties: { restaurant_id: uuid, reason: { type: 'string' } } }),
      responses: { ...ok('กลับรายการแล้ว', { type: 'object', properties: { reversal_entry_id: uuid } }), ...errors({ '409': 'กลับรายการไปแล้ว' }) },
    }),
  },
  '/api/accounting/opening': {
    post: op('ตั้งยอดยกมา เงินสด/ธนาคาร (Cr ทุนเจ้าของ)', 'เจ้าของเท่านั้น', 'accountingOpening', {
      requestBody: body({ type: 'object', required: ['restaurant_id'], properties: { restaurant_id: uuid, cash: money, bank: money, date } }),
      responses: { ...ok('ลงแล้ว', { type: 'object', properties: { entry_id: uuid } }, '201'), ...errors() },
    }),
  },
  '/api/accounting/day': {
    get: op('สรุปยอดของวัน (ก่อน/หลังปิดวัน)', READ, 'accountingDay', {
      parameters: [restaurant, q('date', date, 'วันที่')],
      responses: { ...ok('ยอดของวัน + เงินสดตามระบบ + สถานะปิดวัน', { type: 'object' }), ...errors() },
    }),
  },
  '/api/accounting/day-close': {
    post: op('ปิดวัน: นับเงินสด ยืนยัน ล็อกรายการของวัน แล้วส่งสรุปเข้า LINE', 'เจ้าของ ผู้จัดการ', 'accountingDayClose', {
      description: 'สิทธิ์: เจ้าของ ผู้จัดการ\n\nส่วนต่างเงินสดลงบัญชีเงินสดขาด/เกิน · หลังปิดวันเพิ่มรายการในวันนั้นไม่ได้ (รายการอัตโนมัติเข้าวันถัดไป) แก้ได้เฉพาะกลับรายการ · line: sent | not_configured | failed (ส่งไม่ได้ก็ยังปิดวันสำเร็จ)',
      requestBody: body({
        type: 'object',
        required: ['restaurant_id', 'date', 'counted_cash'],
        properties: { restaurant_id: uuid, date, counted_cash: money, note: { type: 'string' }, notify: { type: 'boolean', default: true } },
      }),
      responses: {
        ...ok('ปิดวันแล้ว', { type: 'object', properties: { close: { type: 'object' }, line: { enum: ['sent', 'not_configured', 'failed'] } } }, '201'),
        ...errors({ '409': 'ปิดวันนี้ไปแล้ว (already_closed)' }),
      },
    }),
  },
  '/api/accounting/settings': {
    get: op('ตั้งค่าบัญชี', READ, 'accountingSettings', {
      parameters: [restaurant],
      responses: { ...ok('ตั้งค่า', { type: 'object', properties: { settings: { $ref: '#/components/schemas/AcctSettings' } } }), ...errors() },
    }),
    patch: op('แก้ตั้งค่าบัญชี / onboarding (โหมด จด VAT เป้า Food/Prime Cost)', 'เจ้าของเท่านั้น', 'accountingUpdateSettings', {
      requestBody: body({
        allOf: [
          { $ref: '#/components/schemas/AcctSettings' },
          { type: 'object', required: ['restaurant_id'], properties: { restaurant_id: uuid, onboarded: { type: 'boolean', description: 'true = ตอบคำถามเริ่มต้นแล้ว' } } },
        ],
      }),
      responses: { ...ok('บันทึกแล้ว', { type: 'object', properties: { saved: { type: 'array', items: { type: 'string' } } } }), ...errors() },
    }),
  },
  '/api/accounting/export': {
    get: op('ส่งออกให้นักบัญชี (CSV / Excel)', READ, 'accountingExport', {
      parameters: [
        restaurant, from, to,
        q('report', { enum: ['journal', 'trial_balance', 'summary', 'menu_profit', 'expenses'], default: 'journal' }, 'รายงาน', false),
        q('format', { enum: ['csv', 'xls'], default: 'csv' }, 'csv = UTF-8 BOM · xls = Excel XML Spreadsheet', false),
      ],
      responses: {
        '200': {
          description: 'ไฟล์แนบ (content-disposition: attachment)',
          content: { 'text/csv': { schema: { type: 'string' } }, 'application/vnd.ms-excel': { schema: { type: 'string' } } },
        },
        ...errors(),
      },
    }),
  },

  // ===== รายงานภาษีรายเดือน =====
  '/api/accounting/reports/sales-tax': {
    get: op('รายงานภาษีขาย (ประกอบ ภ.พ.30)', READ, 'taxSalesReport', {
      description: `สิทธิ์: ${READ}\n\nเฉพาะเอกสารที่ยืนยันแล้ว ตามวันที่ออก · ABB รวม 1 บรรทัดต่อวันต่อเครื่อง (ช่วงเลขที่) · ใบลดหนี้ติดลบ · ใบเต็มรูปที่แปลงจาก ABB แสดงอ้างอิงยอด 0 (ไม่นับซ้ำ)`,
      parameters: [restaurant, month, reportFormat],
      responses: reportResponses('รายการ + ยอดรวม', {
        type: 'object',
        properties: {
          month: { type: 'string' }, period: { type: 'object' }, seller: { $ref: '#/components/schemas/TaxSeller' },
          rows: { type: 'array', items: { type: 'object' } },
          totals: { type: 'object', properties: { taxable: money, exempt: money, vat: money, total: money } },
        },
      }),
    }, taxTag.name),
  },
  '/api/accounting/reports/purchase-tax': {
    get: op('รายงานภาษีซื้อ', READ, 'taxPurchaseReport', {
      description: `สิทธิ์: ${READ}\n\nรายจ่ายที่มีใบกำกับภาษีซื้อและยังไม่ยกเลิก ตามวันที่ลงบัญชี (spent_on) · without_invoice = รายจ่ายที่มี VAT แต่ไม่มีใบกำกับ (นำมาหักไม่ได้)`,
      parameters: [restaurant, month, reportFormat],
      responses: reportResponses('รายการ + ยอดรวม', {
        type: 'object',
        properties: {
          month: { type: 'string' }, seller: { $ref: '#/components/schemas/TaxSeller' },
          rows: { type: 'array', items: { type: 'object' } },
          totals: { type: 'object', properties: { value: money, vat: money, total: money } },
          without_invoice: { type: 'object', properties: { count: { type: 'integer' }, vat: money } },
        },
      }),
    }, taxTag.name),
  },
  '/api/accounting/reports/pp30-summary': {
    get: op('สรุป ภ.พ.30 (ภาษีขาย - ภาษีซื้อ)', READ, 'taxPp30Summary', {
      parameters: [restaurant, month, reportFormat],
      responses: reportResponses('vat_payable > 0 = ต้องชำระ · vat_credit > 0 = ชำระเกิน', {
        type: 'object',
        properties: {
          month: { type: 'string' }, seller: { $ref: '#/components/schemas/TaxSeller' },
          summary: {
            type: 'object',
            properties: {
              sales_total: money, sales_exempt_or_zero: money, sales_taxable: money, output_vat: money,
              purchases_eligible: money, input_vat: money, net_vat: money, vat_payable: money, vat_credit: money,
            },
          },
          counts: { type: 'object' }, purchases_without_invoice: { type: 'object' },
        },
      }),
    }, taxTag.name),
  },
  '/api/accounting/reports/wht': {
    get: op('สรุปภาษีหัก ณ ที่จ่าย (ภ.ง.ด.3 / ภ.ง.ด.53)', READ, 'taxWhtReport', {
      parameters: [restaurant, month, reportFormat, q('type', { enum: ['pnd3', 'pnd53'] }, 'ไม่ใส่ = ทั้งสองแบบ', false)],
      responses: reportResponses('รายการ + สรุปต่อแบบ', {
        type: 'object',
        properties: {
          month: { type: 'string' }, type: { enum: ['pnd3', 'pnd53', 'all'] }, seller: { $ref: '#/components/schemas/TaxSeller' },
          rows: { type: 'array', items: { type: 'object' } },
          summary: { type: 'object', properties: { pnd3: { type: 'object' }, pnd53: { type: 'object' }, total_wht: money } },
        },
      }),
    }, taxTag.name),
  },

  // ===== เอกสารภาษี =====
  '/api/tax/documents': {
    get: op('รายการเอกสารภาษี', TAX_ISSUE, 'taxDocuments', {
      parameters: [
        restaurant,
        q('doc_type', { enum: ['ABB', 'TAX', 'CN'] }, 'ประเภท', false),
        q('status', { enum: ['draft', 'confirmed', 'voided'] }, 'สถานะ', false),
        q('order_id', uuid, 'เฉพาะออเดอร์นี้', false),
        q('from', date, 'วันที่ออกตั้งแต่', false),
        q('to', date, 'วันที่ออกถึง', false),
      ],
      responses: { ...ok('ล่าสุดก่อน สูงสุด 1,000 (ไม่รวม XML)', { type: 'object', properties: { documents: { type: 'array', items: { $ref: '#/components/schemas/TaxDocument' } } } }), ...errors() },
    }, taxTag.name),
    post: op('สร้างเอกสารภาษี (ฉบับร่าง หรือยืนยันทันที)', TAX_ISSUE, 'taxCreateDocument', {
      description: `สิทธิ์: ${TAX_ISSUE}\n\nABB/TAX: จากออเดอร์ที่ชำระแล้ว (ยอดรวม VAT) · TAX + ref_document_id = แปลงจาก ABB · CN: ต้องมี ref_document_id + amount + credit_note_reason\n\nconfirm=true + terminal_code = ยืนยันทันที ถ้ายืนยันไม่ผ่านจะคืน document_id ของฉบับร่าง`,
      requestBody: body({
        type: 'object',
        required: ['restaurant_id', 'doc_type'],
        properties: {
          restaurant_id: uuid, doc_type: { enum: ['ABB', 'TAX', 'CN'] }, order_id: uuid, ref_document_id: uuid,
          buyer_name: { type: 'string', maxLength: 200 }, buyer_tax_id: { type: 'string', pattern: '^[0-9]{13}$' },
          buyer_branch_code: { type: 'string', pattern: '^[0-9]{5}$' }, buyer_address: { type: 'string', maxLength: 500 },
          exempt_amount: { ...money, default: 0, description: 'ยอดที่ได้รับยกเว้น VAT (ABB/TAX จากออเดอร์)' },
          amount: { ...money, description: 'CN: ยอดลดหนี้รวม VAT (รวมทุกใบไม่เกินยอดเอกสารต้นทาง)' },
          credit_note_reason: { type: 'string', maxLength: 300 },
          client_ref: { ...uuid, description: 'Stable UUID for retries of this creation action; do not reuse for another draft' },
          confirm: { type: 'boolean', default: false }, terminal_code: { type: 'string', pattern: '^[A-Za-z0-9]{1,10}$' },
        },
      }),
      responses: {
        ...ok('สร้างแล้ว', { type: 'object', properties: { document: { $ref: '#/components/schemas/TaxDocument' } } }, '201'),
        '202': { description: 'Document created but follow-up outcome unknown; response includes document_id and recovery_url' },
        ...errors({ '409': 'มีเอกสารแล้ว (document_exists, tax_invoice_exists) / ยอดลดหนี้เกิน / ยืนยันไม่ผ่าน (มี document_id)' }),
      },
    }, taxTag.name),
  },
  '/api/tax/documents/{id}/confirm': {
    post: op('ยืนยันฉบับร่าง: ออกเลขที่ไม่ขาดช่วง + สร้าง XML ETDA', TAX_ISSUE, 'taxConfirmDocument', {
      description: `สิทธิ์: ${TAX_ISSUE}\n\nnext_tax_doc_no ออกเลขในธุรกรรมเดียวกับการบันทึก (rollback = เลขไม่ถูกใช้) · เก็บสำเนาข้อมูลผู้ขายและเครื่อง · หลังยืนยันแก้/ลบไม่ได้ (ยกเลิกด้วยใบลดหนี้) · ABB ต้องใช้เครื่องที่มีเลขอนุมัติ POS`,
      parameters: [path('id', 'เอกสารฉบับร่าง')],
      requestBody: body({ type: 'object', required: ['restaurant_id', 'terminal_code'], properties: { restaurant_id: uuid, terminal_code: { type: 'string', examples: ['POS01'] } } }),
      responses: {
        ...ok('ยืนยันแล้ว', { type: 'object', properties: { document: { $ref: '#/components/schemas/TaxDocument' } } }),
        ...errors({ '404': 'ไม่พบเอกสาร', '409': 'ไม่ใช่ฉบับร่าง (not_draft) / ยอดออเดอร์เปลี่ยน' }),
      },
    }, taxTag.name),
  },
  '/api/tax/documents/{id}/xml': {
    get: op('ดาวน์โหลด XML (ETDA ขมธอ.3-2560)', TAX_ISSUE, 'taxDocumentXml', {
      parameters: [path('id', 'เอกสารที่ยืนยันแล้ว'), restaurant],
      responses: {
        '200': { description: 'ไฟล์ <doc_number>.xml (attachment)', content: { 'application/xml': { schema: { type: 'string' } } } },
        ...errors({ '404': 'ไม่พบเอกสาร', '409': 'ยังไม่ยืนยัน (not_confirmed)' }),
      },
    }, taxTag.name),
  },

  // ===== กะแคชเชียร์ =====
  '/api/shifts/open': {
    post: op('เปิดกะ (เงินทอนตั้งต้น)', SHIFT_WHO, 'shiftOpen', {
      description: `สิทธิ์: ${SHIFT_WHO}\n\nผู้ใช้ 1 คน / เครื่อง 1 เครื่อง เปิดได้ 1 กะ · บิลที่ชำระระหว่างกะผูกกับกะของผู้รับเงินอัตโนมัติ`,
      requestBody: body({ type: 'object', required: ['restaurant_id', 'starting_cash'], properties: { restaurant_id: uuid, starting_cash: money, terminal_code: { type: 'string' } } }),
      responses: { ...ok('เปิดกะแล้ว', { type: 'object', properties: { shift: { type: 'object' } } }, '201'), ...errors({ '409': 'มีกะเปิดอยู่แล้ว (shift_already_open)' }) },
    }, taxTag.name),
  },
  '/api/shifts/cash-movement': {
    post: op('เงินเข้า/ออกลิ้นชัก (ต้องมีเหตุผล)', SHIFT_WHO, 'shiftCashMovement', {
      requestBody: body({
        type: 'object',
        required: ['restaurant_id', 'shift_id', 'type', 'amount', 'reason'],
        properties: { restaurant_id: uuid, shift_id: uuid, type: { enum: ['cash_in', 'cash_out'] }, amount: money, reason: { type: 'string', maxLength: 300 } },
      }),
      responses: { ...ok('บันทึกแล้ว', { type: 'object', properties: { log: { type: 'object' } } }, '201'), ...errors({ '404': 'ไม่พบกะ', '409': 'กะปิดแล้ว / เงินไม่พอ (insufficient_cash)' }) },
    }, taxTag.name),
  },
  '/api/shifts/close': {
    post: op('ปิดกะ: นับเงินสด + Z-Report', SHIFT_WHO, 'shiftClose', {
      description: `สิทธิ์: ${SHIFT_WHO}\n\nที่ควรมี = เงินทอนตั้งต้น + ขายเงินสด + เงินเข้า - เงินออก · ส่วนต่าง = นับจริง - ที่ควรมี · ปิดแล้วแก้ไม่ได้`,
      requestBody: body({ type: 'object', required: ['restaurant_id', 'shift_id', 'actual_cash'], properties: { restaurant_id: uuid, shift_id: uuid, actual_cash: money, note: { type: 'string', maxLength: 300 } } }),
      responses: {
        ...ok('ปิดกะแล้ว', { type: 'object', properties: { shift: { type: 'object' }, z_report: { $ref: '#/components/schemas/ZReport' } } }),
        ...errors({ '404': 'ไม่พบกะ', '409': 'กะปิดแล้ว (shift_closed)' }),
      },
    }, taxTag.name),
  },
}
