-- Plato — ข้อมูลตัวอย่างสำหรับทดลอง (รันหลัง migrations ทั้งหมด)

do $$
declare
  rid uuid;
  c1 uuid;
  c2 uuid;
begin
  -- รันซ้ำได้: มีร้านตัวอย่างแล้วไม่สร้างซ้ำ
  if exists (select 1 from restaurants where name = 'ร้านตัวอย่าง Plato') then
    raise notice 'มีร้านตัวอย่างอยู่แล้ว ข้าม seed.sql';
    return;
  end if;

  insert into restaurants (name) values ('ร้านตัวอย่าง Plato') returning id into rid;

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

-- สร้างเจ้าของร้านคนแรก (ผู้ใช้อยู่ในตาราง app_users ของระบบเอง ไม่ใช้ Supabase Auth แล้ว · 0021)
-- แก้อีเมล/รหัสผ่าน (อย่างน้อย 8 ตัว) แล้วรัน · พนักงานคนต่อไป เจ้าของเพิ่มเองที่หน้า /staff
-- insert into staff_members (user_id, restaurant_id, role)
-- select app_create_user('owner@example.com', 'เปลี่ยนรหัสนี้', 'เจ้าของร้าน', false),
--        (select id from restaurants order by created_at limit 1), 'owner';
-- บทบาทที่ใช้ได้: owner | manager | staff | kitchen | accountant | stock
-- คนเดียวมีหลายบทบาทได้: insert ซ้ำอีกแถวด้วยบทบาทอื่น (0020)
