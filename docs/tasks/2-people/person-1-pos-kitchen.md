# ใบงานคนที่ 1 — สายหน้าร้าน, ออเดอร์, โต๊ะ, เมนู & ครัว (Fullstack)

ทำครบทั้ง **Frontend + Backend + SQL** ในโดเมนของตัวเอง · อ่านกติกากลางที่ [README.md](README.md) · ช่วงเลข Migration: **`0009–0019`**

---

## ส่วน A: งานแก้บั๊ก (6 งาน — เฟส 1)

### 🔴 P0 — ด่วนมาก
- [ ] **`P1-B1` [SQL Security] ปิดช่องโหว่ `UPDATE orders SET status = 'paid'` ข้าม `counter_pay_bill()`**
  - **ไฟล์:** `database/migrations/0001_core.sql` (L377–385, L1063), `0007_order_cancel_kitchen.sql` (L156)
  - **ปัญหา:** พนักงานสามารถยิง PostgREST `PATCH /orders` ตั้ง `status='paid'` ตรงๆ ข้าม `counter_pay_bill()` ทำให้ `payment_method` เป็น `NULL` และข้ามโปรโมชัน/แต้ม
  - **วิธีแก้:** ตั้ง session flag (`set_config('app.in_pay_bill', '1', true)`) ใน `counter_pay_bill()` และให้ `enforce_order_status()` บล็อกการเปลี่ยนเป็น `paid` จากภายนอก

- [ ] **`P1-B2` [FE] แก้ส่งออเดอร์ซ้ำได้ในหน้า POS**
  - **ไฟล์:** `frontend/src/pages/Pos.tsx` (L143–187)
  - **ปัญหา:** เรียก `setSending(false)` (L156) ก่อน `await` รอบที่สอง (L175) และก่อนล้างตะกร้า `setCart({})` (L184) ทำให้กดซ้ำแล้วเกิดออเดอร์เบิ้ล
  - **วิธีแก้:** ย้าย `setSending(false)` ไปไว้ใน `finally` หลังล้างตะกร้าเสร็จ

- [ ] **`P1-B3` [FE] แก้ `cleanStorage()` ลบสื่อจริงทั้งหมด + กันกดซ้ำใน MenuAdmin**
  - **ไฟล์:** `frontend/src/pages/MenuAdmin.tsx` (L83, L114, L153–166, L183, L204)
  - **ปัญหา:** ถ้า `display_media` โหลดพัง โค้ดตั้ง `media = []` เงียบๆ พอกดล้างไฟล์จะลบไฟล์จริงทั้งหมดใน Storage ที่เก่ากว่า 24 ชม. + ปุ่มเพิ่มเมนู/หมวด/โต๊ะไม่มี `saving` guard
  - **วิธีแก้:** แสดง error และปิดปุ่มล้าง Storage เมื่อโหลดพัง + เพิ่ม `saving` guard ให้ปุ่มบันทึกทั้งหมด

### 🟠 P1 — สำคัญ
- [ ] **`P1-B4` [SQL] แก้ยอดบิลติดลบใน `counter_pay_bill()` และ `cancel_order_items()` ล้างโปรทั้งหมด**
  - **ไฟล์:** `database/migrations/0002_display_payment_reports.sql` (L593–605), `0007_order_cancel_kitchen.sql` (L99–111)
  - **ปัญหา:** (1) ปันส่วนลดแต้มข้ามหลายบิล บิลสุดท้ายไม่ cap ด้วย `o.total` ทำให้ยอดติดลบได้ (2) ยกเลิกรายการ 1 จานแล้วมี 1 โปรหลุดเงื่อนไข ระบบเหมารวมล้างโปรอื่นที่ยังใช้ได้ทิ้งหมด
  - **วิธีแก้:** Cap `v_share <= o.total` + เกลี่ยเศษใหม่ (เพิ่ม `CHECK (total >= 0)`) และใน `cancel_order_items()` ให้กรองเฉพาะโปรที่ยังเข้าเงื่อนไขมาคำนวณใหม่

### 🟡 P2 — เสถียรภาพและ UI
- [ ] **`P1-B5` [FE] แก้ error ค้าง/race condition ใน `useOrders`, `cache` และ `.catch()` ใน `PromptPayQR`**
  - **ไฟล์:** `frontend/src/lib/useOrders.ts` (L14–27), `frontend/src/lib/cache.ts` (L22–62), `frontend/src/components/PromptPayQR.tsx` (L11–24)
  - **วิธีแก้:** ล้าง `setError(null)` เมื่อ `reload()` สำเร็จ + เพิ่ม sequence guard, เพิ่ม invalidation epoch ใน `cache.ts`, และเพิ่ม `.catch()` ให้ `QRCode.toString()`

