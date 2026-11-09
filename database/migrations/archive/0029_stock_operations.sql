-- 0029: งานประจำวันของสต็อก (โมดูลสต็อกวัตถุดิบ ตอนที่ 3/4)
--   - รับเข้า: เลือกผู้ขาย จำนวน ราคา ขนาดบรรจุ วันหมดอายุ -> สร้างล็อต · เตือนเมื่อราคา/ขนาดบรรจุเปลี่ยนจากครั้งก่อน
--     ราคาเปลี่ยน -> ราคาซื้อล่าสุดของวัตถุดิบเปลี่ยน -> คำนวณต้นทุนทุกสูตรที่ใช้ใหม่ (0028)
--   - นับสต็อก (Actual vs Theoretical):
--       ยอดที่ควรเหลือ = นับรอบก่อน + นำเข้า − ตัดตามสูตร   (= ยอดใน ledger ตอนนับ)
--       ส่วนต่าง = นับจริง − ยอดที่ควรเหลือ   (ติดลบ = ของหายไม่ทราบสาเหตุ)
--       สี: เขียว |%| < 2 · เหลือง 2-5 · แดง > 5 ของยอดที่ควรเหลือ · ติดลบต่อเนื่อง 3 รอบ = สูตรหรือ yield อาจไม่ตรง
--     นับแบบ blind: ใบนับไม่มียอดในระบบ · บันทึกแล้วปรับยอดทันที (count_adjust) · ผู้ตรวจ (เจ้าของ/ผู้จัดการ) เซ็นรับรองภายหลัง
--   - Yield test: ชั่งก่อน-หลัง 3 ครั้ง บันทึกค่าเฉลี่ย (เลือกนำไปใช้กับวัตถุดิบได้)
--   - Par = ใช้ต่อวัน x (lead time + รอบสั่ง) + safety stock · แนะนำสั่ง = par − คงเหลือ
--   - ภาพรวม ประวัติ และการกลับรายการ

-- ===== 1) ใบรับของ =====
alter table stock_receipt_lines add column if not exists pack_qty numeric(14,3) check (pack_qty > 0);       -- จำนวนแพ็ค/ลัง
alter table stock_receipt_lines add column if not exists pack_size numeric(14,3) check (pack_size > 0);     -- 1 แพ็ค = ? หน่วยฐาน
alter table stock_receipt_lines add column if not exists pack_price numeric(14,4) check (pack_price >= 0);  -- ราคาต่อแพ็ค
alter table stock_receipt_lines add column if not exists expiry_date date;
alter table stock_receipt_lines add column if not exists prev_pack_size numeric(14,3);
alter table stock_receipt_lines add column if not exists price_change_pct numeric(8,2);     -- เทียบราคาต่อหน่วยฐานครั้งก่อน
alter table stock_receipt_lines add column if not exists pack_changed boolean not null default false;

