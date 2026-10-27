# คน 2: วิเคราะห์ / AI / เอกสาร (10 แต้ม)

อ่านกติกากลางที่ [README.md](README.md) ก่อน · migration ที่ใช้ได้: **0040–0049**

## ข้อมูลและโค้ดที่มีอยู่แล้ว (ใช้ได้เลย)

| ประเภท | ชื่อ |
|--------|------|
| ตาราง | `orders` (`created_at` `paid_at` `status` `total` `started_at` `ready_at`), `order_items`, `menu_items`, `members`, `point_ledger`, `shop_settings` (`line_to` `receipt_header`…), `restaurants` (`timezone` = Asia/Bangkok) |
| view | `menu_item_costs` (`menu_item_id` `name` `price` `unit_cost` `ingredient_count`) |
| ฟังก์ชัน | `analytics_hourly(p_restaurant_id, p_days)` → (`day_of_week` `hour_of_day` `order_count` `revenue_total`) · `analytics_summary(p_restaurant_id, p_days)` → (`order_count` `revenue_total` `avg_bill` `avg_prep_minutes` `first_order_at`) · `analytics_top_items(p_restaurant_id, p_days)` → (`item_name` `quantity_sold` `revenue_total`) · `daily_report_data(p_restaurant_id, p_date)` · `daily_report_targets()` · `promo_insights` (สิทธิ์ owner/accountant, จำกัด 1–120 วัน) |
| backend | `backend/src/ai.ts` (Gemini, `DEFAULT_MODEL`, `MAX_QUESTION`) · `backend/src/reports.ts` (`sendDueReports`, `reportHour`) · `backend/src/index.ts` (Cron ทุกชั่วโมง) · `POST /ai/summary` · `POST /reports/daily/send` · env `GEMINI_API_KEY` `LINE_CHANNEL_ACCESS_TOKEN` `REPORT_HOUR` |
| หน้าเว็บ | `lib/analytics.ts` (`classifyHours` `forecastForDay` `buildInsights` `hourTotals`) · `lib/report.ts` (`reportText`) · `pages/Report.tsx` · `components/AiPanel.tsx` · `components/PromoSuggestions.tsx` |
| เทสต์ | `frontend/tests/analytics.test.ts`, `report.test.ts` (รันด้วย `node tests/xxx.test.ts` เพิ่มไฟล์ใหม่ใน script `test` ของ `frontend/package.json`) · `backend/test/app.test.ts` (mock Gemini) |
| ข้อมูลทดลอง | `database/seed/seed_demo.sql`, `frontend/public/sample-sales.csv` |

หมายเหตุ: ไฟล์ `frontend/src/pages/Analytics.tsx` ถูกลบใน working tree (ดู `git status`) ให้ตรวจก่อนว่าหน้าวิเคราะห์ย้ายไปอยู่ที่ `Report.tsx`/`AiPanel.tsx` แล้วจริง และ route เก่าไม่ค้าง

## งาน

### 1. Backtest วัดความแม่นยำ MAPE (2 แต้ม) — ทำก่อน เพราะเป็นหลักฐานว่า "AI คาดการณ์" จริง
- **ฟังก์ชันใหม่ฐานข้อมูล** `analytics_hourly_by_date(p_restaurant_id, p_days)` → (`day date`, `hour_of_day`, `order_count`) ตามเขตเวลา `restaurants.timezone` (สิทธิ์ owner/accountant เหมือน `analytics_hourly`)
- **โค้ดคำนวณ** ใน `lib/analytics.ts`: `backtestForecast(rows, weeks = 4)` ย้อนไปทีละสัปดาห์ สร้างคาดการณ์จากข้อมูลก่อนสัปดาห์นั้น (ใช้ `forecastForDay` เดิม) เทียบกับของจริง คำนวณ MAPE (ข้ามชั่วโมงที่ของจริง = 0) และเทียบกับ baseline "เท่ากับค่าเฉลี่ยทั้งหมด"
- **UI:** แสดง MAPE + ข้อความเตือนถ้าข้อมูลไม่พอ (< 4 สัปดาห์) ใน `AiPanel.tsx`/`Report.tsx`
- **เอกสาร:** อัปเดต FR-I7, TC-I4, TC-P4 ใน `docs/requirements.md` และ `docs/testing.md` (กรอกผลจริงเท่านั้น)
- **เทสต์:** ข้อมูลสังเคราะห์ที่รู้คำตอบ (MAPE คำนวณมือได้), ข้อมูลน้อยกว่าเกณฑ์ → คืนสถานะ `insufficient`

### 2. Menu engineering (2 แต้ม)
- ใช้ `analytics_top_items` (`quantity_sold`) + `menu_item_costs` (`price` − `unit_cost` = กำไรต่อจาน) · เมนูที่ไม่มีสูตร (`ingredient_count = 0`) ให้แยกเป็น "ยังไม่มีต้นทุน" อย่าเดาเอง
- **โค้ดใหม่** `lib/menuEngineering.ts`: จัด 4 กลุ่ม — ดาว (ขายดี+กำไรดี) / ม้างาน (ขายดี กำไรต่ำ) / ปริศนา (ขายน้อย กำไรดี) / หมา (ขายน้อย กำไรต่ำ) ด้วยเกณฑ์: ขายดี = ยอดขาย ≥ 70% ของค่าเฉลี่ยต่อเมนู, กำไรดี = กำไรต่อจาน ≥ ค่าเฉลี่ยถ่วงน้ำหนัก (ใส่ค่าเกณฑ์เป็นค่าคงที่ที่ปรับได้) · ข้อความแนะนำต่อกลุ่ม
- **UI:** ตารางหรือกราฟ 2×2 ใน `Report.tsx` · เทสต์ใหม่ `frontend/tests/menuEngineering.test.ts` (เพิ่มใน script `test`)

