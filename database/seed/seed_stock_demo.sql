-- Plato — ข้อมูลทดลองโมดูลสต็อก (ไม่บังคับ) รันหลัง seed.sql + seed_demo.sql
-- ให้หน้าภาพรวม/รายงานส่วนต่าง/yield test มีข้อมูลให้ดูทันที:
--   - ใบรับของย้อนหลัง 21 วัน (ล็อตพร้อมวันหมดอายุ บางล็อตใกล้หมดอายุ)
--   - ใบนับ 3 รอบ (14, 7, 1 วันก่อน) หมูสับติดลบทุกรอบ -> เตือน "สูตรหรือ yield อาจไม่ตรง"
--   - yield test ใบกะเพรา 3 ครั้ง
-- ⚠️ ข้อมูลสมมติ และลงบัญชีอัตโนมัติ (ซื้อวัตถุดิบเป็นเงินสด / ส่วนต่างสต็อก) อย่ารันกับร้านที่ใช้งานจริง
-- รันซ้ำได้: ข้ามถ้าเคยรันแล้ว (ดูจากเลขบิล DEMO-STOCK-1)

do $$
declare
  rid uuid;
  v_receipt uuid;
  v_count uuid;
  v_day int;
  v_at timestamptz;
  r record;
  v_sup uuid;
begin
  select id into rid from restaurants order by created_at limit 1;
  if rid is null or not exists (select 1 from ingredients where restaurant_id = rid) then
    raise exception 'รัน seed.sql และ seed_demo.sql ก่อน';
  end if;
  if exists (select 1 from stock_receipts where restaurant_id = rid and invoice_no = 'DEMO-STOCK-1') then
    return;
  end if;

  -- ===== ใบรับของ 21 วันก่อน (แม็คโคร) =====
  v_at := now() - interval '21 days';
  select id into v_sup from suppliers where restaurant_id = rid and name = 'แม็คโคร';
  insert into stock_receipts (restaurant_id, supplier, supplier_id, invoice_no, received_on, note, received_by_name, created_at)
  values (rid, 'แม็คโคร', v_sup, 'DEMO-STOCK-1', (v_at at time zone 'Asia/Bangkok')::date, 'ข้อมูลทดลอง', 'ระบบ (ทดลอง)', v_at)
  returning id into v_receipt;

  for r in
    select i.id, i.name, i.unit, v.packs * i.conversion_factor as qty, v.price / i.conversion_factor as cost,
           i.conversion_factor as pack_size, v.packs, v.price, v.expiry
    from (values ('หมูสับ', 3, 190, 2), ('กุ้ง', 2, 420, 3), ('ไข่ไก่', 2, 130, 10), ('นมข้น', 4, 24, 120))
         as v(name, packs, price, expiry)
    join ingredients i on i.restaurant_id = rid and i.name = v.name
  loop
    insert into stock_receipt_lines (receipt_id, ingredient_id, ingredient_name, unit, quantity, unit_cost, line_total,
                                     invoice_qty, pack_qty, pack_size, pack_price, expiry_date)
    values (v_receipt, r.id, r.name, r.unit, r.qty, r.cost, round(r.qty * r.cost, 2), r.qty, r.packs, r.pack_size, r.price,
            current_date + r.expiry);
    insert into stock_movements (restaurant_id, ingredient_id, change, type, unit_cost, expiry_date, note, receipt_id, created_at)
    values (rid, r.id, r.qty, 'receive', r.cost, current_date + r.expiry, 'รับของ แม็คโคร บิล DEMO-STOCK-1', v_receipt, v_at);
  end loop;
  update stock_receipts
     set item_count = (select count(*) from stock_receipt_lines where receipt_id = v_receipt),
         total_cost = (select sum(line_total) from stock_receipt_lines where receipt_id = v_receipt),
         invoice_total = (select sum(line_total) from stock_receipt_lines where receipt_id = v_receipt)
   where id = v_receipt;

  -- ===== ใบนับ 3 รอบ: หมูสับขาด 150 g ทุกรอบ · ไข่ไก่ตรง · กุ้งเกินเล็กน้อยรอบแรก =====
  foreach v_day in array array[14, 7, 1] loop
    v_at := now() - make_interval(days => v_day);
    insert into stock_counts (restaurant_id, counted_by_name, count_type, note, created_at)
    values (rid, 'พนักงานสต็อก (ทดลอง)', 'weekly', 'นับประจำสัปดาห์ (ทดลอง)', v_at)
    returning id into v_count;
    for r in
      select i.id, i.name, i.unit, i.quantity_on_hand as expected, i.cost_per_unit,
             greatest(i.quantity_on_hand + case i.name when 'หมูสับ' then -150 when 'กุ้ง' then case when v_day = 14 then 20 else 0 end else 0 end, 0) as counted
      from ingredients i where i.restaurant_id = rid and i.name in ('หมูสับ', 'ไข่ไก่', 'กุ้ง')
    loop
      insert into stock_count_lines (count_id, ingredient_id, ingredient_name, unit, system_qty, counted_qty, diff, unit_cost,
                                     opening_qty, received_qty, deducted_qty, note)
      values (v_count, r.id, r.name, r.unit, r.expected, r.counted, r.counted - r.expected, r.cost_per_unit,
              r.expected, 0, 0, case when r.name = 'หมูสับ' then 'ไม่ทราบสาเหตุ' end);
      if r.counted <> r.expected then
        insert into stock_movements (restaurant_id, ingredient_id, change, type, note, count_id, created_at)
        values (rid, r.id, r.counted - r.expected, 'count_adjust', 'นับสต็อก', v_count, v_at);
      end if;
    end loop;
    update stock_counts
       set item_count = (select count(*) from stock_count_lines where count_id = v_count),
           diff_count = (select count(*) from stock_count_lines where count_id = v_count and diff <> 0),
           diff_value = (select coalesce(sum(round(diff * unit_cost, 2)), 0) from stock_count_lines where count_id = v_count)
     where id = v_count;
  end loop;

  -- ===== yield test: ใบกะเพราเด็ดก้าน 3 ครั้ง (เฉลี่ย 80%) =====
  insert into yield_tests (restaurant_id, ingredient_id, kind, trials, avg_pct, applied, note, tested_by_name, created_at)
  select rid, i.id, 'trim', '[{"before":500,"after":400},{"before":450,"after":355},{"before":520,"after":420}]'::jsonb,
         round((400.0 / 500 + 355.0 / 450 + 420.0 / 520) / 3 * 100, 2), true, 'เด็ดก้านแข็งออก', 'ครัว (ทดลอง)', now() - interval '10 days'
  from ingredients i where i.restaurant_id = rid and i.name = 'ใบกะเพรา';
end;
$$;
