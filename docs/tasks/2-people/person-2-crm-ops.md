# ใบงานคนที่ 2 - สมาชิก, โปรโมชัน, รายงาน และระบบกลาง

> ข้อความด้านล่างเป็นสเปกและเหตุผลก่อนแก้ รายการปิดงาน/หลักฐานหลังแก้ดู [remediation results](../../audits/2026-11-22-remediation-results.md) และ [คู่มือฟีเจอร์](../../features.md) อย่าใช้ข้อความ ปัจจุบัน ในสเปกเก่าแทนสถานะ release


รับผิดชอบ Frontend, Backend และ SQL ในโดเมนนี้ ใช้ migration ช่วง `0020-0029` ตาม [แผนส่งมอบ](README.md) งานรอบนี้ไม่รวม AI วิเคราะห์ สถานะด้านล่างอ้างอิงซอร์สปัจจุบัน

## บั๊ก 6 งาน / เฟส 1

### P0

- [ ] **`P2-B1` [BE] รักษา rate limit ที่ยังไม่หมดอายุเมื่อหน่วยความจำเต็ม**
  - Login แยก key ต่อ IP และต่ออีเมลอยู่แล้ว และใช้ตัวนับในหน่วยความจำโดยตรง ตัวนับยังล้างทั้ง Map เมื่อจำนวน key เกินเพดาน
  - เก็บหน่วยความจำให้อยู่ในขอบเขตโดยลบ entry หมดอายุและจัดการ key ใหม่เมื่อเต็ม โดยรักษาเพดานของ bucket ที่ยังมีผล เพิ่มเทสต์สำหรับช่วงอิ่มตัวและหมดอายุ
  - ซอร์ส `backend/src/guards.ts`, `backend/src/app.ts`

### P1

- [ ] **`P2-B2` [FE + SQL] บันทึกโปรและเมนูที่ร่วมโปรให้สอดคล้องกัน**
  - หน้าแจ้ง error เมื่อ insert รายการร่วมโปรล้มเหลวแล้ว แต่ลบลิงก์เดิมโดยไม่ตรวจผล และการบันทึกแยกคำขออาจทิ้งโปรที่ขาดรายการร่วมโปร ให้บันทึกข้อมูลทั้งชุดในธุรกรรมเดียวและเพิ่ม `saving` guard
  - `save()` ยอมให้คงวันสิ้นสุดเดิมที่ผ่านไปแล้ว แต่ `minEnd` ในฟอร์มยังบล็อก ให้ข้อจำกัด input ตรงกับกติกาการบันทึกและทดสอบแก้โปรที่หมดอายุ
  - ซอร์ส `frontend/src/pages/Promotions.tsx`, `database/migrations/0001_core.sql`

- [ ] **`P2-B3` [FE + SQL] ให้แต้มคงเหลือตรงกับ ledger และแก้การตั้งค่า ค้นหา และแลกแต้ม**
  - `reverse_order_points()` มีการจำกัดยอดคงเหลือที่ศูนย์แล้ว แต่ยังลง ledger ด้วยค่าที่ขอ ให้บันทึกผลต่างที่ใช้จริงภายใต้การล็อกแถวสมาชิก
  - เก็บช่องตัวเลขใน Settings เป็นข้อความระหว่างพิมพ์ แล้วตรวจค่าตอนบันทึก เพื่อให้ล้างช่องและกรอกทศนิยมต่ำกว่า 1 ได้
  - ใน Members ให้กันกดปรับแต้มซ้ำ ค้นชื่อที่มีตัวเลขได้ แยกผลค้นหาจากแคชรายการหลัก และรับ ledger เฉพาะของสมาชิกที่เลือกอยู่
  - MemberBox จำกัดแต้มตอนเปลี่ยนค่าในช่องแล้ว ให้ Counter คำนวณแต้มที่ใช้จากยอดและเพดานล่าสุดด้วย เพื่อให้ยอดแสดงและค่า RPC ตรงกันเมื่อโปรหรือยอดบิลเปลี่ยน
  - ซอร์ส `database/migrations/0002_display_payment_reports.sql`, `frontend/src/pages/Settings.tsx`, `frontend/src/pages/Members.tsx`, `frontend/src/pages/Counter.tsx`, `frontend/src/components/MemberBox.tsx`, `frontend/src/lib/loyalty.ts`

