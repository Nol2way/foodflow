# สรุปส่งมอบงานทีม 2 คน (แบบ Fullstack เท่าเทียมกัน · ไม่รวมระบบ AI วิเคราะห์) — FoodFlow (Plato)

เอกสารชุดนี้แบ่งงานให้ **2 คนมีลักษณะงานและปริมาณงานเท่ากัน (คนละ 6 บั๊ก + 5 ฟีเจอร์)** โดยทั้ง 2 คนทำครบทั้ง **Frontend + Backend + SQL (Fullstack)** แยกตามโดเมนของตัวเอง และตัดส่วน AI วิเคราะห์ออกทั้งหมดตามที่กำหนด

## สารบัญเอกสารในชุดนี้

| ไฟล์ | ผู้รับผิดชอบ | โดเมน (Fullstack) | งานที่เหลือ | ช่วง Migration |
|---|---|---|---|---|
| [README.md](README.md) | ทีม | ภาพรวม, สิ่งที่แก้เสร็จแล้ว (บัญชี & สต็อก), กติกากลาง, แผน 3 เฟส | — | `0008` (แก้แล้ว) |
| [person-1-pos-kitchen.md](person-1-pos-kitchen.md) | **คนที่ 1** | หน้าร้าน, ออเดอร์, โต๊ะ, เมนู, ครัว, การพิมพ์, Audit Log & PWA | 6 บั๊ก + 5 ฟีเจอร์ | `0009–0019` |
| [person-2-crm-ops.md](person-2-crm-ops.md) | **คนที่ 2** | สมาชิก/PDPA, โปรโมชัน/คูปอง, รายงาน LINE/Import, ธีม/ภาษา, พนักงาน & CI | 6 บั๊ก + 5 ฟีเจอร์ | `0020–0029` |
| [proposed-systems.md](proposed-systems.md) | ทีม | ข้อเสนอ 10 ระบบใหม่สำหรับระยะถัดไป + แนวทางแบ่งงาน 2 คน | — | — |

---

## 1. สิ่งที่แก้ไขเสร็จแล้วในระบบบัญชี (Accounting) และสต็อก (Stock)

ผลการตรวจล่าสุด: `backend` (`tsc --noEmit` + 130/130 tests) และ `frontend` (`tsc --noEmit` + `vite build` + unit tests ทั้ง 8 ชุด) **ผ่านทั้งหมด**

- **Database:** `database/migrations/0008_fix_accounting_stock.sql`
  - `accounting_summary()` และ `daily_report_data()`: ตัดรายจ่ายที่ยกเลิกแล้ว (`voided_at is null`)
  - `orders_accounting()`: ห้ามยกเลิกบิลที่จ่ายแล้วหากมีใบกำกับภาษี (`ABB`/`TAX`) ที่ยืนยันแล้วและยังไม่มี `CN` ครอบคลุม (`tax_doc_confirmed_use_cn`)
  - `tax_doc_build_xml()`: ปรับยอดรายบรรทัด ETDA XML ให้ตรงกับยอดฐานภาษีก่อน VAT หลังส่วนลด (`LineTotalAmount`)
- **Backend:** `app.ts` (เพิ่ม `'PUT'` ใน CORS + map `23514`/`23503` เป็น `400`), `accounting.ts` (ตรวจ `type`/`grp` และเลขผู้เสียภาษี mod-11), `stock.ts` (เช็ค body ว่างใน supplier PATCH + ส่งต่อฟิลด์ตรวจรับใน `receiptLines()`)
- **Frontend:** `lib/accounting.ts`, `AcctReports.tsx` (กัน crash ใน `<Ledger />` + รีเซ็ตแท็บโหมด pro), `StockCount.tsx` (ไม่ล้างร่างหมวด ABC อื่น), `StockHistory.tsx` (`busy` guard + กันวันที่ว่าง), `StockReceive.tsx` (แสดง error + กันวันที่ว่างและ stale response)