-- p_lines: [{
--   "ingredient_id": "...",
--   "pack_qty": 3, "pack_size": 1000, "pack_price": 180,   แบบแพ็ค: 3 ถุง x 1000 g @ 180 บาท/ถุง
--   "quantity": 3000, "unit_cost": 0.18,                    หรือกรอกเป็นหน่วยฐานตรงๆ (รับจริง)
--   "expiry_date": "2026-11-02",
--   "invoice_qty", "invoice_unit", "invoice_unit_qty", "gross_qty", "entered_*", "note"   ตรวจรับเทียบบิล (0025)
-- }]
drop function if exists submit_stock_receipt(uuid, jsonb, text, text, date, text, boolean);
create function submit_stock_receipt(
  p_restaurant_id uuid,
  p_lines jsonb,
  p_supplier text default null,
  p_invoice_no text default null,
  p_received_on date default null,
  p_note text default null,
  p_record_expense boolean default true,
  p_supplier_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_name text;
  l record;
  v_tol numeric;
  v_received_total numeric := 0;
  v_invoice_total numeric := 0;
  v_claim_total numeric := 0;
  v_items int := 0;
  v_expense uuid;
  v_label text;
  v_supplier text := nullif(left(trim(p_supplier), 100), '');
  v_on date := coalesce(p_received_on, current_date);
  v_qty numeric;
  v_cost numeric;
  v_inv numeric;
  v_status text;
  v_claim numeric;
  v_prev record;
  v_diff_unit boolean;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock']) then
    raise exception 'forbidden';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'no_lines';
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'too_many_lines';
  end if;
  if (select count(*) from jsonb_array_elements(p_lines) e)
     <> (select count(distinct e->>'ingredient_id') from jsonb_array_elements(p_lines) e) then
    raise exception 'duplicate_ingredient';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) e
    where not exists (select 1 from ingredients i where i.id = (e->>'ingredient_id')::uuid and i.restaurant_id = p_restaurant_id)
  ) then
    raise exception 'invalid_ingredient';
  end if;
  if v_on > current_date + 1 then
    raise exception 'invalid_date';
  end if;
  if p_supplier_id is not null then
    select name into v_supplier from suppliers where id = p_supplier_id and restaurant_id = p_restaurant_id;
    if v_supplier is null then
      raise exception 'invalid_supplier';
    end if;
  end if;

  select coalesce((select receive_tolerance_pct from shop_settings where restaurant_id = p_restaurant_id), 2) into v_tol;
  select coalesce(display_name, email) into v_name from app_users where id = auth.uid();
  insert into stock_receipts (restaurant_id, supplier, supplier_id, invoice_no, received_on, note, received_by, received_by_name)
  values (p_restaurant_id, v_supplier, p_supplier_id, nullif(left(trim(p_invoice_no), 50), ''),
          v_on, nullif(left(trim(p_note), 300), ''), auth.uid(), v_name)
  returning id into v_id;
  v_label := 'รับของ' || coalesce(' ' || v_supplier, '') || coalesce(' บิล ' || nullif(trim(p_invoice_no), ''), '');

  for l in
    select i.id, i.name, i.unit, i.last_unit_cost,
           (e->>'quantity')::numeric as qty, (e->>'unit_cost')::numeric as cost,
           (e->>'pack_qty')::numeric as pack_qty, (e->>'pack_size')::numeric as pack_size,
           (e->>'pack_price')::numeric as pack_price, (e->>'expiry_date')::date as expiry,
           (e->>'invoice_qty')::numeric as inv_qty,
           nullif(left(trim(e->>'invoice_unit'), 30), '') as inv_unit,
           (e->>'invoice_unit_qty')::numeric as inv_unit_qty,
           (e->>'gross_qty')::numeric as gross,
           nullif(left(trim(e->>'entered_unit'), 30), '') as e_unit,
           (e->>'entered_qty')::numeric as e_qty, (e->>'entered_unit_cost')::numeric as e_cost,
           nullif(left(trim(e->>'note'), 200), '') as line_note
    from jsonb_array_elements(p_lines) e
    join ingredients i on i.id = (e->>'ingredient_id')::uuid and i.restaurant_id = p_restaurant_id
    order by i.id
  loop
    -- แบบแพ็ค -> หน่วยฐาน
    if l.pack_size is not null and (l.pack_size <= 0 or l.pack_size > 1000000) then raise exception 'invalid_pack_size'; end if;
    if l.pack_qty is not null and l.pack_qty < 0 then raise exception 'invalid_quantity'; end if;
    if l.pack_price is not null and l.pack_price < 0 then raise exception 'invalid_cost'; end if;
    v_qty := coalesce(l.qty, l.pack_qty * l.pack_size);
    v_cost := coalesce(l.cost, l.pack_price / l.pack_size);
    if v_qty is null or v_qty < 0 or v_qty > 100000000 then raise exception 'invalid_quantity'; end if;
    if v_cost is null or v_cost < 0 then raise exception 'invalid_cost'; end if;
    if l.inv_qty is not null and (l.inv_qty < 0 or l.inv_qty > 100000000) then raise exception 'invalid_quantity'; end if;
    if l.gross is not null and l.gross < v_qty then raise exception 'gross_less_than_net: %', l.name; end if;
    if l.expiry is not null and l.expiry < v_on then raise exception 'invalid_expiry: %', l.name; end if;
    v_inv := coalesce(l.inv_qty, v_qty);
    if v_inv = 0 and v_qty = 0 then raise exception 'invalid_quantity'; end if;

    -- ผลตรวจรับ: ห่างจากบิลเกินเกณฑ์ % = ขาด/เกิน · รับ 0 = ตีกลับ
    v_status := case
      when v_qty = 0 then 'rejected'
      when v_qty < v_inv * (1 - v_tol / 100) then 'short'
      when v_qty > v_inv * (1 + v_tol / 100) then 'over'
      else 'ok'
    end;
    v_claim := case when v_status in ('short', 'rejected') then round((v_inv - v_qty) * v_cost, 2) else 0 end;

    -- ครั้งก่อน: ผู้ขายเดียวกันก่อน แล้วจึงผู้ขายใดก็ได้
    select rl.unit_cost, rl.pack_size into v_prev
    from stock_receipt_lines rl join stock_receipts r on r.id = rl.receipt_id
    where rl.ingredient_id = l.id and r.id <> v_id and r.restaurant_id = p_restaurant_id and rl.quantity > 0
    order by (r.supplier_id is not distinct from p_supplier_id and (p_supplier_id is not null or r.supplier is not distinct from v_supplier)) desc,
             r.created_at desc
    limit 1;

    v_diff_unit := l.e_unit is not null and l.e_unit <> l.unit;
    insert into stock_receipt_lines (receipt_id, ingredient_id, ingredient_name, unit, quantity, unit_cost, line_total,
                                     entered_unit, entered_qty, entered_unit_cost,
                                     invoice_qty, invoice_unit, invoice_unit_qty, gross_qty,
                                     status, claim_value, claim_status, prev_unit_cost, line_note,
                                     pack_qty, pack_size, pack_price, expiry_date, prev_pack_size, price_change_pct, pack_changed)
    values (v_id, l.id, l.name, l.unit, round(v_qty, 3), round(v_cost, 7), round(v_qty * v_cost, 2),
            case when v_diff_unit then l.e_unit end, case when v_diff_unit then round(l.e_qty, 3) end,
            case when v_diff_unit then round(l.e_cost, 4) end,
            round(v_inv, 3), l.inv_unit, round(l.inv_unit_qty, 3), round(l.gross, 3),
            v_status, v_claim, case when v_claim > 0 then 'pending' else 'none' end, v_prev.unit_cost, l.line_note,
            l.pack_qty, l.pack_size, l.pack_price, l.expiry, v_prev.pack_size,
            case when v_prev.unit_cost > 0 then round((v_cost - v_prev.unit_cost) / v_prev.unit_cost * 100, 2) end,
            coalesce(l.pack_size <> v_prev.pack_size, false));

    if v_qty > 0 then
      insert into stock_movements (restaurant_id, ingredient_id, change, type, unit_cost, expiry_date, note, receipt_id)
      values (p_restaurant_id, l.id, round(v_qty, 3), 'receive', round(v_cost, 7), l.expiry, v_label, v_id);
      -- ราคาซื้อล่าสุด (ใช้คิดต้นทุนสูตร) เปลี่ยน -> trigger คำนวณสูตรที่เกี่ยวข้องใหม่
      if l.last_unit_cost is distinct from round(v_cost, 7) then
        perform set_config('plato.ledger', 'on', true);
        update ingredients set last_unit_cost = round(v_cost, 7) where id = l.id;
        perform set_config('plato.ledger', '', true);
      end if;
    end if;

    v_received_total := v_received_total + round(v_qty * v_cost, 2);
    v_invoice_total := v_invoice_total + round(v_inv * v_cost, 2);
    v_claim_total := v_claim_total + v_claim;
    v_items := v_items + 1;
  end loop;

  if p_record_expense and v_invoice_total > 0 then
    insert into expenses (restaurant_id, category, amount, spent_on, note)
    values (p_restaurant_id, 'ingredients', v_invoice_total, v_on, left(v_label, 200))
    returning id into v_expense;
  end if;

  update stock_receipts
     set item_count = v_items, total_cost = v_received_total, invoice_total = v_invoice_total,
         claim_total = v_claim_total, expense_id = v_expense
   where id = v_id;
  return v_id;
