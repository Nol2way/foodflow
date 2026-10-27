# คน 4: โต๊ะ / ลูกค้าหน้าร้าน (10 แต้ม)

อ่านกติกากลางที่ [README.md](README.md) ก่อน · migration ที่ใช้ได้: **0060–0069** · ทุกอย่างให้ **พนักงานเป็นคนบันทึก** ไม่มีหน้าฝั่งลูกค้า

## ข้อมูลและโค้ดที่มีอยู่แล้ว (ใช้ได้เลย)

| ประเภท | ชื่อ |
|--------|------|
| ตาราง | `dining_tables` (`id` `restaurant_id` `label`) · `orders` (`table_id` `status` `created_at` `member_id` `points_earned` `points_redeemed` `points_discount` `discount_total`) · `members` (`phone` `name` `points`) · `point_ledger` (`member_id` `change` `reason` = earn/redeem/reverse/adjust `order_ids` `note`) · `promotions` (`name` `discount_type` percent/amount `value` `min_subtotal` `starts_on` `ends_on` `days_of_week` `start_time` `end_time` `is_active` `max_uses`) · `promotion_items` · `promotion_uses` · `order_promotions` · `shop_settings` (`loyalty_*`) |
| ฟังก์ชัน | `counter_pay_bill(p_restaurant_id, p_order_ids, p_promotion_ids, p_payment_method, p_member_id, p_redeem_points)` · `apply_promotions(p_restaurant_id, p_order_ids, p_promotion_ids)` · `promotions_available(p_restaurant_id)` · `promotion_is_live` · `promotion_usage` · `promotion_uses_count` · `promo_insights(p_restaurant_id, p_days)` · `member_adjust_points(p_member_id, p_change, p_note)` · `reverse_order_points` |
| หน้าเว็บ | `pages/Members.tsx` · `components/MemberBox.tsx` (ใช้ใน `Counter.tsx`) · `pages/Promotions.tsx` · `components/PromoPicker.tsx` · `components/PromoSuggestions.tsx` · `lib/loyalty.ts` · `lib/discount.ts` · `lib/promotions.ts` · `lib/promoSuggest.ts` · `pages/Counter.tsx` · `pages/MenuAdmin.tsx` (ส่วนจัดการโต๊ะ) · `lib/useOrders.ts` |
| เทสต์ | `frontend/tests/discount.test.ts`, `loyalty.test.ts` · `database/tests/test_rls.py` (ส่วนโปรโมชัน/สมาชิก) |

ตรวจก่อนเริ่ม: เอกสารเขียนว่า "1 โปรต่อบิล" แต่ `order_promotions` มี PK `(order_id, promotion_id)` และ `apply_promotions` รับ `uuid[]` อยู่แล้ว ให้อ่านโค้ด `0012_promotion_rules.sql` ว่าซ้อนหลายโปรได้แค่ไหนก่อนออกแบบงานที่ 4

## งาน

### 1. ผังโต๊ะ + ย้าย/รวมโต๊ะ (3 แต้ม)
- **คอลัมน์ใหม่** `dining_tables.pos_x int`, `pos_y int`, `seats int`, `zone text` (ค่าว่าง = ยังไม่ได้วาง)
- **สถานะโต๊ะ** คำนวณจากออเดอร์ที่เปิดอยู่ ไม่เก็บเอง: ว่าง (ไม่มีออเดอร์ `received`…`served`) / กำลังกิน (มี) / รอจ่าย (ทุกรายการเสิร์ฟแล้ว ใช้ `order_items.served_at`) / ขอเช็คบิล (`dining_tables.bill_requested_at` ที่คน 1 สร้างให้)
- **หน้าใหม่** `pages/TableMap.tsx` route `/tables` (เพิ่มใน `App.tsx`, `STAFF_PAGES` ใน `roles.ts` สิทธิ์ owner/staff) · Realtime ผ่าน `useOrders.ts` · แตะโต๊ะแล้วไป `Pos.tsx`/`Counter.tsx` ของโต๊ะนั้น
- **จัดตำแหน่งโต๊ะ** ใน `MenuAdmin.tsx` ส่วนโต๊ะ (เจ้าของเท่านั้นตามสิทธิ์เดิม) เริ่มจากช่องกรอก x/y ก่อน ลากวางทีหลังถ้ามีเวลา
- **ย้าย/รวมโต๊ะ:** ฟังก์ชันใหม่ `staff_move_table(p_from_table_id uuid, p_to_table_id uuid)` ย้ายออเดอร์ที่ยังไม่ `paid`/`cancelled` ไปโต๊ะใหม่ (ถ้าโต๊ะปลายทางมีออเดอร์ = รวมโต๊ะ) ตรวจว่าทั้งสองโต๊ะเป็นของร้านเดียวกัน · บันทึกผู้ทำ (คน 3 จะผูก `audit_log` ให้ทีหลัง)
- **เทสต์:** ย้ายแล้วบิลรวมโต๊ะเดียว ยอดไม่เปลี่ยน, ย้ายข้ามร้านไม่ได้, ย้ายออเดอร์ที่จ่ายแล้วไม่ได้, kitchen/accountant เรียกไม่ได้

