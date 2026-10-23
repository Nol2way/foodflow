# SETUP — วิธีรันและดีพลอย FoodFlow

โปรเจกต์แบ่งเป็น 4 ส่วน

| โฟลเดอร์ | คืออะไร |
|----------|---------|
| `frontend/` | หน้าเว็บ React + Vite (และ `functions/` สำหรับ Cloudflare Pages) |
| `backend/` | API ด้วย Hono (Cloudflare) + Swagger |
| `database/` | SQL migration, ข้อมูลตัวอย่าง, ชุดทดสอบฐานข้อมูล |
| `docs/` | เอกสารทั้งหมด (ไฟล์นี้, API, ออกแบบ, ทดสอบ, `openapi.json`) |

## 1. สิ่งที่ต้องมี

| เครื่องมือ | เวอร์ชันแนะนำ | ตรวจสอบด้วย |
|------------|---------------|-------------|
| Node.js | 22.18 ขึ้นไป (ชุดทดสอบใช้ TypeScript โดยตรง) | `node -v` |
| npm | 10 ขึ้นไป | `npm -v` |
| Git | ล่าสุด | `git --version` |
| Python (เฉพาะทดสอบฐานข้อมูล) | 3.10 ขึ้นไป | `python3 --version` |
| บัญชี Supabase | ฟรีได้ | [supabase.com](https://supabase.com) |
| บัญชี Cloudflare (ตอน deploy) | ฟรีได้ | [cloudflare.com](https://cloudflare.com) |

## 2. ดึงโค้ดและติดตั้ง

```bash
git clone https://github.com/YOUR-USERNAME/foodflow
cd foodflow
npm run install:all      # ติดตั้งทั้ง frontend และ backend
```

## 3. ฐานข้อมูล (`database/`)

1. สร้างโปรเจกต์ใหม่ใน Supabase
2. เปิด **SQL Editor** แล้วรันไฟล์ใน `database/migrations/` **ตามลำดับเลข** (0001 → 0018)

   | ไฟล์ | เนื้อหา |
   |------|---------|
   | `0001_schema.sql` | ตารางหลัก + RLS พื้นฐาน |
   | `0002_customer_ordering.sql` | ฟังก์ชันออเดอร์รุ่นแรก + Realtime (ส่วนลูกค้าสั่งเองถูกยกเลิกใน 0007) |
   | `0003_roles.sql` | บทบาท 5 แบบ + สิทธิ์รายบทบาท + สต็อก |
   | `0004_stock_costs_analytics.sql` | ตัดสต็อกตามสูตร, ต้นทุนต่อเมนู, ฟังก์ชันวิเคราะห์ |
   | `0005_import_and_hardening.sql` | นำเข้ายอดขาย CSV, ฟังก์ชันพนักงาน, กันลบเจ้าของคนสุดท้าย |
   | `0006_accounting_summary.sql` | สรุปบัญชีคำนวณในฐานข้อมูล (ยอดถูกต้องแม้ออเดอร์เกิน 1,000 รายการ) |
   | `0007_staff_ordering.sql` | **พนักงานเป็นผู้รับออเดอร์เท่านั้น** (`staff_place_order`), ปิดการเข้าถึงของผู้ไม่ล็อกอิน, ห้ามแก้ยอดเงินออเดอร์ |
   | `0008_order_status_rules.sql` | บังคับลำดับสถานะออเดอร์ บิลที่ชำระแล้วยกเลิกได้เฉพาะเจ้าของพร้อมเหตุผล บันทึกผู้ยกเลิก |
   | `0009_manager_promotions.sql` | บทบาทผู้จัดการ (เมนู โปรโมชัน พนักงาน นำเข้า CSV) + ระบบโปรโมชันและส่วนลด |
   | `0010_kitchen_item_done.sql` | ครัวติ๊กเสร็จทีละเมนูในออเดอร์ที่กำลังทำ (`kitchen_set_item_done`) + Realtime ของ `order_items` |
   | `0011_item_served.sql` | ติ๊กเสิร์ฟแล้วทีละเมนูในออเดอร์ที่พร้อมเสิร์ฟ (`set_item_served`) |
   | `0012_promotion_rules.sql` | โปร: วันที่ย้อนหลังไม่ได้, จำกัดจำนวนครั้ง, ใช้หลายโปรพร้อมกัน (เมนูไม่ซ้ำ + ทั้งบิล 1 อัน), เลือกโปรตอนรับชำระ (`counter_pay_bill`) |
   | `0013_display_magazine.sql` | จอ iPad แบบแมกกาซีน: เมนู "ร้านแนะนำ" + คำโปรย + รูป/วิดีโอ (Storage bucket `menu-media`), ลิงก์ลับต่อร้าน `/display/<token>` ไม่ต้องล็อกอิน |
   | `0014_display_media.sql` | สื่อบนจอ: หลายรูป/วิดีโอต่อเมนู, ใส่ลิงก์ได้ (YouTube / ไฟล์ https), สไลด์โฆษณาร้าน (ตาราง `display_media`) · `seed_demo.sql` เพิ่มเมนูแนะนำ + รูป/คลิปตัวอย่างจาก Wikimedia Commons |
   | `0015_display_customize.sql` | ปรับแต่งจอ: โปสเตอร์จากเทมเพลต (แก้ต่อได้, `display_media.poster`), ตั้งค่าสี/ฟอนต์/เวลา/สิ่งที่แสดง (`display_settings`) |
   | `0016_manager_accounting.sql` | ผู้จัดการดูบัญชีได้ (สรุปบัญชี รายจ่าย ต้นทุนต่อเมนู) แต่บันทึก/แก้รายจ่ายไม่ได้ |
   | `0017_payment_loyalty.sql` | ตั้งค่าร้าน (พร้อมเพย์ ใบเสร็จ แต้ม LINE), สมาชิกสะสมแต้ม + ประวัติแต้ม, วิธีชำระ, แลกแต้มตอนจ่าย, ใบเสร็จ (`bill_receipt`), ยกเลิกบิลแล้วคืนแต้ม |
   | `0018_reports_insights.sql` | รายงานสรุปรายวัน (`daily_report`) สำหรับหน้าเว็บและ LINE, ข้อมูลแนะนำโปร (`promo_insights`) |

3. ข้อมูลตัวอย่าง (ไม่บังคับ): `database/seed/seed.sql` (ร้าน เมนู โต๊ะ) → `database/seed/seed_demo.sql` (ออเดอร์ทดลองย้อนหลัง 6 สัปดาห์ สูตรอาหาร ต้นทุนสมมติ) → `database/seed/seed_test_users.sql` (บัญชีทดสอบครบทุกบทบาท ล็อกอินได้ทันที รหัสผ่านดูที่ต้นไฟล์ · มีคำสั่งลบอยู่ท้ายไฟล์)
4. สร้าง **เจ้าของร้านคนแรก** ที่ **Authentication → Users** แล้วผูกกับร้านด้วย SQL ที่คอมเมนต์ไว้ท้าย `seed.sql` (บทบาท `owner`) พนักงานคนต่อไปเจ้าของเพิ่ม/เชิญเองได้ที่หน้า `/staff`
5. ไปที่ **Authentication → URL Configuration** ตั้ง **Site URL** เป็นที่อยู่เว็บ (ตอนพัฒนา `http://localhost:5173`) และเพิ่ม **Redirect URLs** เป็น `<ที่อยู่เว็บ>/set-password` เพื่อให้ลิงก์เชิญพนักงานและลืมรหัสผ่านพามาหน้าตั้งรหัสผ่าน
6. ไปที่ **Project Settings → API** คัดลอก `Project URL`, `anon key` และ `service_role key`

> ⚠️ `service_role key` ใช้ฝั่ง backend เท่านั้น ห้ามใส่ใน frontend และห้าม commit

## 4. Backend (`backend/`)

```bash
cd backend
cp .dev.vars.example .dev.vars   # กรอก SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY
# แก้ SUPABASE_URL และ SUPABASE_ANON_KEY ใน wrangler.toml ส่วน [vars]
npm run dev                      # http://localhost:8787
```

- ตรวจว่าทำงาน: <http://localhost:8787/api/health>
- **Swagger UI:** <http://localhost:8787/api/docs> (ทดลองเรียก API ได้จากหน้านี้ ดูวิธีใส่ token ที่หัวหน้า)
- ไฟล์ spec: `/api/openapi.json` หรือ `docs/openapi.json` (เปิดใน Postman / Swagger Editor ได้)
- แก้ endpoint แล้วต้องแก้ `backend/src/openapi.ts` และรัน `npm run openapi` (ชุดทดสอบจะฟ้องถ้าเอกสารไม่ตรงกับ route)

| ตัวแปร | ที่ตั้ง | หมายเหตุ |
|--------|--------|----------|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | `wrangler.toml` | เปิดเผยได้ |
| `SUPABASE_SERVICE_ROLE_KEY` | `.dev.vars` / secret | ความลับ |
| `GEMINI_API_KEY` | `.dev.vars` / secret | ไม่ตั้ง = ปิดฟีเจอร์ AI ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)) · แนะนำโปรยังใช้ได้ (คิดจากกติกา) |
| `LINE_CHANNEL_ACCESS_TOKEN` | `.dev.vars` / secret | ไม่ตั้ง = ส่งรายงานเข้า LINE อัตโนมัติไม่ได้ (ยังกดแชร์เข้า LINE เองได้) |
| `REPORT_HOUR` | `wrangler.toml` | ชั่วโมงที่ส่งรายงานรายวัน (เวลาร้าน) ค่าเริ่มต้น 22 |