end;
$$;
revoke execute on function submit_stock_receipt(uuid, jsonb, text, text, date, text, boolean, uuid) from public, anon;
grant execute on function submit_stock_receipt(uuid, jsonb, text, text, date, text, boolean, uuid) to authenticated;

-- รับเข้า + สรุปคำเตือน: ราคา/ขนาดบรรจุเปลี่ยน และจำนวนสูตรที่คำนวณต้นทุนใหม่
create or replace function stock_receive(
  p_restaurant_id uuid,
  p_supplier_id uuid,
  p_lines jsonb,
  p_invoice_no text default null,
  p_received_on date default null,
  p_note text default null,
  p_record_expense boolean default true
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_before jsonb;
  v_changed uuid[];
begin
  -- ราคาซื้อล่าสุดก่อนรับ: ตัวที่เปลี่ยน = สูตรที่ใช้ถูกคำนวณใหม่ (trigger ใน 0028)
  select coalesce(jsonb_object_agg(i.id, i.last_unit_cost), '{}') into v_before
  from ingredients i
  where i.restaurant_id = p_restaurant_id
    and i.id in (select (e->>'ingredient_id')::uuid from jsonb_array_elements(p_lines) e);
  v_id := submit_stock_receipt(p_restaurant_id, p_lines, null, p_invoice_no, p_received_on, p_note, p_record_expense, p_supplier_id);
  select coalesce(array_agg(i.id), '{}') into v_changed
  from ingredients i
  where v_before ? i.id::text and i.last_unit_cost is distinct from (v_before->>i.id::text)::numeric;
  return jsonb_build_object(
    'receipt_id', v_id,
    'warnings', coalesce((
      select jsonb_agg(jsonb_build_object(
               'ingredient_id', ingredient_id, 'ingredient_name', ingredient_name,
               'price_change_pct', price_change_pct, 'prev_unit_cost', prev_unit_cost, 'unit_cost', unit_cost,
               'pack_changed', pack_changed, 'prev_pack_size', prev_pack_size, 'pack_size', pack_size)
             order by ingredient_name)
      from stock_receipt_lines
      where receipt_id = v_id and (coalesce(price_change_pct, 0) <> 0 or pack_changed)
    ), '[]'::jsonb),
    'recosted_recipes', (
      with recursive up(id, depth) as (
        select recipe_id, 0 from recipe_lines where ingredient_id = any(v_changed)
        union all
        select l.recipe_id, up.depth + 1 from recipe_lines l join up on l.sub_recipe_id = up.id where up.depth < 20
      )
      select count(distinct id) from up
    )
  );
end;
$$;
revoke execute on function stock_receive(uuid, uuid, jsonb, text, date, text, boolean) from public, anon;
grant execute on function stock_receive(uuid, uuid, jsonb, text, date, text, boolean) to authenticated;

-- ราคา/ขนาดบรรจุครั้งล่าสุดต่อวัตถุดิบ (หน้ารับเข้าเตือนได้ตั้งแต่ก่อนบันทึก) · ผู้ขายเดียวกันก่อน
create or replace function stock_last_purchases(p_restaurant_id uuid, p_supplier_id uuid default null)
returns table (ingredient_id uuid, unit_cost numeric, pack_size numeric, pack_price numeric, supplier_id uuid, supplier text, received_on date)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;
  return query
  select distinct on (rl.ingredient_id) rl.ingredient_id, rl.unit_cost, rl.pack_size, rl.pack_price, r.supplier_id, r.supplier, r.received_on
  from stock_receipt_lines rl join stock_receipts r on r.id = rl.receipt_id
  where r.restaurant_id = p_restaurant_id and rl.quantity > 0
  order by rl.ingredient_id, (p_supplier_id is not null and r.supplier_id = p_supplier_id) desc, r.created_at desc;
end;
$$;
revoke execute on function stock_last_purchases(uuid, uuid) from public, anon;
grant execute on function stock_last_purchases(uuid, uuid) to authenticated;

-- ===== 2) กลับรายการ (ledger แก้ย้อนหลังไม่ได้) =====
-- รับเข้าผิด/นับผิด -> สร้างรายการตรงข้ามที่อ้างรายการเดิม · ตัด/คืนตามสูตรกลับได้ด้วยการยกเลิกออเดอร์เท่านั้น
create or replace function stock_reverse_movement(p_movement_id uuid, p_reason text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m stock_movements;
  v_id uuid;
begin
  select * into m from stock_movements where id = p_movement_id;
  if m.id is null or not has_role(m.restaurant_id, array['owner', 'manager']) then
    raise exception 'forbidden';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'reason_required';
  end if;
  if m.type not in ('receive', 'count_adjust') or m.reverses_id is not null then
    raise exception 'reverse_not_allowed: %', m.type;
  end if;
  if exists (select 1 from stock_movements where reverses_id = m.id) then
    raise exception 'already_reversed';
  end if;
  insert into stock_movements (restaurant_id, ingredient_id, change, type, reverses_id, receipt_id, count_id, note)
  values (m.restaurant_id, m.ingredient_id, -m.change, m.type, m.id, m.receipt_id, m.count_id,
          left('กลับรายการ: ' || trim(p_reason), 200))
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function stock_reverse_movement(uuid, text) from public, anon;
grant execute on function stock_reverse_movement(uuid, text) to authenticated;

-- ===== 3) นับสต็อก =====
alter table stock_counts drop constraint if exists stock_counts_count_type_check;
alter table stock_counts add constraint stock_counts_count_type_check check (count_type in ('daily', 'weekly', 'monthly', 'spot'));
alter table stock_counts add column if not exists period text generated always as (count_type) stored;    -- ชื่อตามสเปก
alter table stock_counts add column if not exists verified_by uuid references app_users(id) on delete set null;
alter table stock_counts add column if not exists verified_by_name text;
alter table stock_counts add column if not exists verified_at timestamptz;

