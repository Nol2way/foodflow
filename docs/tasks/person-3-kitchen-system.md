# คน 3: ครัว / ระบบ / อุปกรณ์ (10 แต้ม)

อ่านกติกากลางที่ [README.md](README.md) ก่อน · migration ที่ใช้ได้: **0050–0059**

## ข้อมูลและโค้ดที่มีอยู่แล้ว (ใช้ได้เลย)

| ประเภท | ชื่อ |
|--------|------|
| ตาราง | `orders` (`status` `created_at` `started_at` `ready_at`), `order_items` (`done_at` `served_at`), `staff_members`, `app_users`, `shop_settings`, `menu_items`, `promotions`, `restaurants` |
| ฟังก์ชัน/ทริกเกอร์ | `kitchen_set_item_done(p_item_id, p_done)` · `set_item_served` · `enforce_order_status` · `journal_immutable` (ตัวอย่างทริกเกอร์ห้ามแก้ย้อนหลัง) · `stock_movements_guard` · `has_role` · `is_staff_of` · `staff_set_roles` |
| หน้าเว็บ | `pages/Kitchen.tsx` · `lib/useOrders.ts` (Realtime ช่อง `orders-${restaurantId}-${statusKey}` ฟัง `orders` + `order_items`) · `components/Receipt.tsx` + `bill_receipt` (ใบเสร็จเดิม) · `index.css` · `main.tsx` · `App.tsx` · `lib/session.ts` `lib/auth.ts` |
| ระบบ | `frontend/package.json` (script `test`, `build`, `test:e2e`) · `package.json` ราก (`test:database` ใช้ Postgres ในเครื่อง) · `database/tests/harness.py` · `docs/SETUP.md` · ยังไม่มี `.github/` |

## งาน

### 1. CI (1 แต้ม) — **ทำก่อนเพื่อน**
- สร้าง `.github/workflows/ci.yml` รันเมื่อ push/PR: `npm ci` ใน `frontend` และ `backend` → `npm --prefix frontend run build` (มี `tsc --noEmit`) → `npm --prefix frontend test` → `npm --prefix backend test` → ชุดฐานข้อมูล `python3 database/tests/test_rls.py` และ `test_accounting.py` ด้วย Postgres เป็น service container (ดูวิธีเชื่อมต่อใน `harness.py` ก่อน)
- หมายเหตุ: มีเทสต์หนึ่งที่ผลต่างตามเวลาไทยหลัง 22:00 (ข้อโปรตามช่วงเวลา ดู `docs/testing.md`) ถ้า CI แดงเพราะข้อนี้ให้แก้เทสต์ให้ไม่ขึ้นกับเวลา
- ใส่ป้ายสถานะ CI ใน README

### งานเสริม A: Sentry (1 แต้ม, ไม่นับใน 10 แต้ม — ทำเมื่อมีเวลา)
- ฝั่งหน้าเว็บ: `@sentry/react` เริ่มใน `main.tsx` ด้วย `VITE_SENTRY_DSN` (เพิ่มใน `frontend/.env.example`) ถ้าไม่ตั้งค่าให้ปิดเงียบๆ · ใช้ error boundary ครอบ `App.tsx`
- ฝั่ง backend: จับ error กลางใน `app.ts` (`app.onError`) บันทึกโดยไม่ส่งรหัสผ่าน/โทเคน/เบอร์สมาชิก · ตัวเลือกเสริม ถ้าไม่ตั้ง DSN ไม่ทำอะไร
- **ระวัง:** ห้ามส่ง PII (เบอร์โทร ชื่อสมาชิก) เข้า Sentry ตั้ง `beforeSend` กรอง

### งานเสริม B: สำรองข้อมูล (2 แต้ม, ไม่นับใน 10 แต้ม — ทำเมื่อมีเวลา แต่ควรทำก่อนใช้จริง)
- `scripts/backup.sh` ใช้ `pg_dump` กับ `SUPABASE_DB_URL` (ความลับ ห้ามเข้า repo) + `.github/workflows/backup.yml` ตั้งเวลารายวัน เก็บไฟล์เข้ารหัสไว้ที่จัดเก็บภายนอก (Supabase แผนฟรีไม่มี PITR)
- `docs/backup.md`: วิธีกู้คืนทีละขั้น + **ต้องลองกู้คืนจริงอย่างน้อย 1 ครั้งบนโปรเจกต์ว่าง** แล้วบันทึกวันที่/ผล · อัปเดต NFR-7 ใน `docs/requirements.md` เมื่อทดลองสำเร็จ

### 2. Audit log (2 แต้ม) — **คน 1 รอฟังก์ชันกลางนี้**
- **ตารางใหม่** `audit_log` (`id` `restaurant_id` `actor uuid` `action text` `table_name text` `row_id uuid` `old_data jsonb` `new_data jsonb` `reason text` `at timestamptz default now()`) เก็บได้อย่างเดียว: ไม่มี policy update/delete และมีทริกเกอร์ห้ามแก้ (ทำแบบเดียวกับ `journal_immutable`) · อ่านได้เฉพาะ owner/manager
- **ฟังก์ชันกลาง** `audit_trigger()` ใช้ผูกกับตาราง: `orders` (เปลี่ยน `status` โดยเฉพาะ `cancelled` พร้อม `cancel_reason`), `menu_items` (เปลี่ยน `price` `is_available`), `promotions`, `staff_members`/`app_users` (เปลี่ยนบทบาท), `shop_settings`, `members` (ปรับแต้ม) — **ห้ามผูกกับตารางสต็อก/บัญชี** (มีบันทึกของตัวเองอยู่แล้ว: `stock_movements`, `journal_entries`)
- ใช้ `auth.uid()` เป็น `actor` · ไม่เก็บรหัสผ่าน/ hash (`app_users` ต้องตัดคอลัมน์รหัสออกก่อนเก็บ `old_data`/`new_data`)
- **หน้าเว็บ:** `pages/AuditLog.tsx` route `/audit` สิทธิ์ owner/manager (เพิ่มใน `STAFF_PAGES`) กรองตามวัน/ผู้ทำ/ตาราง
- **เทสต์:** แก้/ลบ audit_log ไม่ได้ (แม้เจ้าของ), staff/kitchen อ่านไม่ได้, ร้านอื่นอ่านไม่ได้, เปลี่ยนราคาเมนูแล้วมีแถวบันทึก

