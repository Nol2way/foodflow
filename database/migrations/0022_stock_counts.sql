-- 0022: ใบตรวจนับสต็อก
--   - นับของจริงทีละรายการ เทียบกับยอดในระบบ ระบบปรับยอดให้ (stock_movements reason = adjustment)
--   - เก็บเป็นเอกสาร: ใครนับ เมื่อไหร่ ยอดระบบตอนนับ ยอดนับจริง ส่วนต่าง มูลค่าส่วนต่าง
--   - บันทึกผ่าน submit_stock_count() เท่านั้น (ทั้งใบเป็นธุรกรรมเดียว) แก้/ลบใบที่บันทึกแล้วไม่ได้

-- ===== 1) ตาราง =====
create table if not exists stock_counts (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  counted_by uuid references app_users(id) on delete set null,
  counted_by_name text,                                  -- ชื่อตอนนับ (เก็บไว้แม้ภายหลังลบบัญชี)
  note text check (char_length(note) <= 300),
  item_count int not null default 0,                     -- จำนวนรายการที่นับ
  diff_count int not null default 0,                     -- จำนวนรายการที่ยอดไม่ตรง
  diff_value numeric(12,2) not null default 0,           -- มูลค่าส่วนต่างรวม (ติดลบ = ของขาด)
  created_at timestamptz not null default now()
);
create index if not exists stock_counts_restaurant_idx on stock_counts (restaurant_id, created_at desc);

create table if not exists stock_count_lines (
  count_id uuid not null references stock_counts(id) on delete cascade,
  ingredient_id uuid not null references ingredients(id) on delete cascade,
  ingredient_name text not null,                         -- ชื่อ/หน่วย/ต้นทุน ณ ตอนนับ
  unit text not null,
  system_qty numeric(12,3) not null,
  counted_qty numeric(12,3) not null check (counted_qty >= 0),
  diff numeric(12,3) not null,
  unit_cost numeric(12,4) not null default 0,
  primary key (count_id, ingredient_id)
);

alter table stock_movements add column if not exists count_id uuid references stock_counts(id) on delete set null;

-- ===== 2) สิทธิ์: อ่านได้ เจ้าของ สต็อก บัญชี · เขียนตรงไม่ได้ =====
alter table stock_counts enable row level security;
alter table stock_count_lines enable row level security;

drop policy if exists stock_counts_read on stock_counts;
create policy stock_counts_read on stock_counts for select
  using (has_role(restaurant_id, array['owner', 'stock', 'accountant']));

drop policy if exists stock_count_lines_read on stock_count_lines;
create policy stock_count_lines_read on stock_count_lines for select
  using (exists (
    select 1 from stock_counts c
    where c.id = count_id and has_role(c.restaurant_id, array['owner', 'stock', 'accountant'])
  ));

revoke insert, update, delete on stock_counts, stock_count_lines from anon, authenticated;

-- ===== 3) บันทึกใบตรวจนับ =====
-- p_lines: [{ "ingredient_id": "...", "counted_qty": 12.5 }, ...] เฉพาะรายการที่นับ
-- ยอดระบบอ่านตอนบันทึก (ล็อกแถวไว้) ไม่เชื่อตัวเลขจากหน้าเว็บ
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
    select i.id, i.name, i.unit, i.quantity_on_hand, i.cost_per_unit, (e->>'counted_qty')::numeric as counted
    from jsonb_array_elements(p_lines) e
    join ingredients i on i.id = (e->>'ingredient_id')::uuid and i.restaurant_id = p_restaurant_id
    order by i.name
    for update of i
  loop
    if l.counted is null or l.counted < 0 then
      raise exception 'invalid_quantity';
    end if;

    insert into stock_count_lines (count_id, ingredient_id, ingredient_name, unit, system_qty, counted_qty, diff, unit_cost)
    values (v_id, l.id, l.name, l.unit, l.quantity_on_hand, round(l.counted, 3), round(l.counted, 3) - l.quantity_on_hand, l.cost_per_unit);

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

revoke execute on function submit_stock_count(uuid, jsonb, text) from public, anon;
grant execute on function submit_stock_count(uuid, jsonb, text) to authenticated;