alter table stock_count_lines add column if not exists opening_qty numeric(14,3);    -- นับรอบก่อน
alter table stock_count_lines add column if not exists received_qty numeric(14,3);   -- นำเข้าระหว่างรอบ
alter table stock_count_lines add column if not exists deducted_qty numeric(14,3);   -- ตัดตามสูตรสุทธิ (หักคืนแล้ว)
alter table stock_count_lines add column if not exists note text check (char_length(note) <= 200);   -- เหตุผล (ไม่บังคับ)
alter table stock_count_lines alter column system_qty type numeric(14,3);
alter table stock_count_lines alter column counted_qty type numeric(14,3);
alter table stock_count_lines alter column diff type numeric(14,3);
alter table stock_count_lines add column if not exists expected_qty numeric(14,3) generated always as (system_qty) stored;
alter table stock_count_lines add column if not exists variance_qty numeric(14,3) generated always as (diff) stored;
alter table stock_count_lines add column if not exists variance_value numeric(14,2) generated always as (round(diff * unit_cost, 2)) stored;
alter table stock_count_lines add column if not exists variance_pct numeric(10,2)
  generated always as (case when system_qty > 0 then round(diff / system_qty * 100, 2) end) stored;

-- สีของส่วนต่าง (ใช้ทั้งฐานข้อมูลและหน้าเว็บ: frontend/src/lib/stockMath.ts)
create or replace function stock_variance_color(p_expected numeric, p_variance numeric)
returns text
language sql immutable set search_path = public, pg_temp as $$
  select case
    when coalesce(p_expected, 0) <= 0 then case when coalesce(p_variance, 0) = 0 then 'green' else 'red' end
    when abs(p_variance) / p_expected * 100 < 2 then 'green'
    when abs(p_variance) / p_expected * 100 <= 5 then 'yellow'
    else 'red'
  end;
$$;

-- p_lines: [{ "ingredient_id": "...", "counted_qty": 1250, "entered_text": "2 ถุง + 250 g", "note": "..." }] (หน่วยฐาน)
drop function if exists submit_stock_count(uuid, jsonb, text, text);
create function submit_stock_count(p_restaurant_id uuid, p_lines jsonb, p_note text default null, p_count_type text default 'spot')
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_name text;
  l record;
  v_items int := 0;
  v_diffs int := 0;
  v_value numeric := 0;
  v_counted numeric;
  v_from timestamptz;
  v_recv numeric;
  v_used numeric;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock']) then
    raise exception 'forbidden';
  end if;
  if coalesce(p_count_type, 'spot') not in ('daily', 'weekly', 'monthly', 'spot') then
    raise exception 'invalid_count_type';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'no_lines';
  end if;
  if jsonb_array_length(p_lines) > 1000 then
    raise exception 'too_many_lines';
  end if;
  if (select count(*) from jsonb_array_elements(p_lines) e)
     <> (select count(distinct e->>'ingredient_id') from jsonb_array_elements(p_lines) e) then
    raise exception 'duplicate_ingredient';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) e
    where not exists (select 1 from ingredients i where i.id = (e->>'ingredient_id')::uuid and i.restaurant_id = p_restaurant_id)
  ) then
    raise exception 'invalid_ingredient';
  end if;

  select coalesce(display_name, email) into v_name from app_users where id = auth.uid();
  insert into stock_counts (restaurant_id, counted_by, counted_by_name, note, count_type)
  values (p_restaurant_id, auth.uid(), v_name, nullif(left(trim(p_note), 300), ''), coalesce(p_count_type, 'spot'))
  returning id into v_id;

  for l in
    select i.id, i.name, i.unit, i.quantity_on_hand, i.cost_per_unit,
           (e->>'counted_qty')::numeric as counted, e->>'entered_text' as entered, e->>'note' as line_note
    from jsonb_array_elements(p_lines) e
    join ingredients i on i.id = (e->>'ingredient_id')::uuid and i.restaurant_id = p_restaurant_id
    order by i.id
    for update of i
  loop
    if l.counted is null or l.counted < 0 or l.counted > 100000000 then
      raise exception 'invalid_quantity';
    end if;
    v_counted := round(l.counted, 3);

    -- รอบนี้เริ่มจากการนับครั้งก่อนของวัตถุดิบนี้
    select max(c.created_at) into v_from
    from stock_count_lines cl join stock_counts c on c.id = cl.count_id
    where cl.ingredient_id = l.id and c.id <> v_id;
    select coalesce(sum(change) filter (where type = 'receive'), 0),
           coalesce(-sum(change) filter (where type in ('recipe_deduct', 'recipe_return')), 0)
      into v_recv, v_used
    from stock_movements
    where ingredient_id = l.id and (v_from is null or created_at > v_from);

    insert into stock_count_lines (count_id, ingredient_id, ingredient_name, unit, system_qty, counted_qty, diff, unit_cost,
                                   entered_text, opening_qty, received_qty, deducted_qty, note)
    values (v_id, l.id, l.name, l.unit, l.quantity_on_hand, v_counted, v_counted - l.quantity_on_hand, l.cost_per_unit,
            nullif(left(trim(l.entered), 100), ''), l.quantity_on_hand - v_recv + v_used, v_recv, v_used,
            nullif(left(trim(l.line_note), 200), ''));

    v_items := v_items + 1;
    if v_counted <> l.quantity_on_hand then
      v_diffs := v_diffs + 1;
      v_value := v_value + (v_counted - l.quantity_on_hand) * l.cost_per_unit;
      insert into stock_movements (restaurant_id, ingredient_id, change, type, note, count_id)
      values (p_restaurant_id, l.id, v_counted - l.quantity_on_hand, 'count_adjust', 'นับสต็อก', v_id);
    end if;
  end loop;

  update stock_counts set item_count = v_items, diff_count = v_diffs, diff_value = round(v_value, 2) where id = v_id;
  return v_id;
