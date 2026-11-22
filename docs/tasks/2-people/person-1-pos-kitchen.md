# ใบงานคนที่ 1 — หน้าร้าน, ออเดอร์, โต๊ะ, เมนู และครัว

รับผิดชอบ Frontend, Backend และ SQL ในโดเมนนี้ ใช้ migration ช่วง `0009–0019` ตาม [แผนส่งมอบ](README.md) สถานะด้านล่างอ้างอิงซอร์สปัจจุบัน

## บั๊ก 6 งาน · เฟส 1

### P0

- [ ] **`P1-B1` [SQL] ให้การเปลี่ยนออเดอร์เป็น `paid` ผ่านขั้นตอนรับชำระ**
  - ปัจจุบัน policy ของ `orders` และ `enforce_order_status()` ยังอนุญาตให้หน้าร้านเปลี่ยนสถานะเป็น `paid` โดยตรง จึงข้ามการบันทึกวิธีชำระ โปรโมชัน และแต้มใน `counter_pay_bill()` ได้
  - บังคับให้การรับชำระผ่าน RPC และทดสอบสิทธิ์ของเจ้าของ หน้าร้าน และครัว รักษาการเสิร์ฟและการยกเลิกที่อนุญาต รวมงานแก้ฟังก์ชันรับชำระกับ `P1-B4`
  - ซอร์ส `database/migrations/0001_core.sql`, `database/migrations/0002_display_payment_reports.sql`, `database/migrations/0007_order_cancel_kitchen.sql`

- [ ] **`P1-B2` [FE] กันส่งออเดอร์ซ้ำใน POS**
  - `send()` มี `sending` guard แล้ว แต่ปลดก่อนอ่านยอดที่บันทึกและล้างตะกร้า ล็อกการส่งตลอดขั้นตอนและคืนสถานะใน `finally` ทดสอบกดซ้ำระหว่างรออ่านยอดและเมื่อ RPC ล้มเหลว
  - ซอร์ส `frontend/src/pages/Pos.tsx`

- [ ] **`P1-B3` [FE] ตรวจรายการสื่อก่อนล้าง Storage และกันกดบันทึกซ้ำ**
  - เมื่ออ่าน `display_media` ล้มเหลว หน้าใช้รายการว่างและการล้างไฟล์อาจลบสื่อที่ยังใช้งานอยู่ ให้ล้างได้เมื่ออ่านข้อมูลอ้างอิงครบและเป็นปัจจุบันเท่านั้น แสดงข้อผิดพลาดและกันกดล้างซ้ำ
  - เพิ่มสถานะบันทึกสำหรับฟอร์มเมนู หมวด และโต๊ะ ทดสอบทั้งโหลดสื่อล้มเหลวและร้านที่ไม่มีสื่อจริง
  - ซอร์ส `frontend/src/pages/MenuAdmin.tsx`, `frontend/src/lib/media.ts`

### P1

- [ ] **`P1-B4` [SQL] รักษายอดต่อออเดอร์และโปรที่ยังเข้าเงื่อนไข**
  - `counter_pay_bill()` จำกัดส่วนแบ่งส่วนลดจากแต้มสำหรับแถวก่อนหน้าแล้ว แต่แถวสุดท้ายยังรับเศษทั้งหมด ให้กระจายเศษภายในยอดคงเหลือและรักษาผลรวมส่วนลดตามยอดแลกจริง ตรวจข้อมูลเดิมก่อนเพิ่ม constraint ยอดไม่ติดลบ
  - `cancel_order_items()` คำนวณโปรใหม่ทั้งชุดแล้วล้างทั้งหมดเมื่อเกิดข้อผิดพลาด ให้ประเมินและเก็บโปรที่ยังเข้าเงื่อนไข และปล่อยข้อผิดพลาดอื่นให้ยกเลิกธุรกรรม
  - ซอร์ส `database/migrations/0002_display_payment_reports.sql`, `database/migrations/0007_order_cancel_kitchen.sql`, `database/migrations/0001_core.sql` (`apply_promotions`)

### P2

- [ ] **`P1-B5` [FE] จัดการข้อผิดพลาดและผลตอบกลับเก่าในออเดอร์ แคช และ QR**
  - ใน `useOrders` ล้าง error เมื่อโหลดสำเร็จและรับเฉพาะผลของคำขอล่าสุดสำหรับ key ปัจจุบัน
  - `cache` มีการเทียบ Promise ระหว่างคำขอที่ค้างอยู่แล้ว แต่ผลเก่ายังเขียนแคชได้เมื่อคำขอใหม่จบก่อน หรือหลัง invalidate/clear ให้ผูกสิทธิ์เขียนกับคำขอและรุ่นแคชที่ยังใช้งานอยู่
  - ใน `PromptPayQR` จัดการ Promise rejection ของ `QRCode.toString()` และซ่อน QR เก่าเมื่อสร้าง QR สำหรับยอดใหม่ไม่สำเร็จ
  - ซอร์ส `frontend/src/lib/useOrders.ts`, `frontend/src/lib/cache.ts`, `frontend/src/components/PromptPayQR.tsx`