### 2. ตัวจับเวลาโต๊ะ (1 แต้ม)
- ไม่ต้องมีตารางใหม่: เวลานั่ง = เวลาปัจจุบัน − `min(created_at)` ของออเดอร์ที่เปิดอยู่ของโต๊ะนั้น · แสดงบน `TableMap.tsx` และหัวบิลใน `Counter.tsx` · เปลี่ยนสีเมื่อเกินเกณฑ์ (ค่าคงที่ก่อน เช่น 90 นาที ทำเป็นตั้งค่าในภายหลัง)
- เขียนเป็นฟังก์ชันล้วนใน `lib/tableStatus.ts` พร้อมเทสต์ `frontend/tests/tableStatus.test.ts` (เพิ่มใน script `test`) · คน 2 อาจใช้ข้อมูลเดียวกันวิเคราะห์เวลาหมุนโต๊ะ ให้เขียนฟังก์ชันให้ใช้ซ้ำได้

### 3. สมาชิกหน้าร้าน ค้นด้วยเบอร์/ใช้แต้มตอนชำระ (2 แต้ม)
- ของเดิมมี: `MemberBox.tsx`, `counter_pay_bill(..., p_member_id, p_redeem_points)`, `lib/loyalty.ts` → งานนี้คือ **ปรับ UX ให้เร็วสำหรับพนักงาน**: ค้นด้วย 4 ตัวท้ายของเบอร์ได้ · ไม่พบสมาชิกแล้วสมัครใหม่ในกล่องเดียว (เบอร์ต้องตรง `^0[0-9]{8,9}$`) · แสดงแต้มที่จะได้/ใช้ก่อนกดจ่าย
- **ฟังก์ชันใหม่** `member_find(p_restaurant_id uuid, p_q text)` คืนสูงสุด 5 รายการ (สิทธิ์ owner/manager/staff) · จำกัดไม่ให้ดึงรายชื่อทั้งหมด (ต้องใส่ ≥ 4 ตัวเลข)
- **เทสต์:** ค้นข้ามร้านไม่ได้, kitchen/stock ค้นไม่ได้, ใช้แต้มเกินที่มีถูกปฏิเสธ (เทสต์เดิมใน `loyalty.test.ts`/`test_rls.py` ต้องยังผ่าน)

### 4. หลายโปร / คูปอง (2 แต้ม)
- **คอลัมน์ใหม่** `promotions.coupon_code text` (unique ต่อร้านเมื่อไม่ว่าง) และ `promotions.stackable boolean default false` (ซ้อนกับโปรอื่นได้ไหม)
- **ฟังก์ชันใหม่** `coupon_lookup(p_restaurant_id, p_code)` คืนโปรที่ใช้ได้ตอนนี้ (ใช้ `promotion_is_live`) · แก้ `apply_promotions` ให้ตรวจ `stackable` ถ้ามีโปรที่ไม่ซ้อนได้ ต้องเป็นโปรเดียว และจำกัด `max_uses` ผ่าน `promotion_uses` เดิม
- **หน้าเว็บ:** `PromoPicker.tsx` เพิ่มช่องกรอกโค้ด · `Promotions.tsx` ฟอร์มเพิ่ม `coupon_code` / `stackable` · `lib/discount.ts` คำนวณตัวอย่างฝั่งหน้าเว็บให้ตรงกับฐานข้อมูล (เทสต์ `discount.test.ts` ต้องผ่านทั้งเคสเดิมและเคสซ้อน)
- **ระวัง:** ฟังก์ชัน `counter_pay_bill` มีคนแก้ร่วมกับคน 1 แจ้งในกลุ่มก่อนแก้

### 5. รายงานผลโปร (1 แต้ม)
- ของเดิม: `promo_insights`, `promotion_usage`, `promotion_uses_count` → เพิ่ม `promo_report(p_restaurant_id, p_from date, p_to date)` คืนต่อโปร: จำนวนบิลที่ใช้, ส่วนลดรวม, ยอดขายหลังลด, บิลเฉลี่ยเทียบกับบิลที่ไม่ใช้โปร (ตามเขตเวลา `restaurants.timezone`) · แท็บ "ผลลัพธ์" ใน `Promotions.tsx` · สิทธิ์ owner/manager

### 6. บันทึกความพึงพอใจ พนักงานกรอก (1 แต้ม)
- **ตารางใหม่** `feedback` (`id` `restaurant_id` `order_id` nullable `table_id` nullable `rating int check 1..5` `comment text ≤ 300` `created_by` `created_at`) RLS: owner/manager/staff insert + select ของร้านตัวเอง ห้ามแก้/ลบ · **ห้ามเก็บชื่อ/เบอร์ลูกค้า** (ลดภาระ PDPA)
- ฟอร์มสั้น (ดาว 1–5 + หมายเหตุ) หลังรับชำระใน `Counter.tsx` ข้ามได้ · สรุปค่าเฉลี่ยและคอมเมนต์ล่าสุดใน `pages/Report.tsx` (แจ้งคน 2 ที่ดูแลหน้านี้)

## ลำดับแนะนำ
สัปดาห์ 1: งาน 5, 6 (ไม่ชนใคร) → งาน 3 · สัปดาห์ 2: งาน 4 (ประสานคน 1 เรื่อง `counter_pay_bill`) · สัปดาห์ 3: งาน 1 + 2 (หลังคน 1 สร้าง `bill_requested_at`) + ทดสอบกับ Supabase จริง (TC-P1, TC-P2, TC-O8, TC-X1)
