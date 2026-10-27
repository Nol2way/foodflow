# คน 1: ออเดอร์ / บิล (10 แต้ม)

อ่านกติกากลางที่ [README.md](README.md) ก่อน · migration ที่ใช้ได้: **0031–0039**

## ข้อมูลและโค้ดที่มีอยู่แล้ว (ใช้ได้เลย)

| ประเภท | ชื่อ |
|--------|------|
| ตาราง | `orders` (`status` `total` `subtotal` `discount_total` `order_type` `customer_label` `note` `table_id` `payment_method` `member_id` `cancel_reason` `cancelled_at` `cancelled_by` `cancelled_from` `created_by`), `order_items` (`order_id` `menu_item_id` `quantity` `unit_price` `note` `weight_g` `done_at` `served_at`), `menu_items`, `menu_categories`, `dining_tables` (`id` `label`), `order_promotions`, `shop_settings` |
| enum | `order_status` = received / preparing / ready / served / paid / cancelled |
| ฟังก์ชัน | `staff_place_order(p_restaurant_id, p_items jsonb, p_table_id, p_order_type, p_customer_label, p_note, p_promotion_ids)` · `counter_pay_bill(p_restaurant_id, p_order_ids uuid[], p_promotion_ids, p_payment_method, p_member_id, p_redeem_points)` · `bill_receipt(p_order_ids)` · `set_item_served` · `kitchen_set_item_done` · `apply_promotions` · `enforce_order_status` (trigger บังคับลำดับสถานะ) |
| backend | `POST /accounting/bills/:orderId/cancel` (เจ้าของยกเลิกบิลที่จ่ายแล้ว ต้องมีเหตุผล) ใน `backend/src/accounting.ts` |
| หน้าเว็บ | `pages/Pos.tsx` (รับออเดอร์) · `pages/Counter.tsx` (รับชำระ) · `pages/Serve.tsx` · `pages/MenuAdmin.tsx` · `components/Receipt.tsx` · `lib/types.ts` (`CartLine` `KitchenOrder` `MenuItem`) · `lib/useOrders.ts` (Realtime) · `lib/discount.ts` |
| เทสต์ | `database/tests/test_rls.py` (ตัวอย่างเทสต์ `staff_place_order`), `frontend/e2e/order-flow.spec.ts` |

## งาน (เรียงตามลำดับที่ควรทำ)

### 1. ตัวเลือกเมนูมีราคา (3 แต้ม) — **ทำเป็นอย่างแรก คนอื่นรออยู่**
เป้าหมาย: เลือก "เพิ่มไข่ดาว +10", "พิเศษ +20", "ระดับเผ็ด" ตอนรับออเดอร์ ราคาคิดที่ฐานข้อมูล
- **ตารางใหม่** (migration 0031): `menu_option_groups` (`id` `restaurant_id` `menu_item_id` `name` `required` `max_select` `sort_order`), `menu_options` (`id` `group_id` `name` `price_delta numeric(10,2)` `is_available`), `order_item_options` (`order_item_id` `option_id` `name` `price_delta`) เก็บชื่อ/ราคาไว้ในบิล (เปลี่ยนเมนูทีหลังบิลเก่าต้องไม่เปลี่ยน)
- **แก้ `staff_place_order`:** รับ `p_items[].options = [option_id,...]` ตรวจว่าตัวเลือกเป็นของเมนูนั้น เปิดขาย จำนวนไม่เกิน `max_select` แล้วบวก `price_delta` เข้า `unit_price`
- **หน้าเว็บ:** `MenuAdmin.tsx` เพิ่มส่วนจัดกลุ่มตัวเลือกต่อเมนู · `Pos.tsx` เปิด modal เลือกตัวเลือกก่อนเข้าตะกร้า · ขยาย `CartLine` ใน `lib/types.ts` · `Kitchen.tsx` และ `Receipt.tsx` แสดงตัวเลือกใต้ชื่อเมนู (เพิ่มใน `bill_receipt`)
- **ระวัง:** สูตรตัดสต็อกอยู่ที่ `deduct_stock_for_order` (ของทีมสต็อก) ตัวเลือกยังไม่ตัดสต็อกในรอบนี้ ให้เขียนใน docs ว่าเป็นข้อจำกัด
- **เทสต์:** ราคารวมถูก, ตัวเลือกของเมนูอื่นใช้ไม่ได้, เกิน `max_select` ถูกปฏิเสธ, แก้ราคาตัวเลือกทีหลังไม่กระทบบิลเก่า, สิทธิ์ (manager/owner จัดการ, staff อ่านได้)

