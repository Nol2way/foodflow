-- FoodFlow — ข้อมูลทดลอง (DEMO) สำหรับดูหน้าวิเคราะห์ช่วงพีค/ออฟพีค และต้นทุนต่อเมนู
-- รันหลัง seed.sql และ migrations ทั้งหมด
--
-- ⚠️ ข้อมูลนี้สร้างขึ้นเอง ไม่ใช่ข้อมูลจริงของร้านใด:
--    - ออเดอร์ย้อนหลัง 6 สัปดาห์ จำลองให้มีพีคมื้อเที่ยง (11-14 น.) และมื้อเย็น (18-21 น.) วันหยุดคึกคักกว่า
--    - ราคาวัตถุดิบและสูตรอาหารเป็นตัวเลขสมมติ
-- ลบออเดอร์ทดลองทั้งหมดก่อนใช้งานจริง:  delete from orders where is_demo;
-- (ใช้ได้กับร้านแรกในตาราง restaurants)

do $$
declare
  rid uuid;
  items uuid[];
  d date;
  h int;
  n int;
  i int;
  k int;
  v_base numeric;
  v_factor numeric;
  v_at timestamptz;
  v_order uuid;
  v_table uuid;
  v_menu uuid;
  v_price numeric;
  v_qty int;
  v_total numeric;
begin
  select id into rid from restaurants order by created_at limit 1;
  if rid is null then
    raise exception 'ไม่พบร้านใน restaurants: รัน seed.sql ก่อน';
  end if;

  -- เริ่มใหม่ทุกครั้งที่รัน ไม่ให้ข้อมูลทดลองซ้ำซ้อน
  delete from orders where is_demo and restaurant_id = rid;

  -- วัตถุดิบและสูตรตัวอย่าง (สร้างเฉพาะเมื่อร้านยังไม่มีวัตถุดิบ)
  if not exists (select 1 from ingredients where restaurant_id = rid) then
    insert into ingredients (restaurant_id, name, unit, quantity_on_hand, reorder_level, cost_per_unit) values
      (rid, 'ข้าวสวย', 'g', 20000, 3000, 0.03),
      (rid, 'หมูสับ', 'g', 5000, 1000, 0.18),
      (rid, 'ใบกะเพรา', 'g', 800, 200, 0.15),
      (rid, 'ไข่ไก่', 'ฟอง', 120, 30, 4.5),
      (rid, 'กุ้ง', 'g', 3000, 600, 0.40),
      (rid, 'ไก่ต้ม', 'g', 4000, 800, 0.12),
      (rid, 'ผงชาไทย', 'g', 1000, 200, 0.30),
      (rid, 'นมข้น', 'ml', 3000, 500, 0.06),
      (rid, 'น้ำเปล่า (ขวด)', 'ขวด', 100, 24, 3);

    insert into recipes (menu_item_id, ingredient_id, quantity_used)
    select m.id, i.id, v.qty
    from (values
      ('ผัดกะเพราหมูสับ', 'ข้าวสวย', 200),
      ('ผัดกะเพราหมูสับ', 'หมูสับ', 100),
      ('ผัดกะเพราหมูสับ', 'ใบกะเพรา', 15),
      ('ผัดกะเพราหมูสับ', 'ไข่ไก่', 1),
      ('ข้าวผัดกุ้ง', 'ข้าวสวย', 220),
      ('ข้าวผัดกุ้ง', 'กุ้ง', 80),
      ('ข้าวผัดกุ้ง', 'ไข่ไก่', 1),
      ('ข้าวมันไก่', 'ข้าวสวย', 220),
      ('ข้าวมันไก่', 'ไก่ต้ม', 150),
      ('ชาเย็น', 'ผงชาไทย', 15),
      ('ชาเย็น', 'นมข้น', 30),
      ('น้ำเปล่า', 'น้ำเปล่า (ขวด)', 1)
    ) as v(menu_name, ing_name, qty)
    join menu_items m on m.name = v.menu_name and m.restaurant_id = rid
    join ingredients i on i.name = v.ing_name and i.restaurant_id = rid;
  end if;

  select array_agg(id) into items from menu_items where restaurant_id = rid;
  if items is null then
    raise exception 'ร้านยังไม่มีเมนู: รัน seed.sql ก่อน';
  end if;

  -- ออเดอร์ทดลองย้อนหลัง 42 วัน (ตามเวลาท้องถิ่น Asia/Bangkok)
  for d in select g::date from generate_series(current_date - 42, current_date - 1, interval '1 day') g loop
    v_factor := case when extract(dow from d) in (0, 6) then 1.3 else 1.0 end;
    for h in 10..21 loop
      v_base := case
        when h between 11 and 13 then 10
        when h between 18 and 20 then 8
        when h in (15, 16) then 1
        else 3
      end;
      n := greatest(0, round(v_base * v_factor * (0.7 + random() * 0.6))::int);
      for i in 1..n loop
        v_at := (d + make_interval(hours => h, mins => floor(random() * 60)::int))::timestamp at time zone 'Asia/Bangkok';
        select id into v_table from dining_tables where restaurant_id = rid order by random() limit 1;

        insert into orders (restaurant_id, table_id, status, total, created_at, started_at, ready_at, paid_at, stock_deducted_at, is_demo)
        values (rid, v_table, 'paid', 0, v_at, v_at + interval '2 minutes',
                v_at + make_interval(mins => 8 + floor(random() * 10)::int),
                v_at + interval '40 minutes', v_at, true)
        returning id into v_order;

        v_total := 0;
        for k in 1..(1 + floor(random() * 3)::int) loop
          v_menu := items[1 + floor(random() * array_length(items, 1))::int];
          v_qty := 1 + floor(random() * 2)::int;
          select m.price into v_price from menu_items m where m.id = v_menu;
          insert into order_items (order_id, menu_item_id, quantity, unit_price)
          values (v_order, v_menu, v_qty, v_price);
          v_total := v_total + v_price * v_qty;
        end loop;

        update orders set total = v_total where id = v_order;
      end loop;
    end loop;
  end loop;