- [ ] **`P1-B6` [FE + SQL] แก้จอแสดงผลลูกค้าไม่แสดง `/กก.` และ multi-touch timer รั่ว**
  - **ไฟล์:** `frontend/src/pages/Display.tsx` (L185, L488–510), `database/migrations/0002_display_payment_reports.sql` (L290)
  - **วิธีแก้:** เพิ่ม `sold_by_weight` ใน `display_content` เพื่อแสดง `/กก.` สำหรับของชั่งน้ำหนัก + เคลียร์ `press.current.timer` ตอน multi-touch และ unmount

---

## ส่วน B: งานฟีเจอร์ใหม่ (5 งาน Fullstack — เฟส 2–3)

- [ ] **`P1-F1` ตัวเลือกเมนูมีราคา (Add-ons) + รูปเมนู** *(เฟส 2)*
  - **DB:** ตาราง `menu_option_groups`, `menu_options`, `order_item_options` + อัปเดต `staff_place_order` และ `bill_receipt`
  - **UI:** ตั้งตัวเลือกและอัปโหลดรูปใน `MenuAdmin.tsx`, Modal เลือกตัวเลือกใน `Pos.tsx`, แสดงตัวเลือกใน `Kitchen.tsx` และ `Receipt.tsx`

- [ ] **`P1-F2` ผังโต๊ะ (`/tables`) + ย้าย/รวมโต๊ะ + ตัวจับเวลาโต๊ะ + ปุ่ม "ขอเช็คบิล"** *(เฟส 2)*
  - **DB:** เพิ่มคอลัมน์ `dining_tables.(pos_x, pos_y, seats, zone, bill_requested_at)` + RPC `staff_move_table`, `staff_set_bill_requested`
  - **UI:** สร้าง `pages/TableMap.tsx` + `lib/tableStatus.ts` (พร้อมเทสต์), จัดตำแหน่งโต๊ะใน `MenuAdmin.tsx`, ปุ่มขอเช็คบิลใน `Serve.tsx` ให้เด่นใน `Counter.tsx`

- [ ] **`P1-F3` แก้ออเดอร์ก่อนครัวเริ่ม + แยกบิล + ประวัติบิล (`/bills`) + ค่าบริการ/ทิป** *(เฟส 3)*
  - **DB:** RPC `staff_edit_order` (เฉพาะ `received`), `staff_split_order`, เพิ่ม `service_charge_pct`/`service_charge`/`tip` ใน `shop_settings`/`orders`/`counter_pay_bill`
  - **UI:** ปุ่มแก้ออเดอร์ (เปิด `Pos.tsx` โหมดแก้), ปุ่มแยกบิล + หารเท่ากันใน `Counter.tsx`, หน้า `pages/Bills.tsx` พิมพ์ซ้ำ/ยกเลิกบิล (เฉพาะเจ้าของ)

- [ ] **`P1-F4` พิมพ์ใบสั่งครัว/ใบเสร็จ 80 มม. + เสียงแจ้งเตือน/เตือนออเดอร์ช้าในครัว** *(เฟส 2)*
  - **DB:** เพิ่ม `shop_settings.auto_print_kitchen` และ `shop_settings.late_order_minutes`
  - **UI:** สร้าง `components/KitchenTicket.tsx` + CSS `@media print` 80 มม., เล่นเสียงเมื่อมีออเดอร์เข้าใหม่ใน `Kitchen.tsx` + ไฮไลต์แดงเมื่อเกินเวลา

- [ ] **`P1-F5` ระบบ Audit Log (`/audit`) + PWA คิวออเดอร์ออฟไลน์ (`client_ref`)** *(เฟส 3)*
  - **DB:** ตาราง `audit_log` (immutable) + `audit_trigger()`, เพิ่ม `orders.client_ref` + unique `(restaurant_id, client_ref)` ใน `staff_place_order`
  - **UI:** หน้า `pages/AuditLog.tsx` (owner/manager), `manifest.webmanifest` + `lib/offlineQueue.ts` (IndexedDB) รับออเดอร์ได้ตอนเน็ตหลุด