### รายงานรายวันทาง LINE (ไม่บังคับ)

LINE Notify ปิดบริการแล้วตั้งแต่ 31 มี.ค. 2025 จึงใช้ **LINE Messaging API** ผ่าน LINE Official Account ของร้าน

1. สร้าง LINE Official Account และเปิด Messaging API ที่ [LINE Developers Console](https://developers.line.biz/console/)
2. ในแท็บ Messaging API กด Issue **Channel access token (long-lived)** → ตั้งเป็น secret `LINE_CHANNEL_ACCESS_TOKEN`
3. ให้ผู้รับ (เจ้าของร้าน) เพิ่มบัญชีร้านเป็นเพื่อน แล้วนำ **userId** (ขึ้นต้นด้วย `U` ยาว 33 ตัว ดูได้ที่แท็บ Basic settings ของ channel ช่อง Your user ID) หรือ groupId ไปใส่ที่หน้า **ตั้งค่าร้าน**
4. ทดสอบที่หน้า **รายงานรายวัน** ปุ่ม "ส่งเข้า LINE ร้านตอนนี้"
5. ส่งอัตโนมัติทุกวันด้วย Cron ของ Worker (`[triggers]` ใน `wrangler.toml`) **ใช้ได้เฉพาะดีพลอยแบบ Worker** (Cloudflare Pages Functions ไม่มี Cron)

## 5. Frontend (`frontend/`)

```bash
cd frontend
cp .env.example .env
npm run dev                      # http://localhost:5173
```

| ตัวแปรใน `frontend/.env` | ใช้ทำอะไร |
|--------------------------|-----------|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | เชื่อม Supabase (เปิดเผยได้ คุมสิทธิ์ด้วย RLS) |
| `VITE_API_URL` | ที่อยู่ backend · ตอนพัฒนา `http://localhost:8787` · เว็บจริงแบบ Pages เว้นว่าง |

**ทดลองใช้:** ล็อกอินที่ `/login` ด้วยบัญชีหน้าร้าน (`staff`) หรือเจ้าของ → `/pos` เลือกโต๊ะ เลือกเมนู กด **ส่งเข้าครัว** → เปิด `/kitchen` อีกเครื่อง/อีกแท็บด้วยบัญชีครัว จะเห็นออเดอร์ขึ้นทันที → เสิร์ฟแล้วรับชำระที่ `/counter` · หน้าอื่นตามบทบาท: `/accounting` · `/stock` · `/analytics` (+ AI) · `/menu` · `/promotions` · `/import` · `/staff`

## 6. Deploy

**แบบ A (แนะนำ) Cloudflare Pages: หน้าเว็บ + API โดเมนเดียวกัน**

| ค่าใน Pages → Settings → Build | |
|------|------|
| Root directory | `frontend` |
| Build command | `npm run build:pages` (ติดตั้งแพ็กเกจ backend ก่อน แล้ว build หน้าเว็บ) |
| Build output | `dist` |

ตั้งตัวแปรที่ Pages → Settings → Variables and Secrets: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` และ secret `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY` · เว้น `VITE_API_URL` ว่าง · push ขึ้น `main` แล้วได้ทั้งเว็บและ `/api/*` (Swagger ที่ `/api/docs`)

**แบบ B Worker แยก:**
```bash
cd backend
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY   # ทำซ้ำกับ GEMINI_API_KEY
npm run deploy                                      # ต้องสั่งเองทุกครั้งที่แก้ backend
```
แล้วตั้ง `ALLOWED_ORIGINS` (ใน `wrangler.toml`) เป็นโดเมนหน้าเว็บ และ `VITE_API_URL` ของหน้าเว็บเป็นที่อยู่ Worker

## 7. ปัญหาที่พบบ่อย

| อาการ | สาเหตุ | วิธีแก้ |
|-------|--------|---------|
| หน้าเว็บขึ้นว่ายังไม่ได้ตั้งค่า Supabase | ไม่มี `frontend/.env` หรือยังไม่ restart | สร้าง/แก้ `.env` แล้วรัน `npm run dev` ใหม่ |
| `/import`, `/staff`, AI ขึ้น "เชื่อมต่อ backend ไม่ได้" | ยังไม่ได้รัน backend หรือ `VITE_API_URL` ผิด | ดูหัวข้อ 4–5 |
| เรียก API แล้ว 404 บนเว็บจริง | ลืม deploy Worker (แบบ B) / Pages ไม่ได้ตั้ง Root directory = `frontend` | ดูหัวข้อ 6 |
| Pages build ไม่ผ่าน: หา `hono` ไม่เจอ | Build command ไม่ใช่ `npm run build:pages` | แก้ Build command |
| Swagger ขึ้นหน้าว่าง | เครือข่ายบล็อก `cdn.jsdelivr.net` | เปิดไฟล์ `docs/openapi.json` ใน [editor.swagger.io](https://editor.swagger.io) แทน |
| AI ตอบ "ยังไม่ได้ตั้งค่า GEMINI_API_KEY" | ไม่ได้ใส่ key | ใส่ใน `.dev.vars` / secret แล้วรันใหม่ |
| หน้ารับออเดอร์ไม่มีเมนู/โต๊ะ หรือส่งเข้าครัวไม่ได้ | ยังไม่ได้รัน 0007 หรือบัญชีไม่ใช่ `owner`/`staff` | รัน migration ครบ ตรวจบทบาท |
| ส่งออเดอร์แล้วขึ้น "... หมดแล้ว" | เมนูถูกตั้งเป็นหมดระหว่างเลือก | เอาเมนูนั้นออกแล้วส่งใหม่ |
| ออเดอร์ไม่ขึ้นหน้าจอครัว | ยังไม่เปิด Realtime ให้ `orders` | Supabase → Database → Replication |
| `permission denied` / แก้ข้อมูลไม่ได้ | บทบาทไม่มีสิทธิ์ตามตารางใน README | ตรวจบทบาทใน `staff_members` |
| รับเข้า/ตัดสต็อกแล้ว error | สต็อกไม่พอ หรือบทบาทไม่ใช่ `owner`/`stock` | ตรวจจำนวนคงเหลือและบทบาท |

## 8. การทดสอบ

รันจากโฟลเดอร์หลัก

| คำสั่ง | ทดสอบอะไร | ต้องมี |
|--------|-----------|--------|
| `npm test` | รันทั้ง 3 ชุดด้านล่าง | ทุกอย่างด้านล่าง |
| `npm run test:e2e` | หน้าเว็บจริงกับ Supabase จริง (ดูหัวข้อด้านล่าง) | migration + บัญชีทดสอบ + Chromium ของ Playwright |
| `npm run test:frontend` | ฟังก์ชันจัดช่วงพีค/ออฟพีค คาดการณ์ ข้อความสรุป | Node 22.18+ |
| `npm run test:backend` | ทุก endpoint (Supabase/Gemini จำลอง), ตัวอ่าน CSV, Swagger ตรงกับ route | `npm run install:all` |
| `npm run test:database` | migration ทั้งหมด + สิทธิ์ทุกบทบาท + สต็อก + วิเคราะห์ + นำเข้า CSV + พนักงาน บน Postgres ชั่วคราว | `pip install pixeltable-pgserver "psycopg[binary]"` |

> ชุดทดสอบฐานข้อมูลจำลอง auth ของ Supabase ด้วย stub จึงไม่ใช่ Supabase จริง · การทดสอบหน้าเว็บจริง (E2E) ดูหัวข้อถัดไป

### ทดสอบหน้าเว็บจริง (E2E ด้วย Playwright)

เปิดเบราว์เซอร์กดหน้าเว็บจริง ต่อ Supabase จริง ด้วยบัญชีทดสอบ

1. ในโปรเจกต์ Supabase ที่ใช้ทดสอบ: รัน migration ครบ + `seed.sql` + `seed_test_users.sql`
2. ครั้งแรก: `cd frontend && npx playwright install chromium`
3. รัน `npm run test:e2e` (ใช้ dev server ที่เปิดอยู่ที่พอร์ต 5173 หรือเปิดให้เอง) · ผลแบบละเอียด: `npx playwright show-report e2e-report`

| ไฟล์ | ทดสอบอะไร |
|------|-----------|
| `e2e/roles.spec.ts` | ทุกบทบาทเห็นเมนูตรงสิทธิ์, บัญชีไม่มีบทบาท, ครัวเข้าหน้าบัญชีไม่ได้, ผู้จัดการดูบัญชีอย่างเดียว, ร้านอื่นไม่เห็นเมนูร้านเรา (ไม่แก้ข้อมูล) |
| `e2e/order-flow.spec.ts` | รับออเดอร์ → ครัว → เสิร์ฟ → รับชำระ → ใบเสร็จ → รายงานรายวัน (**สร้างออเดอร์จริง** ชื่อลูกค้า `E2E-...`) |

- รหัสผ่านอ่านจาก `v_password` ใน `seed_test_users.sql` (หรือตั้ง `E2E_PASSWORD`) · ทดสอบเว็บที่อื่น: ตั้ง `E2E_BASE_URL`
- ส่วนที่ต้องมี migration ใหม่ (ใบเสร็จ 0017, รายงาน 0018) ถ้ายังไม่รันจะข้าม/เตือน ไม่ล้ม
- ลบออเดอร์ที่ E2E สร้าง: `delete from orders where customer_label like 'E2E-%';`

**ลบข้อมูลทดลองก่อนใช้งานจริง:** `delete from orders where is_demo;`