end;
$$;
revoke execute on function submit_stock_count(uuid, jsonb, text, text) from public, anon;
grant execute on function submit_stock_count(uuid, jsonb, text, text) to authenticated;

-- ผู้ตรวจรับรองใบนับ: เจ้าของ/ผู้จัดการ · ผู้จัดการรับรองใบที่ตัวเองนับไม่ได้ (เจ้าของทำได้ เผื่อร้านคนเดียว)
create or replace function verify_stock_count(p_count_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c stock_counts;
begin
  select * into c from stock_counts where id = p_count_id;
  if c.id is null or not has_role(c.restaurant_id, array['owner', 'manager']) then
    raise exception 'forbidden';
  end if;
  if c.verified_at is not null then
    raise exception 'already_verified';
  end if;
  if c.counted_by = auth.uid() and not has_role(c.restaurant_id, array['owner']) then
    raise exception 'cannot_verify_own_count';
  end if;
  update stock_counts
     set verified_by = auth.uid(), verified_at = now(),
         verified_by_name = (select coalesce(display_name, email) from app_users where id = auth.uid())
   where id = p_count_id;
end;
$$;
revoke execute on function verify_stock_count(uuid) from public, anon;
grant execute on function verify_stock_count(uuid) to authenticated;

-- ใบนับแบบ blind: ไม่มียอดในระบบ · เรียงตามตำแหน่งจัดเก็บ (shelf-to-sheet) · กรองคลาส ABC ได้
create or replace function stock_count_sheet(p_restaurant_id uuid, p_abc text[] default null)
returns table (ingredient_id uuid, name text, recipe_unit text, unit text, display_unit text, display_factor numeric,
               purchase_unit text, conversion_factor numeric, abc_class text, storage_location text, shelf_order int)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock']) then
    raise exception 'forbidden';
  end if;
  return query
  select i.id, i.name, i.recipe_unit, i.unit, i.display_unit, i.display_factor, i.purchase_unit, i.conversion_factor,
         i.abc_class, i.storage_location, i.shelf_order
  from ingredients i
  where i.restaurant_id = p_restaurant_id and i.is_active
    and (p_abc is null or cardinality(p_abc) = 0 or i.abc_class = any(p_abc))
  order by i.storage_location nulls last, i.shelf_order, i.name;
end;
$$;
revoke execute on function stock_count_sheet(uuid, text[]) from public, anon;
grant execute on function stock_count_sheet(uuid, text[]) to authenticated;

-- ติดลบต่อเนื่องกี่รอบ นับจากใบล่าสุดย้อนไป (ณ เวลา p_until) · >= 3 = สูตรหรือ yield อาจไม่ตรง
create or replace function stock_negative_streaks(p_restaurant_id uuid, p_until timestamptz default null)
returns table (ingredient_id uuid, streak int)
language sql stable security definer set search_path = public, pg_temp as $$
  with l as (
    select cl.ingredient_id, cl.diff,
           row_number() over (partition by cl.ingredient_id order by c.created_at desc, c.id) as rn
    from stock_count_lines cl join stock_counts c on c.id = cl.count_id
    where c.restaurant_id = p_restaurant_id and (p_until is null or c.created_at <= p_until)
  )
  select ingredient_id, (coalesce(min(rn) filter (where diff >= 0), max(rn) + 1) - 1)::int
  from l group by ingredient_id;
$$;
revoke execute on function stock_negative_streaks(uuid, timestamptz) from public, anon, authenticated;

-- ===== 4) รายงานส่วนต่างของใบนับ: เรียงตามมูลค่า แสดงหน่วย / บาท / % =====
drop function if exists stock_variance(uuid, uuid, uuid);
drop function if exists theoretical_usage(uuid, timestamptz, timestamptz);
create or replace function stock_variance_report(p_restaurant_id uuid, p_count_id uuid)
returns table (
  ingredient_id uuid, ingredient_name text, unit text, display_unit text, display_factor numeric, abc_class text,
  opening_qty numeric, received_qty numeric, deducted_qty numeric, expected_qty numeric, counted_qty numeric,
  variance_qty numeric, variance_value numeric, variance_pct numeric, color text, negative_streak int, recipe_alert boolean,
  note text, entered_text text
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_at timestamptz;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;
  select created_at into v_at from stock_counts where id = p_count_id and restaurant_id = p_restaurant_id;
  if v_at is null then
    raise exception 'invalid_count';
  end if;
  return query
  select cl.ingredient_id, cl.ingredient_name, cl.unit, i.display_unit, i.display_factor, i.abc_class,
         cl.opening_qty, cl.received_qty, cl.deducted_qty, cl.expected_qty, cl.counted_qty,
         cl.variance_qty, cl.variance_value, cl.variance_pct,
         stock_variance_color(cl.expected_qty, cl.variance_qty),
         coalesce(s.streak, 0), coalesce(s.streak, 0) >= 3,
         cl.note, cl.entered_text
  from stock_count_lines cl
  left join ingredients i on i.id = cl.ingredient_id
  left join stock_negative_streaks(p_restaurant_id, v_at) s on s.ingredient_id = cl.ingredient_id
  where cl.count_id = p_count_id
  order by abs(cl.variance_value) desc, cl.ingredient_name;
end;
$$;
revoke execute on function stock_variance_report(uuid, uuid) from public, anon;
grant execute on function stock_variance_report(uuid, uuid) to authenticated;

-- ===== 5) Yield test =====
create table if not exists yield_tests (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  ingredient_id uuid not null references ingredients(id) on delete cascade,
  kind text not null check (kind in ('trim', 'cook')),
  trials jsonb not null,                     -- [{ "before": 1000, "after": 620 }, ...] 3 ครั้ง (หน่วยฐาน)
  avg_pct numeric(6,2) not null check (avg_pct > 0),
  applied boolean not null default false,    -- นำค่าเฉลี่ยไปตั้งเป็น yield ของวัตถุดิบแล้ว
  note text check (char_length(note) <= 200),
  tested_by uuid references app_users(id) on delete set null,
  tested_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists yield_tests_ingredient_idx on yield_tests (ingredient_id, created_at desc);

-- ค่าเฉลี่ย = เฉลี่ยของ (หลัง ÷ ก่อน x 100) ทั้ง 3 ครั้ง (frontend/src/lib/stockMath.ts ใช้สูตรเดียวกัน)
create or replace function record_yield_test(
  p_restaurant_id uuid, p_ingredient_id uuid, p_kind text, p_trials jsonb, p_apply boolean default false, p_note text default null
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_avg numeric;
  v_id uuid;
  v_bad boolean;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock']) then
    raise exception 'forbidden';
  end if;
  if not exists (select 1 from ingredients where id = p_ingredient_id and restaurant_id = p_restaurant_id) then
    raise exception 'invalid_ingredient';
  end if;
  if p_kind not in ('trim', 'cook') then
    raise exception 'invalid_kind';
  end if;
  if p_trials is null or jsonb_typeof(p_trials) <> 'array' or jsonb_array_length(p_trials) <> 3 then
    raise exception 'three_trials_required';
  end if;
  select bool_or(
           (t->>'before')::numeric is null or (t->>'after')::numeric is null
           or (t->>'before')::numeric <= 0 or (t->>'after')::numeric <= 0
           or (p_kind = 'trim' and (t->>'after')::numeric > (t->>'before')::numeric)
           or (t->>'after')::numeric > (t->>'before')::numeric * 4),
         round(avg((t->>'after')::numeric / (t->>'before')::numeric * 100), 2)
    into v_bad, v_avg
  from jsonb_array_elements(p_trials) t;
  if v_bad then
    raise exception 'invalid_trial';
  end if;

  insert into yield_tests (restaurant_id, ingredient_id, kind, trials, avg_pct, applied, note, tested_by, tested_by_name)
  values (p_restaurant_id, p_ingredient_id, p_kind,
          (select jsonb_agg(jsonb_build_object('before', (t->>'before')::numeric, 'after', (t->>'after')::numeric)) from jsonb_array_elements(p_trials) t),
          v_avg, coalesce(p_apply, false), nullif(left(trim(p_note), 200), ''), auth.uid(),
          (select coalesce(display_name, email) from app_users where id = auth.uid()))
  returning id into v_id;

  -- นำไปใช้: ตั้ง yield ของวัตถุดิบ -> ต้นทุนสูตรที่เกี่ยวข้องคำนวณใหม่ (0028)
  if p_apply then
    if p_kind = 'trim' then
      update ingredients set trim_yield_pct = v_avg where id = p_ingredient_id;
    else
      update ingredients set cook_yield_pct = v_avg where id = p_ingredient_id;
    end if;
  end if;
  return jsonb_build_object('id', v_id, 'avg_pct', v_avg, 'applied', coalesce(p_apply, false));
end;
$$;
revoke execute on function record_yield_test(uuid, uuid, text, jsonb, boolean, text) from public, anon;
grant execute on function record_yield_test(uuid, uuid, text, jsonb, boolean, text) to authenticated;

-- ===== 6) Par และจำนวนแนะนำสั่ง =====
-- ใช้ต่อวัน = ของที่ออกจริงย้อนหลัง p_days วัน (ตัดตามสูตรสุทธิ + ส่วนต่างติดลบจากการนับ) ÷ p_days
-- รอบสั่ง = 7 ÷ จำนวนวันที่ผู้ขายมาส่งต่อสัปดาห์ · ไม่มีผู้ขาย: lead time 1 วัน รอบสั่ง 7 วัน
-- par_level ที่ตั้งเองมาก่อนค่าที่คำนวณ
create or replace function stock_reorder_suggestions(p_restaurant_id uuid, p_days int default 28)
returns table (
  ingredient_id uuid, name text, unit text, on_hand numeric, daily_usage numeric,
  lead_time_days int, cycle_days numeric, safety_stock numeric, par numeric, par_source text,
  suggested_qty numeric, purchase_unit text, conversion_factor numeric, suggested_purchase_qty numeric,
  supplier_id uuid, supplier_name text, order_today boolean, next_delivery date
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_days int := least(greatest(coalesce(p_days, 28), 1), 365);
  v_today date;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;
  select (now() at time zone timezone)::date into v_today from restaurants where id = p_restaurant_id;
  return query
  with usage as (
    select m.ingredient_id,
           coalesce(-sum(m.change) filter (where m.type in ('recipe_deduct', 'recipe_return')), 0)
           + coalesce(-sum(m.change) filter (where m.type = 'count_adjust' and m.change < 0 and m.reverses_id is null), 0) as used
    from stock_movements m
    where m.restaurant_id = p_restaurant_id and m.created_at >= now() - make_interval(days => v_days)
    group by m.ingredient_id
  ),
  base as (
    select i.*, s.id as sup_id, s.name as sup_name,
           coalesce(s.lead_time_days, 1) as lead,
           case when s.id is null then 7.0 else 7.0 / cardinality(s.delivery_days) end as cycle,
           coalesce(u.used, 0) / v_days as daily
    from ingredients i
    left join suppliers s on s.id = i.supplier_id
    left join usage u on u.ingredient_id = i.id
    where i.restaurant_id = p_restaurant_id and i.is_active
  ),
  calc as (
    select b.*, coalesce(b.par_level, round(b.daily * (b.lead + b.cycle) + b.safety_stock, 3)) as par_v
    from base b
  )
  select c.id, c.name, c.unit, c.quantity_on_hand, round(c.daily, 3), c.lead, round(c.cycle, 2), c.safety_stock,
         c.par_v, case when c.par_level is null then 'auto' else 'manual' end,
         greatest(round(c.par_v - c.quantity_on_hand, 3), 0),
         c.purchase_unit, c.conversion_factor,
         ceil(greatest(c.par_v - c.quantity_on_hand, 0) / c.conversion_factor),
         c.sup_id, c.sup_name,
         c.sup_id is null or exists (
           select 1 from suppliers s where s.id = c.sup_id
             and extract(dow from v_today + c.lead)::int = any(s.delivery_days)),
         (select v_today + c.lead + g from generate_series(0, 6) g, suppliers s
           where c.sup_id is not null and s.id = c.sup_id and extract(dow from v_today + c.lead + g)::int = any(s.delivery_days)
           order by g limit 1)
  from calc c
  order by greatest(c.par_v - c.quantity_on_hand, 0) * c.cost_per_unit desc, c.name;
end;
$$;
revoke execute on function stock_reorder_suggestions(uuid, int) from public, anon;
grant execute on function stock_reorder_suggestions(uuid, int) to authenticated;

-- ===== 7) ภาพรวม =====
create or replace function stock_overview(p_restaurant_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_today date;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;
  select (now() at time zone timezone)::date into v_today from restaurants where id = p_restaurant_id;
  return jsonb_build_object(
    'today', v_today,
    'stock_value', (select coalesce(round(sum(fifo_remaining * raw_unit_cost), 2), 0) from stock_lots where restaurant_id = p_restaurant_id),
    'ingredient_count', (select count(*) from ingredients where restaurant_id = p_restaurant_id and is_active),
    'out', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'unit', unit) order by name)
      from ingredients where restaurant_id = p_restaurant_id and is_active and quantity_on_hand <= 0), '[]'::jsonb),
    'low', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'unit', unit, 'on_hand', quantity_on_hand,
                                          'threshold', t, 'display_unit', display_unit, 'display_factor', display_factor)
                       order by quantity_on_hand / t, name)
      from (select *, case when reorder_level > 0 then reorder_level else safety_stock end as t
            from ingredients where restaurant_id = p_restaurant_id and is_active) x
      where t > 0 and quantity_on_hand > 0 and quantity_on_hand <= t), '[]'::jsonb),
    'expiring', coalesce((
      select jsonb_agg(jsonb_build_object('lot_id', l.id, 'ingredient_id', i.id, 'name', i.name, 'unit', i.unit,
                                          'qty', l.qty_remaining, 'expiry_date', l.expiry_date,
                                          'days_left', l.expiry_date - v_today,
                                          'value', round(l.qty_remaining * l.raw_unit_cost, 2))
                       order by l.expiry_date, i.name)
      from stock_lots l join ingredients i on i.id = l.ingredient_id
      where l.restaurant_id = p_restaurant_id and l.qty_remaining > 0 and l.expiry_date <= v_today + 3), '[]'::jsonb),
    'reorder_today', coalesce((
      select jsonb_agg(to_jsonb(s)) from stock_reorder_suggestions(p_restaurant_id) s
      where s.suggested_qty > 0 and s.order_today), '[]'::jsonb),
    'recipe_alerts', coalesce((
      select jsonb_agg(jsonb_build_object('ingredient_id', i.id, 'name', i.name, 'streak', s.streak) order by s.streak desc, i.name)
      from stock_negative_streaks(p_restaurant_id) s join ingredients i on i.id = s.ingredient_id
      where s.streak >= 3), '[]'::jsonb),
    'stock_disabled_menus', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name)
      from menu_items where restaurant_id = p_restaurant_id and stock_disabled), '[]'::jsonb),
    'last_count', (
      select jsonb_build_object('id', id, 'created_at', created_at, 'count_type', count_type,
                                'counted_by_name', counted_by_name, 'verified_at', verified_at, 'diff_value', diff_value)
      from stock_counts where restaurant_id = p_restaurant_id order by created_at desc limit 1)
  );
