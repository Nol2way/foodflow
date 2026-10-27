-- 0028: สูตรอาหารแบบใหม่ + ตัด/คืนสต็อกตามออเดอร์ (โมดูลสต็อกวัตถุดิบ ตอนที่ 2/4)
--   - recipes + recipe_lines: สูตรมี output_qty (ทำ 1 ครั้งได้เท่าไร) · บรรทัดเป็นวัตถุดิบ หรือสูตรย่อย (สูตรซ้อน) ก็ได้
--     สูตรของเมนู = ผูก menu_item_id (output = จำนวนที่เสิร์ฟ) · สูตรย่อย = ไม่ผูกเมนู เช่น น้ำจิ้ม 1 หม้อ = 5000 ml
--     ปริมาณในบรรทัด = ปริมาณสุทธิที่ใช้จริง (หลังตัดแต่ง/สุก) · ระบบตัดดิบ = สุทธิ ÷ (trim yield x cook yield)
--   - ต้นทุนต่อหน่วยวัตถุดิบ = ราคาซื้อล่าสุด ÷ (trim x cook) · ราคาเปลี่ยน -> คำนวณต้นทุนทุกสูตรที่ใช้ใหม่ รวมสูตรแม่
--   - ตัดสต็อกเมื่อครัวกด "เริ่มทำ" · ยกเลิกออเดอร์ = คืนสต็อกอัตโนมัติ (คืนลงล็อตเดิม)
--   - สต็อกไม่พอ: ตัดไม่ได้ (ไม่ติดลบ) และเมนูที่ทำไม่ได้แล้วปิดอัตโนมัติ · ของกลับมาพอ = เปิดให้อัตโนมัติ
--   - ของเตรียมแบบเดิม (prep_components + ผลิตทีละถัง) ย้ายเป็นสูตรย่อย · สูตรเดิม (recipes) เก็บไว้ที่ legacy_menu_recipes

-- ===== 1) เก็บสูตรเดิม =====
alter table recipes rename to legacy_menu_recipes;
alter index if exists recipes_pkey rename to legacy_menu_recipes_pkey;
drop policy if exists recipes_write on legacy_menu_recipes;
revoke insert, update, delete on legacy_menu_recipes from anon, authenticated;

-- ===== 2) ตารางสูตร =====
create table recipes (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 100),
  menu_item_id uuid unique references menu_items(id) on delete cascade,   -- ว่าง = สูตรย่อย
  output_qty numeric(14,3) not null default 1 check (output_qty > 0),
  output_unit text not null default 'จาน' check (char_length(output_unit) between 1 and 20),
  cost_per_output numeric(16,7) not null default 0,                         -- ต้นทุนต่อ 1 หน่วยที่ได้ (คำนวณให้)
  cost_updated_at timestamptz,
  note text check (char_length(note) <= 300),
  created_at timestamptz not null default now()
);
create index recipes_restaurant_idx on recipes (restaurant_id);

create table recipe_lines (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references recipes(id) on delete cascade,
  ingredient_id uuid references ingredients(id) on delete restrict,
  sub_recipe_id uuid references recipes(id) on delete restrict,
  qty numeric(14,3) not null check (qty > 0),     -- หน่วยฐานของวัตถุดิบ (สุทธิ) หรือหน่วยที่ได้ของสูตรย่อย
  check (num_nonnulls(ingredient_id, sub_recipe_id) = 1),
  check (sub_recipe_id is distinct from recipe_id)
);
create unique index recipe_lines_ingredient_key on recipe_lines (recipe_id, ingredient_id) where ingredient_id is not null;
create unique index recipe_lines_sub_key on recipe_lines (recipe_id, sub_recipe_id) where sub_recipe_id is not null;
create index recipe_lines_ingredient_idx on recipe_lines (ingredient_id) where ingredient_id is not null;
create index recipe_lines_sub_idx on recipe_lines (sub_recipe_id) where sub_recipe_id is not null;

-- บรรทัดต้องเป็นของร้านเดียวกัน · สูตรย่อยต้องไม่ผูกเมนู · ห้ามวนกลับมาที่ตัวเอง (ทางตรง/ทางอ้อม)
create or replace function recipe_lines_check()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rid uuid;
begin
  select restaurant_id into v_rid from recipes where id = new.recipe_id;
  if new.ingredient_id is not null
     and not exists (select 1 from ingredients where id = new.ingredient_id and restaurant_id = v_rid) then
    raise exception 'invalid_ingredient';
  end if;
  if new.sub_recipe_id is not null then
    if not exists (select 1 from recipes where id = new.sub_recipe_id and restaurant_id = v_rid and menu_item_id is null) then
      raise exception 'invalid_sub_recipe';
    end if;
    if exists (
      with recursive d(id, depth) as (
        select new.sub_recipe_id, 1
        union all
        select l.sub_recipe_id, d.depth + 1 from recipe_lines l join d on l.recipe_id = d.id
        where l.sub_recipe_id is not null and d.depth < 20
      )
      select 1 from d where d.id = new.recipe_id
    ) then
      raise exception 'recipe_cycle';
    end if;
  end if;
  return new;
