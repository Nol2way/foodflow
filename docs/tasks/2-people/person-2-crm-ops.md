# ใบงานคนที่ 2 — สายสมาชิก/PDPA, โปรโมชัน, รายงาน LINE/Import, ธีม & ระบบกลาง (Fullstack)

ทำครบทั้ง **Frontend + Backend + SQL** ในโดเมนของตัวเอง · อ่านกติกากลางที่ [README.md](README.md) · ช่วงเลข Migration: **`0020–0029`**

---

## ส่วน A: งานแก้บั๊ก (6 งาน — เฟส 1)

### 🔴 P0 — ด่วนมาก
- [ ] **`P2-B1` [BE Security] ปิดช่องโหว่ล้าง Rate Limiter ทั้งระบบใน `guards.ts`**
  - **ไฟล์:** `backend/src/guards.ts` (L9–22), `backend/src/app.ts` (L161–162)
  - **ปัญหา:** เมื่อไม่มี KV binding โค้ดเรียก `memory.clear()` ทันทีเมื่อ Map เกิน 10,000 รายการ ทำให้ผู้โจมตีส่ง login อีเมลมั่ว 10,001 ครั้งแล้วล้าง rate limit ทั้งระบบได้
  - **วิธีแก้:** ลบเฉพาะ entry ที่หมดอายุแล้วหรือทำ LRU eviction แทน `memory.clear()` และแยก bucket ของ IP กับ Email

### 🟠 P1 — สำคัญ
- [ ] **`P2-B2` [FE] แก้บั๊กจัดการโปรโมชัน 3 จุด**
  - **ไฟล์:** `frontend/src/pages/Promotions.tsx` (L98–164, L219, L257)
  - **ปัญหา:** (1) `promotion_items` insert พังแล้วกลายเป็นโปรลดทั้งบิลเงียบๆ (2) `minEnd` ไม่เช็ค `original.ends_on` ทำให้แก้โปรที่หมดอายุแล้วไม่ได้ (3) ไม่มี `saving` guard กดสร้างเบิ้ลได้
  - **วิธีแก้:** ตรวจ error ทุกขั้นตอน, แก้ `minEnd` ให้รองรับ `original.ends_on`, เพิ่ม `saving` guard

- [ ] **`P2-B3` [FE + SQL] แก้ระบบสมาชิกและแต้มสะสมครบวงจร**
  - **ไฟล์:** `database/migrations/0002_display_payment_reports.sql` (L652–656), `frontend/src/pages/Settings.tsx` (L57–60, L119–131), `frontend/src/pages/Members.tsx` (L22–71, L129), `frontend/src/pages/Counter.tsx` (L185–198), `frontend/src/components/MemberBox.tsx` (L61–96)
  - **ปัญหา:**
    1. `reverse_order_points()` บังคับ `members.points >= 0` แต่ลง `point_ledger` ด้วยค่าเต็ม ทำให้แต้มจริงเพี้ยนจาก ledger ถาวร
    2. ช่องตั้งค่าแต้มใน `Settings.tsx` ลบเลขไม่ได้ / พิมพ์ทศนิยม `< 1` ไม่ได้
    3. `Members.tsx`: `adjust()` กดเบิ้ลได้, ค้นชื่อที่มีตัวเลขไม่เจอ, แคชหลักถูกผลค้นหาทับ, `loadLedger` ขาด sequence guard
    4. `Counter`/`MemberBox`: ไม่ลดเพดาน `redeem` ตามเมื่อยอด `payable` ลดลง
  - **วิธีแก้:** บันทึกผลต่างแต้มจริงลง `point_ledger`, เก็บ input เป็น string ระหว่างพิมพ์ใน `Settings.tsx`, เพิ่ม `busy` guard/แยก search cache ใน `Members.tsx`, และ clamp `redeem` แบบ reactive

- [ ] **`P2-B4` [BE + SQL] แก้สิทธิ์ `DELETE /api/staff/:userId` และปิดช่องโหว่ SQL 3 จุด**
  - **ไฟล์:** `backend/src/app.ts` (L424–432), `database/migrations/0001_core.sql` (L1687–1696), `0003_users_inventory.sql` (L99–140)
  - **วิธีแก้:**
    1. เพิ่ม `managerBlocked` ใน `DELETE /api/staff/:userId` ให้คืน `403` แทน `404`
    2. เพิ่มเช็ค `is_staff_of(...)` ใน `promotion_uses_count` และ `staff_is_senior` กัน cross-tenant oracle
    3. ล็อกแถว `restaurants FOR UPDATE` ใน `keep_last_owner()` กัน MVCC race ลบเจ้าของ 2 คนพร้อมกัน