### 3. เทียบสัปดาห์ก่อน (1 แต้ม)
- เรียก `analytics_summary` สองครั้ง (7 วันล่าสุด vs 7 วันก่อนหน้า) หรือสร้าง `analytics_compare(p_restaurant_id, p_days)` ถ้าต้องการให้ตรงช่วงเวลาเป๊ะ · แสดงส่วนต่าง % ยอดขาย จำนวนบิล บิลเฉลี่ย ใน `Report.tsx` · ส่งตัวเลขเดียวกันให้ `/ai/summary` ใช้เป็นข้อมูลอธิบาย (ห้ามให้ LLM คำนวณเอง)

### 4. แนะนำราคาเมนู (1 แต้ม)
- **คอลัมน์ใหม่** `shop_settings.target_food_cost_pct numeric(5,2) default 35` ตั้งที่ `pages/Settings.tsx`
- **โค้ดใหม่** `lib/pricing.ts`: ราคาแนะนำ = `unit_cost / (target% / 100)` ปัดเป็นเลขกลม (ลงท้าย 0/5) แสดงเทียบราคาปัจจุบัน ใน `Report.tsx` เฉพาะเมนูที่มีสูตร · ห้ามแก้ราคาเมนูอัตโนมัติ (เป็นคำแนะนำให้เจ้าของกดเอง)

### 5. สรุปทุกเช้าทาง LINE (2 แต้ม)
- ต่อจาก `reports.ts` เดิม: เพิ่ม `sendMorningDigest(env)` ที่เรียกจาก `index.ts` (Cron ทุกชั่วโมงมีอยู่แล้ว) เนื้อหา = ยอดเมื่อวาน (`daily_report_data`) + ช่วงพีคของวันนี้ (`forecastForDay` จาก `analytics_hourly`) + เมนูขายดี
- **คอลัมน์ใหม่:** `shop_settings.morning_report_enabled boolean default false`, `shop_settings.morning_report_hour int default 8`; ฟังก์ชัน `morning_report_targets()` ทำนองเดียวกับ `daily_report_targets()` · เพิ่มช่องตั้งค่าใน `Settings.tsx` และ endpoint ส่งทันทีเพื่อทดสอบ (เพิ่มใน `openapi.ts`)
- **ข้อจำกัด:** Cron ใช้ได้เฉพาะ deploy แบบ Worker (`wrangler.toml` ระบุไว้แล้ว) ถ้าใช้ Cloudflare Pages ต้องเขียนไว้ใน `docs/SETUP.md`
- **เทสต์:** mock LINE และ Gemini เหมือนใน `backend/test/app.test.ts` · ร้านที่ไม่ได้ตั้ง `line_to` ต้องไม่ถูกส่ง

### 6. PDPA + README/docs (2 แต้ม)
- **หน้า public** `pages/Privacy.tsx` route `/privacy` (ไม่ต้องล็อกอิน) บอกว่าเก็บอะไร: `members` (`phone` `name` `points`), `point_ledger`, `orders.customer_label` · จุดประสงค์ ระยะเก็บ สิทธิ์ขอลบ
- **ฟังก์ชันใหม่ (เจ้าของเท่านั้น):** `member_export(p_member_id)` คืน JSON ข้อมูลสมาชิก+ประวัติแต้ม · `member_delete(p_member_id)` ลบสมาชิกและ `point_ledger` ของคนนั้น (ออเดอร์เก่าคงอยู่ `member_id` เป็น null เพราะ FK เป็น `on delete set null` อยู่แล้ว) · ปุ่มใน `pages/Members.tsx`
- **เอกสาร:** แก้ `README.md` ให้ตรงขอบเขตใหม่ (ร้านเดียว, พนักงานสั่ง, ไม่ขายหลายร้าน), เติมค่าที่เป็นตัวอย่าง (`YOUR-USERNAME`, รหัส/ชื่อวิชา, ตารางทีม), แก้ตารางสถานะ, อัปเดต `docs/requirements.md` (หลายข้อล้าสมัย เช่น วิธีชำระเงิน ปิดยอดรายวัน ส่งออกรายงาน ทำแล้ว), เพิ่มลิงก์ `docs/tasks/`
- **เทสต์:** สมาชิกร้านอื่นลบไม่ได้, staff ไม่ใช่เจ้าของเรียก `member_delete` ไม่ได้

## ลำดับแนะนำ
สัปดาห์ 1: งาน 6 (docs/PDPA ไม่ชนใคร) + งาน 3 · สัปดาห์ 2: งาน 1, 4 · สัปดาห์ 3: งาน 2, 5 + ทดสอบกับ Supabase จริง (TC-I1–I5, TC-P1–P4)