end;
$$;
create trigger recipe_lines_check before insert or update on recipe_lines
  for each row execute function recipe_lines_check();

-- สูตรที่เป็นสูตรย่อยของสูตรอื่นอยู่ ผูกเมนูไม่ได้ · ร้านของเมนูต้องตรงกับร้านของสูตร
create or replace function recipes_check()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.menu_item_id is not null then
    if not exists (select 1 from menu_items where id = new.menu_item_id and restaurant_id = new.restaurant_id) then
      raise exception 'invalid_menu_item';
    end if;
    if tg_op = 'UPDATE' and exists (select 1 from recipe_lines where sub_recipe_id = new.id) then
      raise exception 'sub_recipe_in_use';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.restaurant_id <> old.restaurant_id then
    raise exception 'invalid_restaurant';
  end if;
  new.name := trim(new.name);
  return new;
end;
$$;
create trigger recipes_check before insert or update on recipes
  for each row execute function recipes_check();

-- ===== 3) แตกสูตรเป็นวัตถุดิบ =====
-- p_units = จำนวนหน่วยที่ได้ของสูตรนี้ที่ต้องการ (เมนู: จำนวนจาน) · คืนปริมาณสุทธิ และดิบ (หาร yield)
create or replace function recipe_expand(p_recipe_id uuid, p_units numeric)
returns table (ingredient_id uuid, net_qty numeric, raw_qty numeric)
language sql stable security invoker set search_path = public, pg_temp as $$
  with recursive x(recipe_id, units, depth) as (
    select p_recipe_id, p_units, 0
    union all
    select l.sub_recipe_id, x.units * l.qty / r.output_qty, x.depth + 1
    from x
    join recipes r on r.id = x.recipe_id
    join recipe_lines l on l.recipe_id = x.recipe_id and l.sub_recipe_id is not null
    where x.depth < 20
  )
  select l.ingredient_id,
         sum(x.units * l.qty / r.output_qty),
         sum(x.units * l.qty / r.output_qty * 10000 / (i.trim_yield_pct * i.cook_yield_pct))
  from x
  join recipes r on r.id = x.recipe_id
  join recipe_lines l on l.recipe_id = x.recipe_id and l.ingredient_id is not null
  join ingredients i on i.id = l.ingredient_id
  group by l.ingredient_id;
$$;

-- ต้นทุนต่อ 1 หน่วยที่ได้: Σ ดิบ x ราคาซื้อล่าสุด (= สุทธิ x ราคา ÷ (trim x cook)) ÷ output
create or replace function recipe_unit_cost(p_recipe_id uuid)
returns numeric
language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(sum(e.raw_qty * coalesce(i.last_unit_cost, i.cost_per_unit)), 0) / r.output_qty
  from recipes r
  left join lateral recipe_expand(r.id, r.output_qty) e on true
  left join ingredients i on i.id = e.ingredient_id
  where r.id = p_recipe_id
  group by r.output_qty;
$$;

-- คำนวณต้นทุนใหม่ให้สูตรที่ใช้วัตถุดิบ/สูตรเหล่านี้ และสูตรแม่ทุกชั้น · คืนจำนวนสูตรที่คำนวณ
create or replace function recipes_recost(p_ingredient_ids uuid[], p_recipe_ids uuid[] default '{}')
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  n int;
begin
  with recursive up(id, depth) as (
    select s.id, 0 from (
      select recipe_id as id from recipe_lines where ingredient_id = any(coalesce(p_ingredient_ids, '{}'))
      union
      select unnest(coalesce(p_recipe_ids, '{}'))
    ) s
    union all
    select l.recipe_id, up.depth + 1 from recipe_lines l join up on l.sub_recipe_id = up.id where up.depth < 20
  )
  update recipes r set cost_per_output = round(coalesce(recipe_unit_cost(r.id), 0), 7), cost_updated_at = now()
  where r.id in (select id from up);
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function recipe_lines_recost()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform recipes_recost('{}', array[coalesce(new.recipe_id, old.recipe_id)]);
  return null;
end;
$$;
create trigger recipe_lines_recost after insert or update or delete on recipe_lines
  for each row execute function recipe_lines_recost();