### 🟡 P2 — เสถียรภาพและ Edge cases
- [ ] **`P2-B5` [BE + FE] แก้ Cron รายงานรายวัน และ race condition หน้า Report**
  - **ไฟล์:** `backend/src/reports.ts` (L19–35), `frontend/src/pages/Report.tsx` (L16–29)
  - **วิธีแก้:** กัน `REPORT_HOUR=""` ไม่ให้กลายเป็น `0` (และถ้าตั้งเที่ยงคืนให้ดึงรายงานของเมื่อวาน), เพิ่ม sequence/cancellation guard ใน `Report.tsx` กันเปลี่ยนวันที่เร็วๆ แล้วข้อมูลวันเก่าทับ cache วันใหม่

- [ ] **`P2-B6` [BE + FE] แก้ CSV Parser พังเมื่อเจอ `"` กลางคำ และ Import ไม่ล้างไฟล์เก่า**
  - **ไฟล์:** `backend/src/csv.ts` (L38), `frontend/src/pages/Import.tsx` (L33–51)
  - **วิธีแก้:** เปลี่ยนเงื่อนไขเริ่ม quoted field เป็น `ch === '"' && field === ''` ใน `csv.ts`, และล้าง `csv`/`fileName` ใน `Import.tsx` เมื่อเลือกไฟล์เกิน 3MB หรือกดยกเลิก

---

## ส่วน B: งานฟีเจอร์ใหม่ (5 งาน Fullstack — เฟส 1–3 · ไม่รวม AI)

- [ ] **`P2-F1` ระบบคูปอง & ซ้อนโปรโมชัน + รายงานผลโปรโมชัน** *(เฟส 2)*
  - **DB:** เพิ่ม `promotions.coupon_code` (unique ต่อร้าน) และ `promotions.stackable`, สร้าง `coupon_lookup()`, อัปเดต `apply_promotions()`, สร้าง `promo_report()`
  - **UI:** ช่องกรอกโค้ดใน `PromoPicker.tsx`, ฟอร์มตั้งคูปอง/ซ้อนโปร และแท็บ "ผลลัพธ์" ใน `Promotions.tsx`, อัปเดต `lib/discount.ts` + เทสต์

- [ ] **`P2-F2` สมาชิกหน้าร้าน (ค้น 4 ตัวท้าย) + PDPA (`/privacy`) + ความพึงพอใจ 1–5 ดาว** *(เฟส 2)*
  - **DB:** RPC `member_find` (ค้นด้วย 4 ตัวท้าย), `member_export`, `member_delete` (เจ้าของเท่านั้น), ตาราง `feedback` (1–5 ดาว ไม่เก็บชื่อ/เบอร์)
  - **UI:** ปรับ `MemberBox.tsx` (ค้นเร็ว + สมัครใหม่ในกล่องเดียว), สร้าง `pages/Privacy.tsx` (`/privacy`), ปุ่ม export/delete ใน `Members.tsx`, ฟอร์มดาวหลังชำระใน `Counter.tsx` + สรุปใน `Report.tsx`

- [ ] **`P2-F3` สรุปยอดตอนเช้าทาง LINE + แจ้งเตือนสต็อกใกล้หมด/ใกล้หมดอายุ + นำเข้า `.xlsx` โดยตรง** *(เฟส 3)*
  - **DB:** เพิ่ม `shop_settings.(morning_report_enabled, morning_report_hour)` และ `morning_report_targets()`
  - **BE + UI:** เพิ่ม `sendMorningDigest()` ใน `reports.ts` (สรุปยอดเมื่อวาน + เมนูขายดี + แจ้งเตือนสต็อกต่ำกว่า Par/ล็อต FEFO ใกล้หมดอายุ โดยไม่ใช้ AI), ช่องตั้งค่าใน `Settings.tsx`, และขยาย `/api/import` + `Import.tsx` ให้รองรับ `.xlsx` โดยตรง

- [ ] **`P2-F4` โหมดมืด (Dark Mode) + สลับภาษา TH/EN** *(เฟส 2)*
  - **UI:** Tailwind v4 `@custom-variant dark` ใน `index.css` + สวิตช์เก็บใน localStorage (ใบเสร็จตอนพิมพ์ต้องเป็นสีสว่างเสมอ) + ระบบแปลภาษา ไทย/อังกฤษ ใน `Settings.tsx` และไล่ตรวจทุกหน้าหลัก

- [ ] **`P2-F5` CI Pipeline + เปิด API & UI ส่วนที่เหลือ (ร่างภาษี, X/Z-Report กะ, เคลมสต็อก, เปิด/ปิดพนักงาน)** *(CI ทำเฟส 1 · API/UI ทำเฟส 3)*
  - **CI:** สร้าง `.github/workflows/ci.yml` รัน frontend build/test + backend typecheck/test + database tests
  - **BE + UI:** เปิด `PATCH/void` ร่างใบกำกับภาษี + `tax_settings`/`pos_terminals` CRUD (`tax.ts`), `GET /shifts` + X-Report (`accounting.ts`), `set_receipt_claim`/`supplier_receiving_report` (`stock.ts`), เปิด/ปิด `app_users.is_active` (`app.ts`), อัปเดต `openapi.ts` และต่อปุ่มหน้าเว็บที่เกี่ยวข้อง