### 3. เสียงแจ้งเตือน + เตือนออเดอร์ช้าในครัว (1 แต้ม)
- `Kitchen.tsx` + `lib/useOrders.ts`: เล่นเสียงเมื่อมี INSERT ใหม่ (ใช้ `<audio>` หรือ Web Audio · เบราว์เซอร์ต้องมีการกดครั้งแรกก่อนจึงเล่นเสียงได้ จึงทำปุ่ม "เปิดเสียง" ที่จำค่าไว้ใน localStorage)
- **คอลัมน์ใหม่** `shop_settings.late_order_minutes int default 15` · ออเดอร์ `received`/`preparing` ที่เกินเวลานับจาก `created_at` ให้ไฮไลต์สีแดง (คำนวณฝั่งหน้าเว็บทุกนาที) · ตั้งค่าที่ `Settings.tsx`

### 4. พิมพ์ใบสั่งครัว/ใบเสร็จ (2 แต้ม) — **ทำหลังคน 1 ตัวเลือกเมนูนิ่งแล้ว**
- ใบเสร็จมีแล้ว (`Receipt.tsx`, `bill_receipt`) เพิ่ม CSS `@media print` ขนาด 80 มม. + ปุ่มพิมพ์ · **ใบสั่งครัว** ใหม่ `components/KitchenTicket.tsx` (โต๊ะ รายการ หมายเหตุ ตัวเลือก เวลา) พิมพ์ได้จาก `Pos.tsx` หลังส่งออเดอร์ และพิมพ์ซ้ำจาก `Kitchen.tsx`
- **คอลัมน์ใหม่** `shop_settings.auto_print_kitchen boolean default false`
- ทดสอบกับเครื่องพิมพ์จริงอย่างน้อย 1 รุ่นผ่านกล่องพิมพ์ของเบราว์เซอร์ (ไม่ต้องทำ ESC/POS ตรง)

### 5. โหมดมืด (1 แต้ม)
- Tailwind v4: ประกาศ `@custom-variant dark` ใน `index.css`, สวิตช์ใน `App.tsx` เก็บค่าใน localStorage (ต้อง try/catch) ตั้งค่าเริ่มต้นตาม `prefers-color-scheme` · ไล่ตรวจทุกหน้า โดยเฉพาะ `Kitchen.tsx` `Pos.tsx` `Counter.tsx` และ `Receipt.tsx` (ใบเสร็จตอนพิมพ์ต้องเป็นสีสว่างเสมอ)

### 6. PWA / ใช้ต่อเมื่อเน็ตหลุด (3 แต้ม) — **เริ่มหลังคน 1 ล็อกโครงสร้าง `staff_place_order` แล้ว**
- `frontend/public/manifest.webmanifest` + service worker (`vite-plugin-pwa`) แคชหน้าเว็บและเมนูล่าสุด
- **คิวออเดอร์ออฟไลน์:** `lib/offlineQueue.ts` เก็บใน IndexedDB (try/catch เสมอ) แสดงป้าย "รอส่ง n รายการ" ส่งอัตโนมัติเมื่อเน็ตกลับมา
- **กันส่งซ้ำ:** เพิ่มพารามิเตอร์ `p_client_ref uuid default null` ให้ `staff_place_order` และคอลัมน์ `orders.client_ref uuid` + unique `(restaurant_id, client_ref)` (ประสานกับคน 1 เป็นผู้แก้ฟังก์ชัน)
- ราคาที่เห็นตอนออฟไลน์เป็นราคาจากแคชเท่านั้น ฐานข้อมูลคิดราคาจริงตอนส่ง ถ้าราคาเปลี่ยนต้องแจ้งพนักงาน · ไม่รองรับ: จ่ายเงิน/ปิดบิลตอนออฟไลน์ (ทำได้เฉพาะรับออเดอร์)
- **เทสต์:** ส่งซ้ำด้วย `client_ref` เดิมได้ออเดอร์เดียว, ออฟไลน์แล้วออนไลน์ ออเดอร์เข้าครัวครบ

## แต้มรวม
งานหลัก: CI 1 + Audit log 2 + เสียงเตือน 1 + พิมพ์ 2 + โหมดมืด 1 + PWA 3 = **10 แต้ม** · งานเสริม (Sentry 1, สำรองข้อมูล 2) ไม่นับ ทำเมื่อมีเวลา

## ลำดับแนะนำ
สัปดาห์ 1: CI → Audit log (ฟังก์ชันกลาง คน 1 รออยู่) · สัปดาห์ 2: เสียงเตือน, โหมดมืด · สัปดาห์ 3: พิมพ์ → PWA (เมื่อ `staff_place_order` ของคน 1 นิ่งแล้ว) · ท้ายสุด: ทดสอบกับ Supabase จริง แล้วค่อยทำงานเสริม
