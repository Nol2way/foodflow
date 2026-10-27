// เอกสาร OpenAPI 3.1 ของ Plato backend
// เสิร์ฟที่ /api/openapi.json และหน้า Swagger UI ที่ /api/docs
// แก้ endpoint ใน app.ts แล้วต้องแก้ที่นี่ด้วย (มีชุดทดสอบตรวจว่าทุก route มีเอกสาร)
// ส่งออกเป็นไฟล์: npm run openapi -> docs/openapi.json
import { accountingPaths, accountingSchemas, accountingTag } from './openapi-accounting.ts'
import { stockPaths, stockSchemas, stockTag } from './openapi-stock.ts'

const uuid = { type: 'string', format: 'uuid' } as const
const role = { type: 'string', enum: ['owner', 'manager', 'staff', 'kitchen', 'accountant', 'stock'] } as const
// พนักงาน 1 คนมีได้หลายบทบาท (0020)
const roles = { type: 'array', items: role, minItems: 1, uniqueItems: true, description: 'บทบาททั้งหมดของพนักงาน (มีได้หลายบทบาท)' } as const
const legacyRole = { ...role, deprecated: true, description: 'แบบเดิม: บทบาทเดียว (ใช้ roles แทน)' } as const

const err = (description: string, codes: string[]) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
      examples: Object.fromEntries(codes.map((c) => [c, { value: { error: c } }])),
    },
  },
})
const json = (schema: object, example?: unknown) => ({
  'application/json': example === undefined ? { schema } : { schema, example },
})