end;
$$;

-- ===== ข้อมูลทดลองจอแสดงผล iPad (ต้องรัน migration 0013, 0014 แล้ว) =====
-- รูป/คลิปเป็นลิงก์จาก Wikimedia Commons (สัญญาอนุญาตเสรี ต้องแสดงเครดิต จึงใส่ไว้ในช่อง credit)
-- จากนั้นเจ้าของร้าน/ผู้จัดการกด "สร้างลิงก์จอ" ที่หน้าจัดการเมนู แล้วเปิดลิงก์บน iPad
do $$
declare
  rid uuid;
  v_promo uuid;
  wm text := 'https://upload.wikimedia.org/wikipedia/commons/';
begin
  select id into rid from restaurants order by created_at limit 1;
  if rid is null or not exists (select 1 from information_schema.tables where table_name = 'display_media') then
    return;
  end if;

  update menu_items m set is_recommended = true, description = v.descr
  from (values
    ('ผัดกะเพราหมูสับ', 'กะเพราแท้ผัดไฟแรง หอมกลิ่นกระทะ เสิร์ฟพร้อมไข่ดาวขอบกรอบ'),
    ('ข้าวผัดกุ้ง', 'ข้าวผัดเม็ดสวย กุ้งตัวโต บีบมะนาวเพิ่มความสดชื่น'),
    ('ข้าวมันไก่', 'ไก่ต้มนุ่มฉ่ำ ข้าวมันหอมขิง น้ำจิ้มเต้าเจี้ยวสูตรร้าน'),
    ('ชาเย็น', 'ชาไทยชงเข้ม หวานมันกำลังดี เย็นชื่นใจ')
  ) as v(menu_name, descr)
  where m.restaurant_id = rid and m.name = v.menu_name;

  -- เริ่มใหม่ทุกครั้งที่รัน (ลบเฉพาะสื่อทดลองที่เป็นลิงก์ Wikimedia)
  delete from display_media where restaurant_id = rid and url like wm || '%';
  delete from display_media where restaurant_id = rid and url = 'https://www.youtube.com/watch?v=SGCANs-B8js';

  insert into display_media (restaurant_id, menu_item_id, kind, url, credit, sort_order)
  select rid, m.id, 'image', wm || v.path, v.credit, v.ord
  from (values
    ('ผัดกะเพราหมูสับ', 1, 'a/a3/%E0%B8%82%E0%B9%89%E0%B8%B2%E0%B8%A7%E0%B8%A3%E0%B8%B2%E0%B8%94%E0%B8%9C%E0%B8%B1%E0%B8%94%E0%B8%81%E0%B8%B0%E0%B9%80%E0%B8%9E%E0%B8%A3%E0%B8%B2%E0%B8%B0%E0%B8%AB%E0%B8%A1%E0%B8%B9%E0%B8%AA%E0%B8%B1%E0%B8%9A%E0%B9%84%E0%B8%82%E0%B9%88%E0%B8%94%E0%B8%B2%E0%B8%A7%E0%B9%84%E0%B8%A1%E0%B9%88%E0%B9%83%E0%B8%AA%E0%B9%88%E0%B8%9E%E0%B8%A3%E0%B8%B4%E0%B8%81.jpg',
     'ภาพ: Vee Satayamas · CC BY 4.0 · Wikimedia Commons'),
    ('ผัดกะเพราหมูสับ', 2, '5/54/Pad_Krapow_Moo_%285338909764%29.jpg',
     'ภาพ: Ryan Snyder · CC BY 2.0 · Wikimedia Commons'),
    ('ข้าวผัดกุ้ง', 1, '7/72/Khao_Phat_Kung.jpg', 'ภาพ: Mattes · สาธารณสมบัติ · Wikimedia Commons'),
    ('ข้าวมันไก่', 1, 'd/d2/Khao_man_gai.jpg', 'ภาพ: stu_spivack · CC BY-SA 2.0 · Wikimedia Commons'),
    ('ชาเย็น', 1, '0/0a/Cha_Yen_-_Mint_Thai_AUD2.50.jpg', 'ภาพ: avlxyz · CC BY-SA 2.0 · Wikimedia Commons')
  ) as v(menu_name, ord, path, credit)
  join menu_items m on m.restaurant_id = rid and m.name = v.menu_name;

  -- สไลด์โฆษณาร้าน: คลิปวิดีโอ (ไม่มีเสียง) + ตัวอย่างลิงก์ YouTube (ปิดไว้ เพราะเป็นคลิปเดียวกัน เปิดได้ที่หน้าจัดการเมนู)
  insert into display_media (restaurant_id, kind, url, title, caption, credit, duration_sec, sort_order, is_active) values
    (rid, 'video', wm || '0/0c/10_Things_to_Eat_at_Rot_Fai_Night_Market_in_Bangkok.webm',
     'อร่อยแบบสตรีทฟู้ดกรุงเทพ', 'รสชาติจัดจ้านแบบตลาดนัดกลางคืน ส่งตรงถึงโต๊ะคุณ',
     'คลิป: SETHLUI.com · CC BY 3.0 · Wikimedia Commons', 30, 1, true),
    (rid, 'youtube', 'https://www.youtube.com/watch?v=SGCANs-B8js',
     'ตัวอย่างคลิป YouTube', 'ใส่ลิงก์ YouTube ได้ที่หน้าจัดการเมนู', 'คลิป: SETHLUI.com', 30, 2, false);

  -- โปรทดลองให้จอมีสไลด์โปร (สร้างครั้งเดียว)
  if not exists (select 1 from promotions where restaurant_id = rid and name = 'ชาเย็นลด 20% (ทดลอง)') then
    insert into promotions (restaurant_id, name, discount_type, value)
    values (rid, 'ชาเย็นลด 20% (ทดลอง)', 'percent', 20) returning id into v_promo;
    insert into promotion_items (promotion_id, menu_item_id)
    select v_promo, id from menu_items where restaurant_id = rid and name = 'ชาเย็น';
  end if;
end;
$$;
