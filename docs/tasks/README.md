# แบ่งงานทีม (4 คน) — FoodFlow/Plato ร้านเดียว พนักงานสั่งออเดอร์เท่านั้น

| ไฟล์ | ผู้รับผิดชอบ | โดเมน | แต้ม |
|------|--------------|-------|:----:|
| [person-1-orders.md](person-1-orders.md) | คน 1 | ออเดอร์ / บิล | 10 |
| [person-2-analytics.md](person-2-analytics.md) | คน 2 | วิเคราะห์ / AI / เอกสาร | 10 |
| [person-3-kitchen-system.md](person-3-kitchen-system.md) | คน 3 | ครัว / ระบบ / อุปกรณ์ | 10 |
| [person-4-tables-customers.md](person-4-tables-customers.md) | คน 4 | โต๊ะ / ลูกค้าหน้าร้าน | 10 |

แต้ม: S = 1, M = 2, L = 3 (1 แต้ม ≈ 1–2 วัน) · ขอบเขต: ร้านเดียว, พนักงานเป็นคนสั่งเท่านั้น (ไม่มีลูกค้าสั่งเอง ไม่มี Delivery ไม่มีหลายสาขา ไม่มีระบบสมัคร/ชำระเงินรายเดือน) · **สต็อกและบัญชีเป็นของอีกทีม ห้ามแก้ตารางและฟังก์ชันของสองโมดูลนี้ถ้าไม่ได้คุยก่อน**

## กติกากลาง

**โครงสร้างโค้ด**
- ฐานข้อมูล: `database/migrations/` (ล่าสุดตอนนี้ **0030**) · ทดสอบ `database/tests/test_rls.py` + `harness.py` (Postgres ในเครื่อง)
- หน้าเว็บเรียก Supabase ตรงผ่าน `frontend/src/lib/supabase.ts` (ตาราง + `rpc(...)`) ส่วนงานที่ต้องใช้ความลับ/LINE/Gemini ผ่าน backend Hono (`backend/src/app.ts`)
- เพิ่ม endpoint ใหม่ใน backend ต้องเพิ่มใน `backend/src/openapi.ts` แล้วรัน `npm run openapi` (test `openapi.test.ts` เช็คว่าตรงกัน)
- เมนูและสิทธิ์หน้า: `frontend/src/lib/roles.ts` (`STAFF_PAGES`) + route ใน `frontend/src/App.tsx` · สิทธิ์จริงบังคับที่ฐานข้อมูลเสมอ
- บทบาท: `owner` `manager` `staff` `kitchen` `accountant` `stock` · เช็คในฐานข้อมูลด้วย `has_role(restaurant_id, array['owner',...])` และ `is_staff_of(restaurant_id)`

**ข้อห้าม**
- ราคา/ยอดเงินคำนวณที่ฐานข้อมูลเท่านั้น (ห้ามเชื่อยอดจากหน้าเว็บ)
- ฟังก์ชันที่แก้ข้อมูลให้เป็น `security definer set search_path = public, pg_temp` และเช็คสิทธิ์ในฟังก์ชันเอง (แบบเดียวกับ `staff_place_order`)
- ตารางใหม่ทุกตารางต้องมี `restaurant_id`, เปิด RLS, และมี test ใน `test_rls.py`
- บิลที่จ่ายแล้วแก้ไม่ได้ (ดู `0008_order_status_rules.sql`) ห้ามเปิดช่อง

**เลข migration** (ห้ามใช้ข้ามช่วง): คน 1 = 0031–0039 · คน 2 = 0040–0049 · คน 3 = 0050–0059 · คน 4 = 0060–0069 · ทีมสต็อก/บัญชี = 0070+

**Git:** แยก branch ต่อคน (`feat/p1-...`) merge ผ่าน PR ทีละงาน · `App.tsx` `roles.ts` `openapi.ts` ทุกคนต้องแก้ ให้ rebase บ่อยๆ

**นิยามเสร็จของแต่ละงาน:** (1) migration รันบน DB สะอาดผ่าน (2) test ใหม่ผ่านและ `npm test` เดิมไม่พัง (3) หน้าเว็บ build ผ่าน (`npm --prefix frontend run build`) (4) ทดสอบกับ Supabase จริงตามเคสใน `docs/testing.md` แล้วกรอกผล (5) อัปเดตสถานะใน `docs/requirements.md`

## จุดที่งานของคนต่างกันชนกัน

| เรื่อง | ใคร ↔ ใคร | ตกลงว่า |
|--------|-----------|---------|
| ฟังก์ชัน `staff_place_order` | คน 1 ↔ คน 3 (PWA) | คน 1 เป็นเจ้าของฟังก์ชัน ทำตัวเลือกเมนูก่อน (สัปดาห์แรก) แล้วคน 3 ค่อยเพิ่มพารามิเตอร์ `p_client_ref` กันส่งซ้ำ |
| `dining_tables.bill_requested_at` | คน 1 ↔ คน 4 (ผังโต๊ะ) | คน 1 สร้างคอลัมน์ (migration 0031–0039) คน 4 อ่านไปแสดงบนผังโต๊ะ |
| `audit_log` | คน 3 ↔ คน 1 | คน 3 ทำฟังก์ชัน trigger กลางก่อน คน 1 ผูกกับ `orders` (ยกเลิก/แก้ออเดอร์) |
| `counter_pay_bill` | คน 1 ↔ คน 4 (สมาชิก/โปร) | คนเดียวแก้ฟังก์ชันนี้ได้ในแต่ละสัปดาห์ แจ้งในกลุ่มก่อน |
| `shop_settings` (คอลัมน์ใหม่) | ทุกคน | ทุกคนเพิ่มคอลัมน์ผ่าน migration ของตัวเอง ห้ามแก้คอลัมน์เดิม |