create or replace function recipes_output_recost()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform recipes_recost('{}', array[new.id]);
  return null;
end;
$$;
create trigger recipes_output_recost after insert or update of output_qty on recipes
  for each row execute function recipes_output_recost();

-- ราคาซื้อล่าสุด / yield ของวัตถุดิบเปลี่ยน -> ต้นทุนทุกสูตรที่เกี่ยวข้อง
create or replace function ingredients_recost()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (new.last_unit_cost, new.trim_yield_pct, new.cook_yield_pct)
     is distinct from (old.last_unit_cost, old.trim_yield_pct, old.cook_yield_pct) then
    perform recipes_recost(array[new.id]);
  end if;
  return null;
end;
$$;
create trigger ingredients_recost after update of last_unit_cost, trim_yield_pct, cook_yield_pct on ingredients
  for each row execute function ingredients_recost();

-- ===== 4) ย้ายสูตรเดิม =====
-- ของเตรียมที่มีส่วนผสม -> สูตรย่อย (output = ผลิต 1 ถังได้)
create temp table prep_map on commit drop as
select gen_random_uuid() as recipe_id, p.id as prep_id, p.restaurant_id, p.name, p.batch_output_qty, p.unit
from ingredients p
where p.is_prep and p.batch_output_qty is not null and exists (select 1 from prep_components c where c.prep_id = p.id);

alter table recipe_lines disable trigger recipe_lines_recost;
alter table recipes disable trigger recipes_output_recost;

insert into recipes (id, restaurant_id, name, output_qty, output_unit, note)
select recipe_id, restaurant_id, left(name, 100), batch_output_qty, left(unit, 20), 'ย้ายจากของเตรียมเดิม' from prep_map;

insert into recipe_lines (recipe_id, ingredient_id, sub_recipe_id, qty)
select m.recipe_id, case when sub.recipe_id is null then c.ingredient_id end, sub.recipe_id, c.quantity
from prep_map m
join prep_components c on c.prep_id = m.prep_id
left join prep_map sub on sub.prep_id = c.ingredient_id;

-- สูตรเมนูเดิม -> 1 สูตรต่อเมนู (output 1 จาน) · วัตถุดิบที่เป็นของเตรียม -> บรรทัดสูตรย่อย
insert into recipes (restaurant_id, name, menu_item_id, output_qty, output_unit)
select m.restaurant_id, left(m.name, 100), m.id, 1, 'จาน'
from menu_items m where exists (select 1 from legacy_menu_recipes r where r.menu_item_id = m.id);

insert into recipe_lines (recipe_id, ingredient_id, sub_recipe_id, qty)
select rc.id, case when pm.recipe_id is null then lr.ingredient_id end, pm.recipe_id, lr.quantity_used
from legacy_menu_recipes lr
join recipes rc on rc.menu_item_id = lr.menu_item_id
left join prep_map pm on pm.prep_id = lr.ingredient_id;

alter table recipe_lines enable trigger recipe_lines_recost;
alter table recipes enable trigger recipes_output_recost;
select recipes_recost('{}', coalesce(array_agg(id), '{}')) from recipes;

-- ผลิตของเตรียมแยกไม่มีแล้ว (ใช้สูตรย่อย: ตัดวัตถุดิบดิบตอนขาย)
drop policy if exists prep_components_write on prep_components;
revoke insert, update, delete on prep_components from anon, authenticated;
create or replace function produce_prep(p_prep_id uuid, p_output_qty numeric, p_note text default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  raise exception 'prep_production_removed';
end;
$$;

-- ===== 5) ต้นทุนต่อเมนู =====
create view menu_item_costs with (security_invoker = true) as
select m.id as menu_item_id,
       m.restaurant_id,
       m.name,
       m.price,
       coalesce(r.cost_per_output, 0)::numeric(12,2) as unit_cost,
       (select count(*) from recipe_lines l where l.recipe_id = r.id) as ingredient_count
from menu_items m
left join recipes r on r.menu_item_id = m.id;
grant select on menu_item_costs to authenticated;