end;
$$;
revoke execute on function stock_overview(uuid) from public, anon;
grant execute on function stock_overview(uuid) to authenticated;

-- ===== 8) ประวัติ: กรองตามวัตถุดิบ วันที่ ผู้ทำรายการ ประเภท =====
drop function if exists stock_history(uuid, timestamptz, timestamptz, uuid, stock_reason, int);
create function stock_history(
  p_restaurant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_ingredient_id uuid default null,
  p_actor_id uuid default null,
  p_type text default null,
  p_limit int default 200
)
returns table (
  id uuid, created_at timestamptz, ingredient_id uuid, ingredient_name text, unit text,
  type text, change numeric, balance_after numeric, cost numeric, unit_cost numeric, note text,
  actor_id uuid, actor_name text, ref_id uuid, order_label text, reverses_id uuid, reversed_by uuid
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;
  return query
  select sm.id, sm.created_at, sm.ingredient_id, i.name, i.unit, sm.type, sm.change, sm.balance_after,
         sm.cost, sm.unit_cost, sm.note, sm.created_by, coalesce(u.display_name, u.email),
         sm.ref_id,
         case
           when o.id is null then null
           when o.order_type = 'takeaway' then coalesce('กลับบ้าน · ' || o.customer_label, 'กลับบ้าน')
           else coalesce(t.label, 'ไม่ระบุโต๊ะ')
         end,
         sm.reverses_id,
         (select x.id from stock_movements x where x.reverses_id = sm.id)
  from stock_movements sm
  join ingredients i on i.id = sm.ingredient_id
  left join app_users u on u.id = sm.created_by
  left join orders o on o.id = sm.order_id
  left join dining_tables t on t.id = o.table_id
  where sm.restaurant_id = p_restaurant_id
    and sm.created_at >= p_from and sm.created_at < p_to
    and (p_ingredient_id is null or sm.ingredient_id = p_ingredient_id)
    and (p_actor_id is null or sm.created_by = p_actor_id)
    and (p_type is null or sm.type = p_type)
  order by sm.created_at desc, sm.id
  limit least(greatest(p_limit, 1), 1000);
end;
$$;
revoke execute on function stock_history(uuid, timestamptz, timestamptz, uuid, uuid, text, int) from public, anon;
grant execute on function stock_history(uuid, timestamptz, timestamptz, uuid, uuid, text, int) to authenticated;

-- ===== 9) สูตร: บันทึกทั้งสูตรในธุรกรรมเดียว (หัวสูตร + แทนที่ทุกบรรทัด) =====
-- p_lines: [{ "ingredient_id": "..." } หรือ { "sub_recipe_id": "..." }, "qty": 120 }] · ปริมาณสุทธิ (หน่วยฐาน / หน่วยที่ได้ของสูตรย่อย)
create or replace function stock_save_recipe(
  p_restaurant_id uuid, p_id uuid, p_name text, p_menu_item_id uuid, p_output_qty numeric, p_output_unit text,
  p_lines jsonb, p_note text default null
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid := p_id;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock']) then
    raise exception 'forbidden';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 100 then
    raise exception 'invalid_lines';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) e
             where coalesce((e->>'qty')::numeric, 0) <= 0
                or num_nonnulls(e->>'ingredient_id', e->>'sub_recipe_id') <> 1) then
    raise exception 'invalid_lines';
  end if;
  if v_id is null then
    insert into recipes (restaurant_id, name, menu_item_id, output_qty, output_unit, note)
    values (p_restaurant_id, p_name, p_menu_item_id, p_output_qty, coalesce(nullif(trim(p_output_unit), ''), 'จาน'), nullif(left(trim(p_note), 300), ''))
    returning id into v_id;
  else
    update recipes set name = p_name, menu_item_id = p_menu_item_id, output_qty = p_output_qty,
                       output_unit = coalesce(nullif(trim(p_output_unit), ''), 'จาน'), note = nullif(left(trim(p_note), 300), '')
     where id = v_id and restaurant_id = p_restaurant_id;
    if not found then
      raise exception 'not_found';
    end if;
    delete from recipe_lines where recipe_id = v_id;
  end if;
  insert into recipe_lines (recipe_id, ingredient_id, sub_recipe_id, qty)
  select v_id, (e->>'ingredient_id')::uuid, (e->>'sub_recipe_id')::uuid, round((e->>'qty')::numeric, 3)
  from jsonb_array_elements(p_lines) e;
  perform recipes_recost('{}', array[v_id]);
  -- เมนูที่ผูก: สถานะพร้อมขายตามสต็อกใหม่
  perform stock_sync_menus(l.ingredient_id) from recipe_lines l where l.recipe_id = v_id and l.ingredient_id is not null;
  return v_id;
end;
$$;
revoke execute on function stock_save_recipe(uuid, uuid, text, uuid, numeric, text, jsonb, text) from public, anon;
grant execute on function stock_save_recipe(uuid, uuid, text, uuid, numeric, text, jsonb, text) to authenticated;

-- เมนูทั้งหมดของร้าน (รวมที่ปิดอยู่) สำหรับผูกสูตร · พนักงานสต็อกอ่าน menu_items ตรงได้เฉพาะที่เปิดขาย
create or replace function stock_menu_items(p_restaurant_id uuid)
returns table (id uuid, name text, is_available boolean, stock_disabled boolean, sold_by_weight boolean, recipe_id uuid)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;
  return query
  select m.id, m.name, m.is_available, m.stock_disabled, m.sold_by_weight, r.id
  from menu_items m left join recipes r on r.menu_item_id = m.id
  where m.restaurant_id = p_restaurant_id
  order by m.name;
end;
$$;
revoke execute on function stock_menu_items(uuid) from public, anon;
grant execute on function stock_menu_items(uuid) to authenticated;