- [ ] **`P2-B4` [BE + SQL] จัดการสิทธิ์ลบพนักงานและคงเจ้าของร้านเมื่อแก้พร้อมกัน**
  - RLS กันผู้จัดการลบเจ้าของหรือผู้จัดการแล้ว แต่ `DELETE /api/staff/:userId` ตอบ `404` เมื่อการลบถูกกรอง ให้ตรวจสิทธิ์เป้าหมายในร้านและตอบ `403` ตามกรณีเดียวกับการจัดการพนักงานรายการอื่น
  - `promotion_uses_count` และ `staff_is_senior` ยังเรียกได้จากบัญชี authenticated โดยไม่มี guard ของร้านในตัว ให้จำกัดผลตามสิทธิ์และรักษาการทำงานของ `promotion_usage` กับ policy ที่เรียก helper
  - `keep_last_owner()` ตรวจว่ามีเจ้าของคนอื่นแล้ว แต่ยังไม่มีการจัดลำดับธุรกรรมต่อร้าน เพิ่ม lock และเทสต์การลบหรือย้ายบทบาทเจ้าของพร้อมกัน
  - ซอร์ส `backend/src/app.ts`, `database/migrations/0001_core.sql`, `database/migrations/0003_users_inventory.sql`

### P2

- [ ] **`P2-B5` [BE + FE] เลือกวันรายงานให้ตรงเวลา Cron และวันที่บนหน้า Report**
  - Backend กรองเป้าหมายตามชั่วโมงท้องถิ่นแล้ว ให้ค่า `REPORT_HOUR` ว่างใช้ค่าเริ่มต้น 22 และตอนตั้ง 0 ให้ดึงรายงานของวันก่อนในเขตเวลาร้าน การส่งรายงานแบบเลือกวันยังใช้วันที่ผู้ใช้เลือก
  - หน้า Report มี key ตามวันที่แล้ว แต่ setter เขียนลง key ปัจจุบันเมื่อผลตอบกลับมาช้า ให้ยกเลิกหรือข้ามคำขอเก่าเมื่อเปลี่ยนวันที่ รวมทั้งข้อผิดพลาดจากคำขอนั้น
  - ซอร์ส `backend/src/reports.ts`, `frontend/src/pages/Report.tsx`, `frontend/src/lib/useCachedState.ts`

- [ ] **`P2-B6` [BE + FE] อ่านเครื่องหมายคำพูดใน CSV และล้างไฟล์ที่ Import เมื่อเลือกไม่ได้**
  - Parser รองรับ quoted field และ escaped quote แล้ว ให้เริ่ม quoted field เฉพาะต้นช่องและทดสอบเมื่อพบ `"` กลางคำ
  - หน้า Import ล้างผล preview แล้ว แต่เก็บเนื้อหาและชื่อไฟล์เดิมเมื่อเลือกไฟล์เกิน 3 MB หรือไม่มีไฟล์ ให้ล้างทั้งสองค่าเมื่อเลือกไฟล์ไม่ได้หรือยกเลิก และป้องกันผลอ่านเก่าเขียนทับเมื่อเปลี่ยนไฟล์
  - ซอร์ส `backend/src/csv.ts`, `frontend/src/pages/Import.tsx`

## ฟีเจอร์ 5 งาน / เฟส 1-3

- [ ] **`P2-F1` คูปอง กติกาซ้อนโปร และรายงานผลโปรโมชัน** / เฟส 2
  - POS/Counter ใช้โปรหลายรายการที่ไม่ชนกันได้แล้ว และหน้า Promotions แสดงจำนวนครั้งที่ใช้ เพิ่ม `promotions.coupon_code` แบบ unique ต่อร้าน, `stackable`, `coupon_lookup()` และ `promo_report()`
  - อัปเดต `apply_promotions()`, ช่องกรอกโค้ดใน PromoPicker, ฟอร์มและแท็บผลลัพธ์ใน Promotions และการคำนวณตัวอย่างใน `discount.ts` ตรวจร่วมกับ Add-ons ของ `P1-F1` หากต้องเปลี่ยน `counter_pay_bill` ให้ทำจุดเชื่อมในเฟส 3 ตาม [แผนส่งมอบ](README.md)
  - ซอร์ส `database/migrations/0001_core.sql`, `frontend/src/components/PromoPicker.tsx`, `frontend/src/pages/Promotions.tsx`, `frontend/src/lib/discount.ts`