- [ ] **`P1-B6` [FE + SQL] แสดงราคาต่อกิโลกรัมบนจอลูกค้าและเก็บกวาดตัวจับเวลาการกด**
  - เมนูมี `sold_by_weight` อยู่แล้ว แต่ `display_content` ยังไม่ส่งค่า ให้เพิ่มในผล RPC และแสดง `/กก.` เฉพาะของชั่งน้ำหนัก
  - หน้าจอล้าง timer ที่อ้างอยู่เมื่อ pointer up/cancel แล้ว ให้ป้องกัน pointer ที่สองเขียนทับ timer และเก็บกวาดเมื่อ unmount
  - ซอร์ส `database/migrations/0002_display_payment_reports.sql`, `frontend/src/pages/Display.tsx`, `frontend/src/lib/display.ts`

## ฟีเจอร์ 5 งาน · เฟส 2–3

- [ ] **`P1-F1` ตัวเลือกเมนูมีราคา (Add-ons) และรูปเมนู** · เฟส 2
  - มีอัปโหลดรูปและวิดีโอผูกกับเมนูแล้วใน `MenuAdmin.tsx` ผ่าน `MediaManager.tsx` ใช้สื่อเดิมสำหรับแสดงรูปใน POS
  - เพิ่ม `menu_option_groups`, `menu_options`, `order_item_options` แล้วต่อ `staff_place_order` และ `bill_receipt` ให้บันทึกตัวเลือกและราคาจากฐานข้อมูล เพิ่มการตั้งค่าใน MenuAdmin การเลือกใน POS และการแสดงในครัวกับใบเสร็จ
  - ซอร์ส `database/migrations/0002_display_payment_reports.sql`, `database/migrations/0003_users_inventory.sql`, `frontend/src/pages/MenuAdmin.tsx`, `frontend/src/components/MediaManager.tsx`, `frontend/src/pages/Pos.tsx`

- [ ] **`P1-F2` ผังโต๊ะ (`/tables`), ย้าย/รวมโต๊ะ, ตัวจับเวลา และปุ่มขอเช็คบิล** · เฟส 2
  - มีการจัดการรายชื่อโต๊ะและเลือกโต๊ะตอนสั่งแล้ว เพิ่ม `pos_x`, `pos_y`, `seats`, `zone`, `bill_requested_at` ใน `dining_tables` พร้อม RPC `staff_move_table` และ `staff_set_bill_requested`
  - สร้าง `TableMap.tsx` และ `tableStatus.ts` พร้อมเทสต์ ตั้งตำแหน่งจาก MenuAdmin เพิ่มปุ่มใน Serve และสถานะเด่นใน Counter
  - ซอร์ส `database/migrations/0001_core.sql`, `frontend/src/pages/MenuAdmin.tsx`, `frontend/src/pages/Pos.tsx`, `frontend/src/pages/Serve.tsx`, `frontend/src/pages/Counter.tsx`

- [ ] **`P1-F3` แก้ออเดอร์ก่อนครัวเริ่ม, แยกบิล, ประวัติบิล (`/bills`), ค่าบริการ และทิป** · เฟส 3
  - มีการยกเลิกรายการในออเดอร์สถานะ `received` การพิมพ์หลังชำระ และการยกเลิกบิลผ่านหน้าปิดวันแล้ว ใช้ทางเดินเดิมเรื่องสิทธิ์และเอกสารภาษี
  - เพิ่ม `staff_edit_order` สำหรับ `received`, `staff_split_order` และฟิลด์ค่าบริการ/ทิปใน `shop_settings`, `orders` และ `counter_pay_bill` ต่อโหมดแก้ใน POS แยกบิล/หารเท่ากันใน Counter และหน้า Bills สำหรับค้น พิมพ์ซ้ำ และให้เจ้าของยกเลิก
  - ซอร์ส `database/migrations/0002_display_payment_reports.sql`, `database/migrations/0007_order_cancel_kitchen.sql`, `frontend/src/pages/Counter.tsx`, `frontend/src/components/Receipt.tsx`, `frontend/src/components/accounting/AcctDayClose.tsx`

- [ ] **`P1-F4` ใบสั่งครัว 80 มม. เสียงแจ้งเตือน และเวลาเตือนออเดอร์ช้า** · เฟส 2
  - ใบเสร็จมีรูปแบบสำหรับกระดาษ 80 มม. แล้ว ครัวมีตัวจับเวลาและไฮไลต์เมื่อถึง 15 นาที เพิ่ม `KitchenTicket.tsx` และงานพิมพ์ใบสั่งครัว เสียงแจ้งเมื่อมีออเดอร์ใหม่ และค่า `shop_settings.auto_print_kitchen` / `late_order_minutes`
  - ซอร์ส `frontend/src/components/Receipt.tsx`, `frontend/src/index.css`, `frontend/src/pages/Kitchen.tsx`, `database/migrations/0002_display_payment_reports.sql`

- [ ] **`P1-F5` Audit Log (`/audit`) และ PWA คิวออเดอร์ออฟไลน์ (`client_ref`)** · เฟส 3
  - มีประวัติยกเลิกรายการเฉพาะทางแล้ว เพิ่ม `audit_log` แบบแก้ย้อนหลังไม่ได้และ `audit_trigger()` พร้อมหน้าสำหรับ owner/manager
  - เพิ่ม `orders.client_ref` พร้อม unique `(restaurant_id, client_ref)` และจัดการส่งซ้ำใน `staff_place_order` ต่อ manifest, service worker และคิว IndexedDB สำหรับ POS ทดสอบการส่งซ้ำและการเชื่อมต่อกลับหลังออฟไลน์
  - ซอร์ส `database/migrations/0003_users_inventory.sql`, `database/migrations/0007_order_cancel_kitchen.sql`, `frontend/src/pages/Pos.tsx`, `frontend/src/main.tsx`
