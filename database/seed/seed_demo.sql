-- Plato — ข้อมูลทดลอง (DEMO) สำหรับดูหน้าวิเคราะห์ช่วงพีค/ออฟพีค และต้นทุนต่อเมนู
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

  -- วัตถุดิบ ผู้ขาย และสูตรตัวอย่าง (สร้างเฉพาะเมื่อร้านยังไม่มีวัตถุดิบ · ต้องรัน migration 0027-0030 แล้ว)
  -- หน่วยฐาน g / ml / pcs · ยอดเริ่มต้นบันทึกเป็นรายการยกมาใน ledger และเป็นล็อตแรกให้อัตโนมัติ
  if not exists (select 1 from ingredients where restaurant_id = rid) then
    insert into suppliers (restaurant_id, name, phone, lead_time_days, delivery_days) values
      (rid, 'ตลาดไท ผักสด', '081-000-0001', 1, '{1,2,3,4,5,6}'),
      (rid, 'แม็คโคร', '02-000-0002', 1, '{1,4}'),
      (rid, 'ฟาร์มสมบูรณ์ (หมู ไก่ ไข่)', '089-000-0003', 2, '{2,5}')
    on conflict do nothing;

    insert into ingredients (restaurant_id, name, recipe_unit, unit, quantity_on_hand, reorder_level, safety_stock, cost_per_unit,
                             purchase_unit, conversion_factor, display_unit, display_factor, trim_yield_pct, cook_yield_pct,
                             abc_class, storage_location, shelf_order, supplier_id)
    -- หน่วยนับ (du x df + เศษเป็นหน่วยฐาน): ข้าวนับเป็นถุง ซื้อเป็นกระสอบ · ไก่แยกชิ้นส่วนนับเป็น kg
    -- ขิงนับทั้งหัว (trim 70% = ปอกแล้วซอย) · น้ำเปล่านับเป็นแพ็ค + ขวดย่อย (หน่วยฐาน pcs ชื่อ "ขวด")
    select rid, v.name, v.ru, v.bu, v.qty, v.reorder, v.safety, v.cost, v.pu, v.cf, v.du, v.df, v.trim, v.cook,
           v.abc, v.loc, v.shelf, (select id from suppliers s where s.restaurant_id = rid and s.name = v.sup)
    from (values
      ('ข้าวสวย',          'g',   'g',    30000, 5000, 5000, 0.03,  'กระสอบ', 15000, 'ถุง',   5000, 100, 100, 'B', 'ชั้นแห้ง',    1, 'แม็คโคร'),
      ('หมูสับ',           'g',   'g',     5000, 1000,  800, 0.18,  'kg',     1000, 'ถุง',    500, 100, 100, 'A', 'ตู้แช่ 1',     1, 'ฟาร์มสมบูรณ์ (หมู ไก่ ไข่)'),
      ('ใบกะเพรา',         'g',   'g',      800,  200,  100, 0.15,  'kg',     1000, 'กำ',     100,  80, 100, 'C', 'ตู้เย็นผัก',   1, 'ตลาดไท ผักสด'),
      ('ไข่ไก่',           'pcs', 'pcs',    120,   30,   30, 4.5,   'แผง',     30, 'ฟอง',      1, 100, 100, 'B', 'ตู้เย็นผัก',   2, 'ฟาร์มสมบูรณ์ (หมู ไก่ ไข่)'),
      ('กุ้ง',             'g',   'g',     3000,  600,  500, 0.40,  'kg',     1000, 'ถุง',   1000, 100, 100, 'A', 'ตู้แช่ 1',     2, 'แม็คโคร'),
      ('อกไก่',            'g',   'g',     3000,  600,  500, 0.09,  'kg',     1000, 'kg',    1000, 100, 100, 'A', 'ตู้แช่ 2',     1, 'ฟาร์มสมบูรณ์ (หมู ไก่ ไข่)'),
      ('สะโพกไก่',         'g',   'g',     2000,  400,  300, 0.08,  'kg',     1000, 'kg',    1000, 100, 100, 'A', 'ตู้แช่ 2',     2, 'ฟาร์มสมบูรณ์ (หมู ไก่ ไข่)'),
      ('น่องไก่',          'g',   'g',     1500,  300,  200, 0.075, 'kg',     1000, 'kg',    1000, 100, 100, 'B', 'ตู้แช่ 2',     3, 'ฟาร์มสมบูรณ์ (หมู ไก่ ไข่)'),
      ('ปีกไก่',           'g',   'g',     1500,  300,  200, 0.11,  'kg',     1000, 'kg',    1000, 100, 100, 'B', 'ตู้แช่ 2',     4, 'ฟาร์มสมบูรณ์ (หมู ไก่ ไข่)'),
      ('ผงชาไทย',          'g',   'g',     1000,  200,  200, 0.30,  'ถุง',     400, 'ถุง',    400, 100, 100, 'B', 'ชั้นแห้ง',    2, 'แม็คโคร'),
      ('นมข้น',            'ml',  'ml',    3000,  500,  500, 0.06,  'กระป๋อง', 380, 'กระป๋อง', 380, 100, 100, 'C', 'ชั้นแห้ง',    3, 'แม็คโคร'),
      ('น้ำเปล่า',          'pcs', 'ขวด',    96,   24,   24, 3,     'แพ็ค',     12, 'แพ็ค',     12, 100, 100, 'C', 'หน้าร้าน',     1, 'แม็คโคร'),
      ('ขิง',              'g',   'g',     1000,  300,  200, 0.06,  'kg',     1000, 'kg',    1000,  70, 100, 'C', 'ตู้เย็นผัก',   3, 'ตลาดไท ผักสด'),
      ('เต้าเจี้ยว',        'ml',  'ml',    2000,  400,  300, 0.05,  'ขวด',    700, 'ขวด',    700, 100, 100, 'C', 'ชั้นแห้ง',    4, 'แม็คโคร'),
      ('น้ำส้มสายชู',       'ml',  'ml',    1500,  300,  200, 0.03,  'ขวด',    700, 'ขวด',    700, 100, 100, 'C', 'ชั้นแห้ง',    5, 'แม็คโคร')
    ) as v(name, ru, bu, qty, reorder, safety, cost, pu, cf, du, df, trim, cook, abc, loc, shelf, sup);

    -- สูตรย่อย: น้ำจิ้มข้าวมันไก่ 1 หม้อ = 1000 ml (ตัดวัตถุดิบดิบตอนขาย ไม่ต้องบันทึกการผลิต)
    insert into recipes (restaurant_id, name, output_qty, output_unit, note)
    values (rid, 'น้ำจิ้มข้าวมันไก่', 1000, 'ml', 'ตัวอย่างสูตรซ้อน');
    insert into recipe_lines (recipe_id, ingredient_id, qty)
    select r.id, i.id, v.qty
    from (values ('เต้าเจี้ยว', 600), ('ขิง', 150), ('น้ำส้มสายชู', 250)) as v(ing_name, qty)   -- ขิงซอยสุทธิ 150 g (ตัดขิงทั้งหัว 214 g)
    join recipes r on r.restaurant_id = rid and r.name = 'น้ำจิ้มข้าวมันไก่'
    join ingredients i on i.restaurant_id = rid and i.name = v.ing_name;

    -- สูตรเมนู (ปริมาณสุทธิต่อ 1 จาน)
    insert into recipes (restaurant_id, name, menu_item_id, output_qty, output_unit)
    select rid, m.name, m.id, 1, case when c.name = 'เครื่องดื่ม' then 'แก้ว' else 'จาน' end
    from menu_items m left join menu_categories c on c.id = m.category_id
    where m.restaurant_id = rid and m.name in ('ผัดกะเพราหมูสับ', 'ข้าวผัดกุ้ง', 'ข้าวมันไก่', 'ชาเย็น', 'น้ำเปล่า');

    insert into recipe_lines (recipe_id, ingredient_id, qty)
    select r.id, i.id, v.qty
    from (values
      ('ผัดกะเพราหมูสับ', 'ข้าวสวย', 200),
      ('ผัดกะเพราหมูสับ', 'หมูสับ', 100),
      ('ผัดกะเพราหมูสับ', 'ใบกะเพรา', 12),        -- สุทธิ 12 g / trim 80% = ดิบ 15 g
      ('ผัดกะเพราหมูสับ', 'ไข่ไก่', 1),
      ('ข้าวผัดกุ้ง', 'ข้าวสวย', 220),
      ('ข้าวผัดกุ้ง', 'กุ้ง', 80),
      ('ข้าวผัดกุ้ง', 'ไข่ไก่', 1),
      ('ข้าวมันไก่', 'ข้าวสวย', 220),
      ('ข้าวมันไก่', 'อกไก่', 100),
      ('ข้าวมันไก่', 'สะโพกไก่', 50),
      ('ชาเย็น', 'ผงชาไทย', 15),
      ('ชาเย็น', 'นมข้น', 30),
      ('น้ำเปล่า', 'น้ำเปล่า', 1)
    ) as v(menu_name, ing_name, qty)
    join recipes r on r.restaurant_id = rid and r.name = v.menu_name and r.menu_item_id is not null
    join ingredients i on i.name = v.ing_name and i.restaurant_id = rid;

    insert into recipe_lines (recipe_id, sub_recipe_id, qty)
    select m.id, s.id, 40
    from recipes m, recipes s
    where m.restaurant_id = rid and m.name = 'ข้าวมันไก่' and m.menu_item_id is not null
      and s.restaurant_id = rid and s.name = 'น้ำจิ้มข้าวมันไก่';
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
