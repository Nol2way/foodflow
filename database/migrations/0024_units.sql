-- 0024: หน่วยนับ
--   - units: รายการหน่วยกลางของร้าน (kg, g, ลิตร, ตัว, ลัง ...) ใช้เป็นตัวเลือกตอนสร้างวัตถุดิบ เพิ่ม/ลบได้
--   - ingredient_units: หน่วยแปลงของแต่ละวัตถุดิบ เช่น กุ้ง 1 ลัง = 10 kg, 1 ถุง = 2 kg
--     ใช้ตอนรับของและตรวจนับ (กรอก 3 ลัง ระบบแปลงเป็น 30 kg) สต็อกยังเก็บเป็นหน่วยหลักหน่วยเดียว
--   - ใบรับของ/ใบตรวจนับ เก็บสิ่งที่กรอกจริงไว้ด้วย (เช่น "3 ลัง @ ฿400/ลัง", "2 ลัง + 3.5 kg") ย้อนตรวจได้

-- ===== 1) หน่วยกลางของร้าน =====
create table if not exists units (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 30),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists units_restaurant_name_key on units (restaurant_id, lower(trim(name)));

alter table units enable row level security;
drop policy if exists units_read on units;
create policy units_read on units for select
  using (has_role(restaurant_id, array['owner', 'manager', 'stock', 'accountant', 'kitchen']));
drop policy if exists units_write on units;
create policy units_write on units for all
  using (has_role(restaurant_id, array['owner', 'stock']))
  with check (has_role(restaurant_id, array['owner', 'stock']));

-- หน่วยเริ่มต้น: ร้านเดิมทุกร้าน + ร้านใหม่ (trigger)
create or replace function seed_default_units(p_restaurant_id uuid)
returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into units (restaurant_id, name, sort_order)
  select p_restaurant_id, u.name, u.ord
  from unnest(array['kg', 'g', 'ลิตร', 'ml', 'ตัว', 'ชิ้น', 'แพ็ค', 'ถุง', 'กล่อง', 'ลัง', 'ขวด', 'กระป๋อง']) with ordinality as u(name, ord)
  on conflict do nothing;
$$;
revoke execute on function seed_default_units(uuid) from public, anon, authenticated;

select seed_default_units(id) from restaurants;
-- หน่วยที่วัตถุดิบเดิมใช้อยู่แต่ไม่อยู่ในรายการ
insert into units (restaurant_id, name, sort_order)
select distinct restaurant_id, trim(unit), 100 from ingredients
on conflict do nothing;

create or replace function restaurants_seed_units()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform seed_default_units(new.id);
  return new;
end;
$$;
drop trigger if exists restaurants_seed_units on restaurants;
create trigger restaurants_seed_units after insert on restaurants
  for each row execute function restaurants_seed_units();

-- ===== 2) หน่วยแปลงต่อวัตถุดิบ: 1 [unit_name] = factor [หน่วยหลักของวัตถุดิบ] =====
create table if not exists ingredient_units (
  ingredient_id uuid not null references ingredients(id) on delete cascade,
  unit_name text not null check (char_length(trim(unit_name)) between 1 and 30),
  factor numeric(14,4) not null check (factor > 0 and factor <= 1000000),
  primary key (ingredient_id, unit_name)
);

alter table ingredient_units enable row level security;
drop policy if exists ingredient_units_read on ingredient_units;
create policy ingredient_units_read on ingredient_units for select
  using (exists (
    select 1 from ingredients i
    where i.id = ingredient_id and has_role(i.restaurant_id, array['owner', 'stock', 'accountant', 'kitchen'])
  ));
drop policy if exists ingredient_units_write on ingredient_units;
create policy ingredient_units_write on ingredient_units for all
  using (exists (select 1 from ingredients i where i.id = ingredient_id and has_role(i.restaurant_id, array['owner', 'stock'])))
  with check (exists (
    select 1 from ingredients i
    where i.id = ingredient_id and has_role(i.restaurant_id, array['owner', 'stock']) and lower(trim(i.unit)) <> lower(trim(unit_name))
  ));

-- ===== 3) เก็บสิ่งที่กรอกจริงในเอกสาร =====
alter table stock_receipt_lines add column if not exists entered_unit text;           -- null = กรอกเป็นหน่วยหลัก
alter table stock_receipt_lines add column if not exists entered_qty numeric(12,3);
alter table stock_receipt_lines add column if not exists entered_unit_cost numeric(12,4);
alter table stock_count_lines add column if not exists entered_text text;             -- เช่น "2 ลัง + 3.5 kg"

-- หน้าเว็บแปลงเป็นหน่วยหลักแล้วส่ง quantity / unit_cost / counted_qty มา ฟังก์ชันเก็บค่าที่กรอกไว้คู่กัน