-- กำไรขั้นต้นต่อเมนู (เหมือน 0026 แต่ต้นทุนจากสูตรแบบใหม่)
create or replace function acct_menu_profit(p_restaurant_id uuid, p_from date, p_to date)
returns table (menu_item_id uuid, name text, quantity numeric, revenue numeric, cost numeric, gross_profit numeric, has_recipe boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_tz text;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'accountant']) then
    raise exception 'forbidden';
  end if;
  select timezone into v_tz from restaurants where id = p_restaurant_id;
  return query
  with c as (
    select m.id, coalesce(r.cost_per_output, 0) as unit_cost, r.id is not null as has_recipe
    from menu_items m
    left join recipes r on r.menu_item_id = m.id
    where m.restaurant_id = p_restaurant_id
  ), s as (
    select m.id, m.name,
           sum(case when m.sold_by_weight then coalesce(oi.weight_g, 0) / 1000 else oi.quantity end) as qty,
           sum(oi.quantity * oi.unit_price) as rev,
           sum(case
                 when m.sold_by_weight and wi.id is not null
                   then coalesce(oi.weight_g, 0) * coalesce(grams_to_unit(wi.unit), 0) * coalesce(wi.last_unit_cost, wi.cost_per_unit)
                        + c.unit_cost * oi.quantity
                 else c.unit_cost * oi.quantity
               end) as cost,
           bool_or(c.has_recipe or wi.id is not null) as has_recipe
    from order_items oi
    join orders o on o.id = oi.order_id
    join menu_items m on m.id = oi.menu_item_id
    join c on c.id = m.id
    left join ingredients wi on wi.id = m.weight_ingredient_id
    where o.restaurant_id = p_restaurant_id and o.status = 'paid'
      and (o.paid_at at time zone v_tz)::date between p_from and p_to
    group by m.id, m.name
  )
  select s.id, s.name, round(s.qty, 3), round(s.rev, 2), round(s.cost, 2), round(s.rev - s.cost, 2), s.has_recipe
  from s
  order by s.rev - s.cost desc, s.name;
end;
$$;

-- ===== 6) ตัด/คืนสต็อกตามออเดอร์ =====
alter table orders add column if not exists stock_returned_at timestamptz;

-- วัตถุดิบดิบที่ออเดอร์ต้องใช้: สูตร (แตกสูตรย่อย) + น้ำหนักจริงของของชั่งขาย (ไม่หาร yield เพราะขายทั้งตัว)
create or replace function order_ingredient_need(p_order_id uuid, p_restaurant_id uuid)
returns table (ingredient_id uuid, qty numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  select x.ingredient_id, sum(x.qty) from (
    select e.ingredient_id, e.raw_qty as qty
    from order_items oi
    join recipes r on r.menu_item_id = oi.menu_item_id and r.restaurant_id = p_restaurant_id
    cross join lateral recipe_expand(r.id, oi.quantity::numeric) e
    where oi.order_id = p_order_id
    union all
    select m.weight_ingredient_id, oi.weight_g * grams_to_unit(i.unit)
    from order_items oi
    join menu_items m on m.id = oi.menu_item_id and m.sold_by_weight
    join ingredients i on i.id = m.weight_ingredient_id and i.restaurant_id = p_restaurant_id
    where oi.order_id = p_order_id and oi.weight_g is not null and grams_to_unit(i.unit) is not null
  ) x
  group by x.ingredient_id;
$$;

-- ครัวกด "เริ่มทำ" (ครั้งแรกที่ออกจาก received): ตัดตามสูตร · ไม่พอ = เริ่มทำไม่ได้ (insufficient_stock: ชื่อวัตถุดิบ)
-- ยกเลิกหลังตัดแล้ว: คืนทุกรายการตัดของออเดอร์นี้ (กลับรายการ ลงล็อตเดิม)
create or replace function deduct_stock_for_order()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.stock_deducted_at is null
     and new.status in ('preparing', 'ready', 'served', 'paid') then
    insert into stock_movements (restaurant_id, ingredient_id, change, type, order_id, note)
    select new.restaurant_id, n.ingredient_id, -round(n.qty, 3), 'recipe_deduct', new.id, 'ตัดตามสูตร'
    from order_ingredient_need(new.id, new.restaurant_id) n
    where round(n.qty, 3) > 0
    order by n.ingredient_id;
    new.stock_deducted_at := now();
  end if;

  if new.status = 'cancelled' and old.status is distinct from 'cancelled'
     and new.stock_deducted_at is not null and new.stock_returned_at is null then
    insert into stock_movements (restaurant_id, ingredient_id, change, type, order_id, reverses_id, note)
    select m.restaurant_id, m.ingredient_id, -m.change, 'recipe_return', new.id, m.id, 'คืนสต็อก: ยกเลิกออเดอร์'
    from stock_movements m
    where m.order_id = new.id and m.type = 'recipe_deduct'
      and not exists (select 1 from stock_movements x where x.reverses_id = m.id)
    order by m.ingredient_id;
    new.stock_returned_at := now();
  end if;
  return new;
end;
$$;

-- บัญชีของออเดอร์ (เหมือน 0026) ยกเว้นตอนยกเลิก: สต็อกถูกคืนแล้ว รายการคืนสต็อกกลับต้นทุนขายให้เอง
-- จึงไม่ต้องย้ายต้นทุนขายไปส่วนต่างสต็อกอีก
create or replace function orders_accounting()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bill uuid;
begin
  if new.import_batch is not null or new.is_demo then
    return null;
  end if;

  if new.status = 'paid' and old.status <> 'paid' then
    perform acct_post_bill(new);
  end if;

  if new.status = 'cancelled' and old.status <> 'cancelled' and old.status = 'paid' then
    select id into v_bill from journal_entries
    where restaurant_id = new.restaurant_id and source_type = 'bill' and source_id = new.id
      and not exists (select 1 from journal_entries x where x.reverses_entry_id = journal_entries.id)
    limit 1;
    if v_bill is not null then
      perform acct_reverse_internal(v_bill, coalesce(new.cancel_reason, 'ยกเลิกบิล'));
    end if;
  end if;
  return null;
end;
$$;

-- ===== 7) ปิด/เปิดเมนูตามสต็อก =====
-- stock_disabled = ระบบปิดให้เพราะของไม่พอ (เปิดคืนเองเมื่อของพอ) · ปิดเองด้วยมือ ระบบไม่ไปเปิดให้
alter table menu_items add column if not exists stock_disabled boolean not null default false;

