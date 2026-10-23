-- FoodFlow — ข้อมูลตัวอย่างสำหรับทดลอง (รันหลัง migrations ทั้งหมด)

do $$
declare
  rid uuid;
  c1 uuid;
  c2 uuid;
begin
  insert into restaurants (name) values ('ร้านตัวอย่าง FoodFlow') returning id into rid;

  insert into menu_categories (restaurant_id, name, sort_order) values (rid, 'จานเดียว', 1) returning id into c1;
  insert into menu_categories (restaurant_id, name, sort_order) values (rid, 'เครื่องดื่ม', 2) returning id into c2;

  insert into menu_items (restaurant_id, category_id, name, price) values
    (rid, c1, 'ผัดกะเพราหมูสับ', 60),
    (rid, c1, 'ข้าวผัดกุ้ง', 70),
    (rid, c1, 'ข้าวมันไก่', 50),
    (rid, c2, 'ชาเย็น', 30),
    (rid, c2, 'น้ำเปล่า', 10);

  insert into dining_tables (restaurant_id, label)
  select rid, 'โต๊ะ ' || g from generate_series(1, 5) g;
end;
$$;

-- ดู id โต๊ะ เพื่อทำลิงก์ QR:  https://<โดเมน>/t/<id>
select t.id as table_id, t.label from dining_tables t order by t.label;

-- ผูกพนักงานกับร้าน (ทำหลังสมัครผู้ใช้ใน Supabase → Authentication → Users แล้ว)
-- แทนที่ <USER-ID> ด้วย id ของผู้ใช้ และ <RESTAURANT-ID> ด้วย id ร้านจากตาราง restaurants
-- insert into staff_members (user_id, restaurant_id, role)
-- values ('<USER-ID>', '<RESTAURANT-ID>', 'owner');
-- บทบาทที่ใช้ได้: owner | staff | kitchen | accountant | stock