create or replace function submit_stock_receipt(
  p_restaurant_id uuid,
  p_lines jsonb,
  p_supplier text default null,
  p_invoice_no text default null,
  p_received_on date default null,
  p_note text default null,
  p_record_expense boolean default true
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_name text;
  l record;
  v_total numeric := 0;
  v_items int := 0;
  v_expense uuid;
  v_label text;
begin
  if not has_role(p_restaurant_id, array['owner', 'stock']) then
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
  if p_received_on is not null and p_received_on > current_date + 1 then
    raise exception 'invalid_date';
  end if;

  select coalesce(display_name, email) into v_name from app_users where id = auth.uid();
  insert into stock_receipts (restaurant_id, supplier, invoice_no, received_on, note, received_by, received_by_name)
  values (p_restaurant_id, nullif(left(trim(p_supplier), 100), ''), nullif(left(trim(p_invoice_no), 50), ''),
          coalesce(p_received_on, current_date), nullif(left(trim(p_note), 300), ''), auth.uid(), v_name)
  returning id into v_id;
  v_label := 'รับของ' || coalesce(' ' || nullif(trim(p_supplier), ''), '') || coalesce(' บิล ' || nullif(trim(p_invoice_no), ''), '');

  for l in
    select i.id, i.name, i.unit, i.quantity_on_hand, i.cost_per_unit,
           (e->>'quantity')::numeric as qty, (e->>'unit_cost')::numeric as cost,
           nullif(left(trim(e->>'entered_unit'), 30), '') as e_unit,
           (e->>'entered_qty')::numeric as e_qty, (e->>'entered_unit_cost')::numeric as e_cost
    from jsonb_array_elements(p_lines) e
    join ingredients i on i.id = (e->>'ingredient_id')::uuid and i.restaurant_id = p_restaurant_id
    order by i.name
    for update of i
  loop
    if l.qty is null or l.qty <= 0 or l.qty > 1000000 then raise exception 'invalid_quantity'; end if;
    if l.cost is null or l.cost < 0 then raise exception 'invalid_cost'; end if;

    insert into stock_receipt_lines (receipt_id, ingredient_id, ingredient_name, unit, quantity, unit_cost, line_total,
                                     entered_unit, entered_qty, entered_unit_cost)
    values (v_id, l.id, l.name, l.unit, round(l.qty, 3), round(l.cost, 4), round(l.qty * l.cost, 2),
            case when l.e_unit is not null and l.e_unit <> l.unit then l.e_unit end,
            case when l.e_unit is not null and l.e_unit <> l.unit then round(l.e_qty, 3) end,
            case when l.e_unit is not null and l.e_unit <> l.unit then round(l.e_cost, 4) end);

    update ingredients
       set cost_per_unit = round((l.quantity_on_hand * l.cost_per_unit + l.qty * l.cost) / (l.quantity_on_hand + l.qty), 4)
     where id = l.id;

    insert into stock_movements (restaurant_id, ingredient_id, change, reason, note, receipt_id)
    values (p_restaurant_id, l.id, round(l.qty, 3), 'purchase', v_label, v_id);

    v_total := v_total + round(l.qty * l.cost, 2);
    v_items := v_items + 1;
  end loop;

  if p_record_expense and v_total > 0 then
    insert into expenses (restaurant_id, category, amount, spent_on, note)
    values (p_restaurant_id, 'ingredients', v_total, coalesce(p_received_on, current_date), left(v_label, 200))
    returning id into v_expense;
  end if;

  update stock_receipts set item_count = v_items, total_cost = v_total, expense_id = v_expense where id = v_id;
  return v_id;
end;
$$;

create or replace function submit_stock_count(p_restaurant_id uuid, p_lines jsonb, p_note text default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_name text;
  l record;
  v_items int := 0;
  v_diffs int := 0;
  v_value numeric := 0;
begin
  if not has_role(p_restaurant_id, array['owner', 'stock']) then
    raise exception 'forbidden';
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
    where not exists (
      select 1 from ingredients i where i.id = (e->>'ingredient_id')::uuid and i.restaurant_id = p_restaurant_id
    )
  ) then
    raise exception 'invalid_ingredient';
  end if;

  select coalesce(display_name, email) into v_name from app_users where id = auth.uid();
  insert into stock_counts (restaurant_id, counted_by, counted_by_name, note)
  values (p_restaurant_id, auth.uid(), v_name, nullif(left(trim(p_note), 300), ''))
  returning id into v_id;

  for l in
    select i.id, i.name, i.unit, i.quantity_on_hand, i.cost_per_unit, (e->>'counted_qty')::numeric as counted, e->>'entered_text' as entered
    from jsonb_array_elements(p_lines) e
    join ingredients i on i.id = (e->>'ingredient_id')::uuid and i.restaurant_id = p_restaurant_id
    order by i.name
    for update of i
  loop
    if l.counted is null or l.counted < 0 then
      raise exception 'invalid_quantity';
    end if;

    insert into stock_count_lines (count_id, ingredient_id, ingredient_name, unit, system_qty, counted_qty, diff, unit_cost, entered_text)
    values (v_id, l.id, l.name, l.unit, l.quantity_on_hand, round(l.counted, 3), round(l.counted, 3) - l.quantity_on_hand, l.cost_per_unit,
            nullif(left(trim(l.entered), 100), ''));

    v_items := v_items + 1;
    if round(l.counted, 3) <> l.quantity_on_hand then
      v_diffs := v_diffs + 1;
      v_value := v_value + (round(l.counted, 3) - l.quantity_on_hand) * l.cost_per_unit;
      insert into stock_movements (restaurant_id, ingredient_id, change, reason, note, count_id)
      values (p_restaurant_id, l.id, round(l.counted, 3) - l.quantity_on_hand, 'adjustment', 'ตรวจนับสต็อก', v_id);
    end if;
  end loop;

  update stock_counts set item_count = v_items, diff_count = v_diffs, diff_value = round(v_value, 2) where id = v_id;
  return v_id;
end;
$$;