### 2. แก้ออเดอร์ก่อนครัวเริ่ม (2 แต้ม)
- **ฟังก์ชันใหม่** `staff_edit_order(p_order_id uuid, p_items jsonb, p_note text)`: ทำได้เมื่อ `status = 'received'` เท่านั้น (ครัวยังไม่กด "เริ่มทำ") ลบรายการเก่าแล้วสร้างใหม่ด้วยตรรกะเดียวกับ `staff_place_order` (ใช้ฟังก์ชันย่อยร่วมกัน อย่าคัดลอกโค้ด) คิด `subtotal` `total` และโปรใหม่ผ่าน `apply_promotions`
- **สิทธิ์:** เจ้าของ + หน้าร้านเหมือน `staff_place_order` · ครัวแก้ไม่ได้
- **หน้าเว็บ:** ปุ่ม "แก้ออเดอร์" ใน `Serve.tsx`/`Counter.tsx` เฉพาะใบที่ยังรอครัว เปิด `Pos.tsx` ในโหมดแก้ (ส่ง order id ผ่าน query string)
- **เทสต์:** แก้ได้ตอน received, ถูกปฏิเสธตอน preparing/paid, ยอดคิดใหม่ถูก, ครัวแก้ไม่ได้

### 3. Refund + แยกบิล (2 แต้ม)
- **แยกบิล:** ฟังก์ชันใหม่ `staff_split_order(p_order_id uuid, p_item_ids uuid[])` ย้ายรายการที่เลือกไปเป็นออเดอร์ใหม่ที่โต๊ะเดิม (ก่อนจ่ายเท่านั้น) แล้วจ่ายทีละใบด้วย `counter_pay_bill` เดิม วิธีนี้ **ไม่ต้องแตะบัญชี** · ใน `Counter.tsx` เพิ่มปุ่ม "แยกบิล" · ส่วน "หารเท่ากัน" ทำฝั่งหน้าเว็บอย่างเดียวได้ (แสดงยอดต่อคน ไม่บันทึก)
- **Refund ทั้งบิล:** ใช้ `POST /accounting/bills/:orderId/cancel` ที่มีอยู่ (เจ้าของ + เหตุผล) แค่ทำปุ่มใน "ประวัติบิล" (งาน 6) **Refund บางรายการ** ต้องกลับรายการบัญชี (`acct_reverse_entry`) ให้ประสานกับทีมบัญชีก่อน ถ้ายังไม่ชัดให้ทำเฉพาะทั้งบิลในรอบนี้
- **เทสต์:** แยกแล้วยอดสองใบรวมเท่าเดิม, แยกบิลที่จ่ายแล้วไม่ได้, ส่วนลดโปรแบ่งถูก (ดู `apply_promotions`), staff ไม่เห็นปุ่ม refund

### 4. ค่าบริการ + ทิป (1 แต้ม)
- **คอลัมน์ใหม่:** `shop_settings.service_charge_pct numeric(5,2) default 0` · `orders.service_charge numeric(10,2) default 0` · `orders.tip numeric(10,2) default 0`
- **แก้ `counter_pay_bill`:** เพิ่ม `p_tip numeric default 0` คิด service charge จาก `service_charge_pct` ที่ฐานข้อมูล แสดงใน `bill_receipt` และ `Receipt.tsx` · ตั้งค่าที่ `pages/Settings.tsx`
- **ต้องคุยกับทีมบัญชี:** ค่าบริการและทิปต้องลงบัญชีไหน (`acct_post_bill`) ถ้ายังไม่ตกลง ให้บันทึกในบิลและใบเสร็จก่อน อย่าให้ยอดบัญชีเพี้ยน

### 5. ปุ่มบันทึกโต๊ะ "ขอเช็คบิล" (1 แต้ม)
- **คอลัมน์ใหม่:** `dining_tables.bill_requested_at timestamptz` · **ฟังก์ชัน** `staff_set_bill_requested(p_table_id uuid, p_requested boolean)` (staff/owner)
- **หน้าเว็บ:** ปุ่มใน `Serve.tsx` พอกด โต๊ะนั้นเด่นขึ้นใน `Counter.tsx` (Realtime ผ่าน `useOrders.ts`) · เป็นพนักงานกดเองเท่านั้น ไม่มีปุ่มฝั่งลูกค้า
- **ส่งต่อคน 4:** แจ้งชื่อคอลัมน์นี้ให้คน 4 ไปแสดงบนผังโต๊ะ

### 6. ประวัติบิล + พิมพ์ซ้ำ (1 แต้ม)
- **หน้าใหม่** `pages/Bills.tsx` route `/bills` (เพิ่มใน `App.tsx` และ `STAFF_PAGES` ใน `roles.ts` สิทธิ์ owner/manager/staff) ค้นหาตามวันที่/โต๊ะ/เลขบิล แสดงบิล `paid` และ `cancelled`
- ใช้ `bill_receipt(p_order_ids)` + `components/Receipt.tsx` พิมพ์ซ้ำ · ปุ่ม "ยกเลิกบิล" (เจ้าของเท่านั้น) เรียก endpoint ยกเลิกเดิม
- **เทสต์:** staff เห็นเฉพาะบิลร้านตัวเอง, ปุ่มยกเลิกเห็นเฉพาะเจ้าของ

## ลำดับแนะนำ
สัปดาห์ 1: งาน 1 (ล็อกโครงสร้างให้คน 3 ต่อ PWA ได้) → งาน 5 · สัปดาห์ 2: งาน 2, 4, 6 · สัปดาห์ 3: งาน 3 + ทดสอบกับ Supabase จริง (TC-O1–O9, TC-X6, TC-O9)