const authErrors = {
  '400': err('restaurant_id ไม่ใช่ UUID หรือข้อมูลไม่ถูกต้อง', ['invalid_restaurant_id', 'invalid_request']),
  '401': err('ไม่มี token หรือ token หมดอายุ', ['unauthorized']),
  '403': err('บทบาทในร้านนี้ไม่พอ', ['forbidden']),
}
const USER = { type: 'object', properties: { id: uuid, email: { type: 'string' }, display_name: { type: ['string', 'null'] }, phone: { type: ['string', 'null'] }, must_change_password: { type: 'boolean' } } } as const
const restaurantQuery = { name: 'restaurant_id', in: 'query', required: true, schema: uuid, description: 'ร้านที่ทำรายการ' }

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Plato API',
    version: '1.0.0',
    description: [
      'Backend ของระบบบริหารร้านอาหาร Plato (Hono บน Cloudflare)',
      '',
      '**สิทธิ์:** endpoint ที่มีรูปกุญแจต้องส่ง `Authorization: Bearer <access_token>` ที่ได้จาก `POST /api/auth/login`',
      'ผู้ใช้เก็บในตาราง `app_users` ของระบบเอง (ไม่ใช้ Supabase Auth) โทเคนลงนามด้วย JWT secret ของโปรเจกต์ จึงใช้กับ RLS ของ Supabase ได้',
      'วิธีหา token เพื่อทดลองในหน้านี้: เรียก `POST /api/auth/login` แล้วคัดลอก `access_token` มาใส่ที่ปุ่ม **Authorize**',
      '',
      '**ข้อผิดพลาด:** ตอบเป็น `{ "error": "<code>", "message": "<ข้อความไทย ถ้ามี>" }` ข้อผิดพลาดที่ไม่คาดคิดตอบ `500 internal_error` โดยไม่เปิดเผยรายละเอียด',
      '',
      'สิทธิ์จริงบังคับที่ฐานข้อมูล (RLS) backend ตรวจซ้ำอีกชั้น',
      '',
      '**การรับออเดอร์ไม่อยู่ใน API นี้:** พนักงานที่ล็อกอินแล้วเรียกฟังก์ชัน `staff_place_order` ของ Supabase โดยตรง (ตรวจสิทธิ์และราคาในฐานข้อมูล) ออเดอร์จึงเข้าหน้าจอครัวผ่าน Realtime ทันที',
    ].join('\n'),
  },
  servers: [
    { url: '/', description: 'เซิร์ฟเวอร์เดียวกับหน้านี้' },
    { url: 'http://localhost:8787', description: 'backend ในเครื่อง (cd backend && npm run dev)' },
  ],
  tags: [
    { name: 'ระบบ', description: 'สถานะและเอกสาร' },
    { name: 'บัญชีผู้ใช้', description: 'ล็อกอิน เปลี่ยนรหัสผ่าน โปรไฟล์ (ตาราง app_users)' },
    { name: 'นำเข้าข้อมูล', description: 'นำเข้ายอดขายย้อนหลังจาก CSV (เจ้าของร้าน, ผู้จัดการ)' },
    { name: 'AI', description: 'สรุป/ถามตอบด้วย Gemini (เจ้าของร้าน, บัญชี) · แนะนำโปร (เจ้าของร้าน, ผู้จัดการ)' },
    { name: 'รายงาน', description: 'รายงานสรุปรายวันทาง LINE (เจ้าของร้าน, ผู้จัดการ)' },
    { name: 'พนักงาน', description: 'จัดการพนักงาน (เจ้าของร้าน ทุกบทบาท · ผู้จัดการ เฉพาะ staff / kitchen / accountant / stock)' },
    accountingTag,
    stockTag,
  ],
  paths: {
    '/api/health': {
      get: {
        tags: ['ระบบ'],
        summary: 'ตรวจสถานะ backend',
        operationId: 'health',
        security: [],
        responses: {
          '200': {
            description: 'ทำงานปกติ และบอกว่าเปิดฟีเจอร์ใดไว้',
            content: json(
              {
                type: 'object',
                required: ['ok', 'ai', 'line'],
                properties: {
                  ok: { type: 'boolean' },
                  ai: { type: 'boolean', description: 'ตั้ง GEMINI_API_KEY แล้วหรือไม่' },
                  line: { type: 'boolean', description: 'ตั้ง LINE_CHANNEL_ACCESS_TOKEN แล้วหรือไม่ (ส่งรายงานรายวันทาง LINE)' },
                },
              },
              { ok: true, ai: true, line: false },
            ),
          },
        },
      },
    },

    '/api/import/sales': {
      post: {
        tags: ['นำเข้าข้อมูล'],
        summary: 'นำเข้ายอดขายย้อนหลังจาก CSV (เจ้าของ, ผู้จัดการ)',
        description: [
          'ไฟล์ไม่เกิน 3 MB / 20,000 แถว',
          '- คอลัมน์บังคับ: `datetime` (หรือ `date` + `time`), `item`, `qty` · ไม่บังคับ: `ref` (เลขที่บิล), `price`',
          '- รองรับหัวตารางไทย: วันที่, เวลา, เลขที่บิล, เมนู, จำนวน, ราคา · วันที่ `2026-09-01` หรือ `01/09/2569`',
          '- แถวผิดรูปแบบ → 400 `invalid_rows` พร้อมเลขบรรทัด และ **ไม่นำเข้าเลยทั้งไฟล์**',
          '- ชื่อเมนูไม่ตรงในระบบ → `blocked: true` ไม่นำเข้า เว้นแต่ส่ง `skip_unknown: true`',
          '- ออเดอร์ที่นำเข้า: สถานะ paid, ไม่ตัดสต็อก, แถวที่ `ref` เดียวกันในวันเดียวกันรวมเป็น 1 ออเดอร์',
          '- แนะนำให้เรียกด้วย `dry_run: true` ก่อนเพื่อดูผล',
        ].join('\n'),
        operationId: 'importSales',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: json(
            {
              type: 'object',
              required: ['restaurant_id', 'csv'],
              properties: {
                restaurant_id: uuid,
                csv: { type: 'string', description: 'เนื้อไฟล์ CSV ทั้งไฟล์', maxLength: 3000000 },
                dry_run: { type: 'boolean', default: false, description: 'ตรวจอย่างเดียว ไม่บันทึก' },
                skip_unknown: { type: 'boolean', default: false, description: 'ข้ามแถวที่ชื่อเมนูไม่ตรงกับในระบบ' },
              },
            },
            {
              restaurant_id: '00000000-0000-4000-8000-000000000003',
              csv: 'date,time,ref,item,qty,price\n2026-09-01,11:52,B0001,ผัดกะเพราหมูสับ,2,\n',
              dry_run: true,
            },
          ),
        },
        responses: {
          '200': { description: 'ผลการตรวจ/นำเข้า', content: json({ $ref: '#/components/schemas/ImportResult' }) },
          '400': {
            description: 'มีแถวผิดรูปแบบ (ไม่ได้นำเข้าอะไรเลย) หรือข้อมูลไม่ถูกต้อง',
            content: json(
              {
                type: 'object',
                required: ['error'],
                properties: {
                  error: { type: 'string', enum: ['invalid_rows', 'invalid_request', 'invalid_restaurant_id'] },
                  message: { type: 'string' },
                  error_count: { type: 'integer' },
                  errors: {
                    type: 'array',
                    maxItems: 100,
                    items: {
                      type: 'object',
                      required: ['line', 'message'],
                      properties: { line: { type: 'integer' }, message: { type: 'string' } },
                    },
                  },
                },
              },
              { error: 'invalid_rows', error_count: 1, errors: [{ line: 3, message: 'จำนวนต้องเป็นจำนวนเต็ม 1-1000' }] },
            ),
          },
          '401': authErrors['401'],
          '403': authErrors['403'],
          '413': err('ไฟล์ใหญ่เกิน 3 MB', ['too_large']),
        },
      },
    },

    '/api/import/{batch_id}': {
      delete: {
        tags: ['นำเข้าข้อมูล'],
        summary: 'ย้อนการนำเข้า (ลบออเดอร์ทั้งรอบ) (เจ้าของ, ผู้จัดการ)',
        operationId: 'undoImport',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'batch_id', in: 'path', required: true, schema: uuid, description: 'batch_id ที่ได้ตอนนำเข้า' },
          restaurantQuery,
        ],
        responses: {
          '200': {
            description: 'ลบแล้ว',
            content: json({ type: 'object', required: ['deleted_orders'], properties: { deleted_orders: { type: 'integer' } } }, { deleted_orders: 120 }),
          },
          '400': err('รหัสไม่ถูกต้อง', ['invalid_batch', 'invalid_restaurant_id']),
          '401': authErrors['401'],
          '403': authErrors['403'],
          '404': err('ไม่พบรอบนำเข้านี้ในร้าน', ['not_found']),
        },
      },
    },

    '/api/ai/promo-suggestions': {
      post: {
        tags: ['AI'],
        summary: 'แนะนำโปรโมชันจากยอดขาย (เจ้าของ, ผู้จัดการ)',
        description: [
          'อ่าน `promo_insights` (ยอดตามชั่วโมง ยอด/ต้นทุนต่อเมนู) แล้วคืนคำแนะนำ 2 แบบ',
          '- `rules`: กติกาในระบบ (ช่วงเวลาเงียบ, เมนูขายช้าที่ยังลดได้, ซื้อครบลด) ได้เสมอ ไม่ต้องมี AI',
          '- `ai`: ส่ง `ai: true` และตั้ง GEMINI_API_KEY แล้ว ให้ Gemini เสนอเพิ่ม · ทุกข้อผ่านการตรวจ: ห้ามขาดทุน (ราคาหลังลด ≥ ต้นทุน × 1.3), percent ≤ 30, amount ≤ 500, เมนูต้องมีจริง',
          '- AI ล่ม = ยังได้ `rules` พร้อม `ai_error`',
          '- ไม่สร้างโปรให้เอง หน้าเว็บสร้างเป็นโปรที่ปิดไว้ก่อนเมื่อผู้ใช้กดเลือก',
        ].join('\n'),
        operationId: 'promoSuggestions',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: json(
            {
              type: 'object',
              required: ['restaurant_id'],
              properties: {
                restaurant_id: uuid,
                days: { type: 'integer', minimum: 7, maximum: 120, default: 28 },
                ai: { type: 'boolean', default: false, description: 'ให้ Gemini เสนอเพิ่ม' },
              },
            },
            { restaurant_id: '00000000-0000-4000-8000-000000000003', days: 28, ai: true },
          ),
        },
        responses: {
          '200': {
            description: 'คำแนะนำ',
            content: json({
              type: 'object',
              required: ['rules', 'ai', 'ai_enabled'],
              properties: {
                rules: { type: 'array', items: { $ref: '#/components/schemas/Suggestion' } },
                ai: { type: 'array', items: { $ref: '#/components/schemas/Suggestion' } },
                ai_enabled: { type: 'boolean' },
                ai_error: { type: 'string' },
              },
            }),
          },
          '400': { description: 'days ไม่ถูกต้อง หรือ restaurant_id ไม่ใช่ UUID', content: json({ $ref: '#/components/schemas/Error' }) },
          '401': { description: 'ไม่ได้ล็อกอิน', content: json({ $ref: '#/components/schemas/Error' }) },
          '403': { description: 'บทบาทไม่ใช่เจ้าของ/ผู้จัดการ', content: json({ $ref: '#/components/schemas/Error' }) },
          '429': { description: 'เรียก AI ถี่เกินไป', content: json({ $ref: '#/components/schemas/Error' }) },
        },
      },
    },

    '/api/reports/daily/send': {
      post: {
        tags: ['รายงาน'],
        summary: 'ส่งรายงานสรุปรายวันเข้า LINE ทันที (เจ้าของ, ผู้จัดการ)',
        description: [
          'ส่งข้อความสรุปจาก `daily_report` ไปที่ LINE ID ผู้รับใน `shop_settings.line_to` ผ่าน LINE Messaging API',
          '- ต้องตั้ง secret `LINE_CHANNEL_ACCESS_TOKEN` (ไม่ตั้ง = 503 `line_disabled`)',
          '- ส่งอัตโนมัติทุกวันด้วย Cron ของ Worker ตาม `REPORT_HOUR` (ค่าเริ่มต้น 22:00 เวลาร้าน)',
        ].join('\n'),
        operationId: 'sendDailyReport',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: json(
            {
              type: 'object',
              required: ['restaurant_id'],
              properties: { restaurant_id: uuid, date: { type: 'string', format: 'date', description: 'ไม่ใส่ = วันนี้ (เวลาร้าน)' } },
            },
            { restaurant_id: '00000000-0000-4000-8000-000000000003' },
          ),
        },
        responses: {
          '200': {
            description: 'ส่งแล้ว',
            content: json({ type: 'object', required: ['sent', 'date'], properties: { sent: { type: 'boolean' }, date: { type: 'string', format: 'date' } } }),
          },
          '400': { description: 'ยังไม่ได้ตั้ง LINE ID ผู้รับ (`line_not_set`) หรือวันที่ผิดรูปแบบ', content: json({ $ref: '#/components/schemas/Error' }) },
          '401': { description: 'ไม่ได้ล็อกอิน', content: json({ $ref: '#/components/schemas/Error' }) },
          '403': { description: 'บทบาทไม่ใช่เจ้าของ/ผู้จัดการ', content: json({ $ref: '#/components/schemas/Error' }) },
          '502': { description: 'LINE ปฏิเสธ (token ผิด หรือผู้รับยังไม่ได้เพิ่มบัญชีร้านเป็นเพื่อน)', content: json({ $ref: '#/components/schemas/Error' }) },
          '503': { description: 'ยังไม่ได้ตั้ง LINE_CHANNEL_ACCESS_TOKEN', content: json({ $ref: '#/components/schemas/Error' }) },
        },
      },
    },

    '/api/ai/summary': {
      post: {
        tags: ['AI'],
        summary: 'สรุปหรือถามคำถามเกี่ยวกับร้านด้วย Gemini',
        description: [
          'backend ดึงตัวเลขที่ฐานข้อมูลคำนวณแล้ว (`facts`) ส่งให้ Gemini อธิบาย โดยสั่งห้ามสร้างตัวเลขใหม่',
          'และส่ง `facts` ชุดเดียวกันกลับมาให้ตรวจสอบได้',
          '',
          '- จำกัด 6 ครั้ง/นาที/ผู้ใช้',
          '- ไม่มีออเดอร์ในช่วงนั้น = ไม่เรียก Gemini (`ai: false`)',
          '- บทบาท: เจ้าของร้าน, พนักงานบัญชี',
        ].join('\n'),
        operationId: 'aiSummary',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: json(
            {
              type: 'object',
              required: ['restaurant_id'],
              properties: {
                restaurant_id: uuid,
                days: { type: 'integer', minimum: 1, maximum: 120, default: 28, description: 'ช่วงข้อมูลย้อนหลัง (วัน) สูงสุด 120 ตามฟังก์ชันวิเคราะห์ในฐานข้อมูล' },
                question: { type: 'string', maxLength: 500, description: 'ไม่ใส่ = สรุปภาพรวมพร้อมข้อแนะนำ 3 ข้อ' },
              },
            },
            { restaurant_id: '00000000-0000-4000-8000-000000000003', days: 28, question: 'ควรเพิ่มพนักงานช่วงไหน' },
          ),
        },
        responses: {
          '200': {
            description: 'คำตอบและตัวเลขที่ใช้',
            content: json({
              type: 'object',
              required: ['answer', 'facts', 'ai'],
              properties: {
                answer: { type: 'string' },
                ai: { type: 'boolean', description: 'false = ไม่ได้เรียก Gemini เพราะไม่มีข้อมูล' },
                facts: { $ref: '#/components/schemas/Facts' },
              },
            }),
          },
          '400': err('days / question ไม่ถูกต้อง', ['invalid_days', 'question_too_long', 'invalid_restaurant_id']),
          '401': authErrors['401'],
          '403': authErrors['403'],
          '429': err('เรียกถี่เกินไป', ['too_many_requests']),
          '502': {
            description: 'Gemini ไม่ตอบสนอง (ยังได้ facts กลับมา)',
            content: json({
              type: 'object',
              properties: { error: { const: 'ai_unavailable' }, message: { type: 'string' }, facts: { $ref: '#/components/schemas/Facts' } },
            }),
          },
          '503': err('ยังไม่ได้ตั้ง GEMINI_API_KEY', ['ai_disabled']),
        },
      },
    },

    '/api/auth/login': {
      post: {
        tags: ['บัญชีผู้ใช้'],
        summary: 'ล็อกอินด้วยอีเมลและรหัสผ่าน',
        operationId: 'login',
        requestBody: {
          required: true,
          content: json(
            { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', maxLength: 72 } } },
            { email: 'owner@example.com', password: '********' },
          ),
        },
        responses: {
          '200': {
            description: 'สำเร็จ: access_token ใช้ได้ตามอายุใน expires_at (ค่าเริ่มต้น 12 ชั่วโมง)',
            content: json({
              type: 'object',
              properties: { access_token: { type: 'string' }, expires_at: { type: 'integer', description: 'เวลาหมดอายุ (มิลลิวินาที)' }, user: USER },
            }),
          },
          '400': err('ไม่ได้กรอกอีเมล/รหัสผ่าน', ['invalid_request']),
          '401': err('อีเมลหรือรหัสผ่านไม่ถูกต้อง หรือบัญชีถูกปิด', ['invalid_credentials']),
          '429': err('ลองถี่เกินไป (10 ครั้งต่อนาที ต่อ IP และต่ออีเมล)', ['too_many_requests']),
          '503': err('ยังไม่ได้ตั้ง SUPABASE_JWT_SECRET', ['auth_not_configured']),
        },
      },
    },

    '/api/auth/me': {
      get: {
        tags: ['บัญชีผู้ใช้'],
        summary: 'โปรไฟล์ของผู้ใช้ที่ล็อกอิน',
        operationId: 'me',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'โปรไฟล์', content: json({ type: 'object', properties: { user: USER } }) }, '401': authErrors['401'] },
      },
      patch: {
        tags: ['บัญชีผู้ใช้'],
        summary: 'แก้ชื่อและเบอร์โทรของตัวเอง',
        operationId: 'updateMe',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: json({ type: 'object', properties: { display_name: { type: 'string', maxLength: 80 }, phone: { type: 'string', maxLength: 30 } } }),
        },
        responses: { '200': { description: 'บันทึกแล้ว', content: json({ type: 'object', properties: { user: USER } }) }, '401': authErrors['401'] },
      },
    },

    '/api/auth/password': {
      post: {
        tags: ['บัญชีผู้ใช้'],
        summary: 'เปลี่ยนรหัสผ่านตัวเอง (ต้องยืนยันรหัสปัจจุบัน)',
        operationId: 'changePassword',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['current_password', 'new_password'],
            properties: { current_password: { type: 'string' }, new_password: { type: 'string', minLength: 8, maxLength: 72 } },
          }),
        },
        responses: {
          '200': { description: 'เปลี่ยนแล้ว', content: json({ type: 'object', properties: { changed: { const: true } } }) },
          '400': err('รหัสใหม่สั้น/ยาวเกิน ซ้ำรหัสเดิม หรือรหัสปัจจุบันผิด', ['weak_password', 'same_password', 'wrong_password']),
          '401': authErrors['401'],
          '429': err('ลองถี่เกินไป', ['too_many_requests']),
        },
      },
    },

    '/api/staff/{user_id}/reset-password': {
      post: {
        tags: ['พนักงาน'],
        summary: 'รีเซ็ตรหัสผ่านพนักงาน (ได้รหัสชั่วคราว ต้องเปลี่ยนหลังล็อกอิน)',
        operationId: 'resetStaffPassword',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'user_id', in: 'path', required: true, schema: uuid }],
        requestBody: { required: true, content: json({ type: 'object', required: ['restaurant_id'], properties: { restaurant_id: uuid } }) },
        responses: {
          '200': { description: 'รหัสชั่วคราว (แสดงครั้งเดียว)', content: json({ type: 'object', properties: { user_id: uuid, temp_password: { type: 'string' } } }) },
          '400': err('ข้อมูลไม่ถูกต้อง หรือรีเซ็ตรหัสตัวเอง', ['invalid_user_id', 'invalid_restaurant_id', 'use_change_password']),
          '401': authErrors['401'],
          '403': err('บทบาทไม่พอ หรือผู้จัดการรีเซ็ตเจ้าของ/ผู้จัดการ', ['forbidden']),
          '404': err('ไม่พบพนักงานในร้านนี้', ['not_found']),
        },
      },
    },

    '/api/staff': {
      get: {
        tags: ['พนักงาน'],
        summary: 'รายชื่อพนักงานในร้าน',
        operationId: 'listStaff',
        security: [{ bearerAuth: [] }],
        parameters: [restaurantQuery],
        responses: {
          '200': {
            description: 'รายชื่อพร้อมอีเมล',
            content: json(
              { type: 'object', required: ['staff'], properties: { staff: { type: 'array', items: { $ref: '#/components/schemas/StaffMember' } } } },
              { staff: [{ user_id: '00000000-0000-4000-8000-000000000004', email: 'owner@example.com', roles: ['owner'] }] },
            ),
          },
          ...authErrors,
        },
      },
      post: {
        tags: ['พนักงาน'],
        summary: 'เพิ่มพนักงาน (ถ้ายังไม่มีบัญชีจะสร้างให้พร้อมรหัสชั่วคราว)',
        operationId: 'addStaff',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: json(
            {
              type: 'object',
              required: ['restaurant_id', 'email', 'roles'],
              properties: { restaurant_id: uuid, email: { type: 'string', format: 'email', maxLength: 254 }, display_name: { type: 'string', maxLength: 80 }, roles, role: legacyRole },
            },
            { restaurant_id: '00000000-0000-4000-8000-000000000003', email: 'cook@example.com', roles: ['kitchen', 'stock'] },
          ),
        },
        responses: {
          '201': {
            description: 'เพิ่มแล้ว',
            content: json({
              type: 'object',
              required: ['user_id', 'email', 'roles', 'created'],
              properties: {
                user_id: uuid,
                email: { type: 'string' },
                roles,
                created: { type: 'boolean', description: 'true = สร้างบัญชีใหม่' },
                temp_password: { type: 'string', description: 'รหัสชั่วคราว (เฉพาะบัญชีใหม่ แสดงครั้งเดียว) พนักงานต้องเปลี่ยนหลังล็อกอินครั้งแรก' },
              },
            }),
          },
          '400': err('อีเมลหรือบทบาทไม่ถูกต้อง', ['invalid_email', 'invalid_role', 'invalid_restaurant_id']),
          '401': authErrors['401'],
          '403': err('บทบาทไม่พอ หรือผู้จัดการพยายามแต่งตั้งเจ้าของ/ผู้จัดการ', ['forbidden', 'role_not_allowed']),
          '409': err('เป็นพนักงานของร้านนี้อยู่แล้ว', ['duplicate']),
        },
      },
    },

    '/api/staff/{user_id}': {
      patch: {
        tags: ['พนักงาน'],
        summary: 'ตั้งบทบาท (แทนที่ทั้งชุด)',
        operationId: 'changeStaffRole',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'user_id', in: 'path', required: true, schema: uuid }],
        requestBody: {
          required: true,
          content: json(
            { type: 'object', required: ['restaurant_id', 'roles'], properties: { restaurant_id: uuid, roles, role: legacyRole } },
            { restaurant_id: '00000000-0000-4000-8000-000000000003', roles: ['staff', 'accountant'] },
          ),
        },
        responses: {
          '200': { description: 'บทบาทหลังบันทึก', content: json({ type: 'object', properties: { user_id: uuid, roles } }) },
          '400': err('ข้อมูลไม่ถูกต้อง', ['invalid_user_id', 'invalid_role', 'invalid_restaurant_id']),
          '401': authErrors['401'],
          '403': err('บทบาทไม่พอ หรือผู้จัดการพยายามแต่งตั้งเจ้าของ/ผู้จัดการ', ['forbidden', 'role_not_allowed']),
          '404': err('ไม่พบพนักงานในร้านนี้', ['not_found']),
          '409': err('ร้านต้องมีเจ้าของอย่างน้อย 1 คน', ['last_owner']),
        },
      },
      delete: {
        tags: ['พนักงาน'],
        summary: 'นำพนักงานออกจากร้าน',
        operationId: 'removeStaff',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'user_id', in: 'path', required: true, schema: uuid }, restaurantQuery],
        responses: {
          '200': { description: 'นำออกแล้ว', content: json({ type: 'object', properties: { removed: uuid } }) },
          '400': err('ข้อมูลไม่ถูกต้อง', ['invalid_user_id', 'invalid_restaurant_id']),
          '401': authErrors['401'],
          '403': authErrors['403'],
          '404': err('ไม่พบพนักงานในร้านนี้', ['not_found']),
          '409': err('ร้านต้องมีเจ้าของอย่างน้อย 1 คน', ['last_owner']),
        },
      },
    },

    ...accountingPaths,
    ...stockPaths,
    '/api/openapi.json': {
      get: {
        tags: ['ระบบ'],
        summary: 'เอกสาร OpenAPI (ไฟล์นี้)',
        operationId: 'openapi',
        security: [],
        responses: { '200': { description: 'OpenAPI 3.1 JSON', content: json({ type: 'object' }) } },
      },
    },
    '/api/docs': {
      get: {
        tags: ['ระบบ'],
        summary: 'หน้า Swagger UI',
        operationId: 'swaggerUi',
        security: [],
        responses: { '200': { description: 'หน้า HTML', content: { 'text/html': { schema: { type: 'string' } } } } },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'access_token ของ Supabase Auth (ผู้ใช้ที่ล็อกอินที่หน้าเว็บ)',
      },
    },
    schemas: {
      ...accountingSchemas,
      ...stockSchemas,
      Error: {
        type: 'object',
        required: ['error'],
        properties: { error: { type: 'string' }, message: { type: 'string', description: 'ข้อความภาษาไทย (บางกรณี)' } },
      },
      Suggestion: {
        type: 'object',
        required: ['key', 'title', 'reason', 'promo', 'source'],
        properties: {
          key: { type: 'string' },
          title: { type: 'string' },
          reason: { type: 'string' },
          source: { type: 'string', enum: ['rule', 'ai'] },
          promo: {
            type: 'object',
            required: ['name', 'discount_type', 'value', 'min_subtotal', 'start_time', 'end_time', 'item_ids'],
            properties: {
              name: { type: 'string', maxLength: 80 },
              discount_type: { type: 'string', enum: ['percent', 'amount'] },
              value: { type: 'number' },
              min_subtotal: { type: 'number' },
              start_time: { type: ['string', 'null'], description: 'HH:MM' },
              end_time: { type: ['string', 'null'], description: 'HH:MM' },
              item_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, description: 'ว่าง = ลดทั้งบิล' },
            },
          },
        },
      },
      ImportResult: {
        type: 'object',
        required: ['batch_id', 'dry_run', 'blocked', 'orders', 'lines', 'skipped_lines', 'unknown_items'],
        properties: {
          batch_id: { type: ['string', 'null'], format: 'uuid', description: 'ใช้ย้อนการนำเข้า (null เมื่อ dry_run หรือ blocked)' },
          dry_run: { type: 'boolean' },
          blocked: { type: 'boolean', description: 'true = มีชื่อเมนูที่ไม่รู้จักและไม่ได้ส่ง skip_unknown จึงไม่นำเข้าอะไรเลย' },
          orders: { type: 'integer' },
          lines: { type: 'integer' },
          skipped_lines: { type: 'integer' },
          unknown_items: { type: 'array', items: { type: 'string' } },
        },
        example: { batch_id: '00000000-0000-4000-8000-000000000005', dry_run: false, blocked: false, orders: 3, lines: 4, skipped_lines: 0, unknown_items: [] },
      },
      StaffMember: {
        type: 'object',
        required: ['user_id', 'email', 'roles'],
        properties: { user_id: uuid, email: { type: 'string' }, display_name: { type: ['string', 'null'] }, roles },
      },
      Facts: {
        type: 'object',
        description: 'ตัวเลขที่ฐานข้อมูลคำนวณแล้ว และส่งให้ Gemini',
        properties: {
          period_days: { type: 'integer' },
          orders: { type: 'integer', description: 'ออเดอร์ที่ไม่ถูกยกเลิก' },
          revenue_paid_baht: { type: 'number', description: 'รายรับเฉพาะออเดอร์ที่ชำระแล้ว' },
          avg_bill_baht: { type: ['number', 'null'] },
          avg_kitchen_minutes: { type: ['number', 'null'] },
          first_order_at: { type: ['string', 'null'] },
          peak_hours: { type: 'array', items: { type: 'string' }, examples: [['12:00–13:00', '18:00–20:00']] },
          off_peak_hours: { type: 'array', items: { type: 'string' } },
          orders_by_hour: { type: 'object', additionalProperties: { type: 'number' } },
          orders_by_weekday: { type: 'object', additionalProperties: { type: 'number' } },
          rule_based_insights: { type: 'array', items: { type: 'string' } },
          top_items: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'number' }, revenue_baht: { type: 'number' } } },
          },
          menu_food_cost: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                price_baht: { type: 'number' },
                ingredient_cost_baht: { type: 'number' },
                food_cost_percent: { type: ['number', 'null'] },
              },
            },
          },
          menus_without_recipe: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

// หน้า Swagger UI (โหลดจาก CDN แบบระบุเวอร์ชัน)
const SWAGGER_VERSION = '5.17.14'
export const swaggerHtml = `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Plato API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui.css" />
<style>body{margin:0;background:#fff}</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui-bundle.js" crossorigin></script>
<script>
  window.ui = SwaggerUIBundle({
    url: './openapi.json',
    dom_id: '#swagger-ui',
    persistAuthorization: true,
    tryItOutEnabled: true,
    displayRequestDuration: true,
  })
</script>
</body>
</html>`