- [ ] **`P2-F2` ค้นสมาชิกด้วยเลขท้าย 4 ตัว, PDPA (`/privacy`) และความพึงพอใจ 1-5 ดาว** / เฟส 2
  - MemberBox ค้นด้วยเบอร์เต็มและสมัครใหม่ในกล่องเดียวได้แล้ว เพิ่ม `member_find` สำหรับเลขท้าย 4 ตัว และจัดการกรณีพบหลายคน
  - เพิ่ม `member_export`, `member_delete` สำหรับเจ้าของ และตาราง `feedback` สำหรับคะแนน 1-5 โดยไม่เก็บชื่อ/เบอร์ ต่อหน้า Privacy, ปุ่ม export/delete ใน Members, แบบให้ดาวหลังชำระใน Counter และสรุปใน Report
  - ซอร์ส `database/migrations/0002_display_payment_reports.sql`, `frontend/src/components/MemberBox.tsx`, `frontend/src/pages/Members.tsx`, `frontend/src/pages/Counter.tsx`, `frontend/src/pages/Report.tsx`

- [ ] **`P2-F3` สรุปยอดตอนเช้าทาง LINE เตือนสต็อก และนำเข้า `.xlsx`** / เฟส 3
  - มีรายงาน LINE รายวัน, Cron สำหรับ Worker, ข้อเสนอการสั่งซื้อตาม Par และนำเข้า CSV แล้ว เพิ่ม `morning_report_enabled` / `morning_report_hour`, `morning_report_targets()` และ `sendMorningDigest()` พร้อมตั้งเวลาใน Settings ดึงสรุปยอดเมื่อวาน เมนูขายดี สต็อกต่ำกว่า Par และล็อตใกล้หมดอายุ
  - รองรับ `.xlsx` ใน `/api/import/sales` และ Import โดยใช้ validation กับตัวอย่างก่อนนำเข้าแบบเดียวกับ CSV
  - ซอร์ส `backend/src/reports.ts`, `backend/src/app.ts`, `backend/src/stock.ts`, `database/migrations/0005_stock.sql`, `frontend/src/pages/Settings.tsx`, `frontend/src/pages/Import.tsx`

- [ ] **`P2-F4` โหมดมืดและสลับภาษา TH/EN** / เฟส 2
  - มีธีม Tailwind และข้อความไทยในแต่ละหน้า เพิ่ม `@custom-variant dark` ใน CSS ตัวเลือกธีมที่จำใน localStorage และตัวเลือกภาษาใน Settings
  - ตรวจทุกหน้าหลักหลังเปลี่ยนภาษาและธีม ให้ใบเสร็จตอนพิมพ์เป็นสีสว่างเสมอ
  - ซอร์ส `frontend/src/index.css`, `frontend/src/pages/Settings.tsx`, `frontend/src/components/Receipt.tsx`

- [ ] **`P2-F5` CI และ API/UI ภาษี กะ สต็อก และพนักงาน** / CI เฟส 1, API/UI เฟส 3
  - เพิ่ม `.github/workflows/ci.yml` สำหรับ frontend build/test, backend typecheck/test และ database tests ใช้คำสั่งเดิมใน `package.json`
  - ภาษีมี RPC แก้/ยกเลิกร่างที่เรียกจาก TaxDocModal และหน้า AcctSettings จัดการการตั้งค่าภาษีและเครื่อง POS ผ่าน Supabase แล้ว เพิ่ม HTTP endpoint สำหรับแก้/ยกเลิกร่างและจัดการ `tax_settings` / `pos_terminals` ใน `tax.ts` แล้วต่อส่วน UI ที่ยังขาด
  - กะมีเปิด/ปิดกะและบันทึกเงินสดผ่าน API, Z-Report ตอนปิด และพิมพ์ X/Z ผ่าน RPC ใน ShiftModal แล้ว เพิ่ม `GET /shifts` และ X-Report ผ่าน HTTP
  - เคลมรับของและรายงานซัพพลายเออร์ใช้ `set_receipt_claim` และ `supplier_receiving_report` จากหน้า StockReceive แล้ว เพิ่ม HTTP endpoint ใน `stock.ts` โดยใช้ RPC เดิม
  - Backend ตรวจ `app_users.is_active` ตอนล็อกอินและตรวจ session แล้ว เพิ่มการจัดการสถานะใน Staff และ API ด้วยสิทธิ์ที่เหมาะกับบัญชีที่ใช้ได้หลายร้าน อัปเดต OpenAPI สำหรับ endpoint ที่เพิ่ม
  - ซอร์ส `package.json`, `backend/src/tax.ts`, `backend/src/accounting.ts`, `backend/src/stock.ts`, `backend/src/app.ts`, `frontend/src/components/TaxDocModal.tsx`, `frontend/src/components/accounting/AcctSettings.tsx`, `frontend/src/components/ShiftModal.tsx`, `frontend/src/pages/StockReceive.tsx`, `frontend/src/pages/Staff.tsx`, `database/migrations/0003_users_inventory.sql`, `database/migrations/0005_stock.sql`, `database/migrations/0006_tax_shifts.sql`