> **สำคัญ:** รัน `database/migrations/0008_fix_accounting_stock.sql` บน Supabase/PostgreSQL ก่อนทดสอบจริง

---

## 2. กติกากลาง & จุดที่ต้องประสานกัน

1. **ช่วงเลข Migration:** คนที่ 1 ใช้ `0009–0019` · คนที่ 2 ใช้ `0020–0029` (ห้ามใช้ข้ามช่วง)
2. **จุดไฟล์ที่ใช้ร่วมกัน (คุยกันก่อนแก้):**
   - `counter_pay_bill` (คนที่ 1 แก้เพิ่มค่าบริการ/ทิป + แก้ยอดติดลบ, คนที่ 2 แก้ส่วนคูปอง/ซ้อนโปร — ให้คนที่ 1 แก้ก่อนในเฟส 1–2 แล้วคนที่ 2 ต่อในเฟส 3)
   - `App.tsx`, `lib/roles.ts`, `backend/src/openapi.ts` (ทั้งสองคนต้องเพิ่ม route/endpoint ของตัวเอง ให้ pull/rebase บ่อยๆ)
3. **ข้อห้ามหลัก:**
   - ราคา/ยอดเงินคำนวณที่ฐานข้อมูลเสมอ · ฟังก์ชันแก้ข้อมูลใช้ `security definer set search_path = public, pg_temp` + เช็คสิทธิ์เอง
   - ตารางใหม่ทุกตารางต้องมี `restaurant_id`, เปิด RLS และมีเทสต์ใน `database/tests/test_rls.py`
   - เพิ่ม endpoint ใหม่ใน backend ต้องอัปเดต `openapi.ts` แล้วรัน `npm run openapi`
4. **นิยามเสร็จของแต่ละงาน:**
   - `npm --prefix backend run typecheck && npm --prefix backend test` ผ่าน
   - `npm --prefix frontend run build && npm --prefix frontend test` ผ่าน

---

## 3. แผนการทำงาน 3 เฟส (ทำขนานกันได้ตลอด)

| เฟส | คนที่ 1 (หน้าร้าน / ออเดอร์ / โต๊ะ / ครัว) | คนที่ 2 (สมาชิก / โปร / รายงาน / ระบบกลาง) |
|---|---|---|
| **เฟส 1: ปิดบั๊ก (สัปดาห์ 1)** | ทำ `P1-B1` ถึง `P1-B6` (Security `orders`, `Pos`, `MenuAdmin`, `counter_pay_bill`, `Display`, `useOrders`) | ทำ `P2-B1` ถึง `P2-B6` (Security `guards.ts`, `Promotions`, สมาชิก/แต้ม, `staff`, `reports`, `csv`) + CI ใน `P2-F5` |
| **เฟส 2: ฟีเจอร์แกนหลัก (สัปดาห์ 2)** | ทำ `P1-F1` (ตัวเลือกเมนูมีราคา + รูป) + `P1-F2` (ผังโต๊ะ/ย้ายโต๊ะ/ขอเช็คบิล) + `P1-F4` (พิมพ์ 80 มม. + เสียงครัว) | ทำ `P2-F1` (คูปอง/ซ้อนโปร/รายงานผลโปร) + `P2-F2` (ค้นสมาชิก 4 ตัวท้าย + PDPA + Feedback) + `P2-F4` (โหมดมืด/TH-EN) |
| **เฟส 3: ฟีเจอร์ขั้นสูง (สัปดาห์ 3)** | ทำ `P1-F3` (แก้ออเดอร์/แยกบิล/ประวัติบิล/ทิป) + `P1-F5` (Audit Log + PWA `client_ref`) | ทำ `P2-F3` (สรุปเช้า LINE + เตือนสต็อก + นำเข้า `.xlsx`) + `P2-F5` (เปิด API/UI ภาษี-กะ-สต็อกที่ค้าง) |