-- เมนูทำได้อย่างน้อย 1 ที่ไหม (ทุกวัตถุดิบดิบตามสูตรต้องพอ · ขายตามน้ำหนักต้องมีของเหลือ)
create or replace function menu_item_in_stock(p_menu_item_id uuid)
returns boolean
language sql stable security invoker set search_path = public, pg_temp as $$
  select not exists (
           select 1 from recipes r
           cross join lateral recipe_expand(r.id, 1) e
           join ingredients i on i.id = e.ingredient_id
           where r.menu_item_id = p_menu_item_id and round(e.raw_qty, 3) > i.quantity_on_hand
         )
     and not exists (
           select 1 from menu_items m join ingredients wi on wi.id = m.weight_ingredient_id
           where m.id = p_menu_item_id and m.sold_by_weight and wi.quantity_on_hand <= 0
         );
$$;

create or replace function stock_sync_menus(p_ingredient_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  with recursive up(recipe_id, depth) as (
    select recipe_id, 0 from recipe_lines where ingredient_id = p_ingredient_id
    union all
    select l.recipe_id, up.depth + 1 from recipe_lines l join up on l.sub_recipe_id = up.recipe_id where up.depth < 20
  ),
  menus as (
    select r.menu_item_id as id from recipes r join up on up.recipe_id = r.id where r.menu_item_id is not null
    union
    select id from menu_items where weight_ingredient_id = p_ingredient_id and sold_by_weight
  ),
  chk as (
    select m.id, menu_item_in_stock(m.id) as ok
    from menu_items m where m.id in (select id from menus) and (m.is_available or m.stock_disabled)
  )
  update menu_items m
     set is_available = chk.ok, stock_disabled = not chk.ok
    from chk
   where m.id = chk.id and (m.is_available <> chk.ok);
end;
$$;

create or replace function stock_movements_sync_menus()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform stock_sync_menus(new.ingredient_id);
  return null;
end;
$$;
drop trigger if exists stock_movements_sync_menus on stock_movements;
create trigger stock_movements_sync_menus after insert on stock_movements
  for each row execute function stock_movements_sync_menus();

-- สลับสถานะเองด้วยมือ = ไม่ใช่ระบบปิด
create or replace function set_menu_availability(p_item_id uuid, p_available boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rid uuid;
begin
  select restaurant_id into v_rid from menu_items where id = p_item_id;
  if v_rid is null or not has_role(v_rid, array['owner', 'manager', 'staff', 'kitchen', 'stock']) then
    raise exception 'forbidden';
  end if;
  update menu_items set is_available = p_available, stock_disabled = false where id = p_item_id;
end;
$$;

revoke execute on function recipe_expand(uuid, numeric) from public, anon;
revoke execute on function recipe_unit_cost(uuid) from public, anon;
revoke execute on function recipes_recost(uuid[], uuid[]) from public, anon, authenticated;
revoke execute on function order_ingredient_need(uuid, uuid) from public, anon, authenticated;
revoke execute on function stock_sync_menus(uuid) from public, anon, authenticated;
revoke execute on function menu_item_in_stock(uuid) from public, anon;
grant execute on function recipe_expand(uuid, numeric) to authenticated;
grant execute on function recipe_unit_cost(uuid) to authenticated;
grant execute on function menu_item_in_stock(uuid) to authenticated;
