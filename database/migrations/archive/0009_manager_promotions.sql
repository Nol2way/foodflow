-- FoodFlow — migration 0009: บทบาทผู้จัดการ (manager) + โปรโมชัน
-- รันหลัง 0008_order_status_rules.sql
--
-- ผู้จัดการ (manager) ทำได้ 4 อย่าง
--   1) จัดการโปรโมชัน            2) จัดการพนักงาน (เฉพาะบทบาท staff / kitchen / accountant / stock)
--   3) นำเข้ายอดขาย CSV และย้อนการนำเข้า   4) จัดการเมนูและหมวดเมนู
-- ผู้จัดการแต่งตั้ง/แก้/ลบ เจ้าของหรือผู้จัดการคนอื่นไม่ได้ และเปลี่ยนบทบาทตัวเองไม่ได้ (กันเลื่อนสิทธิ์ตัวเอง)
--
-- โปรโมชัน: เจ้าของ/ผู้จัดการตั้งไว้ พนักงานหน้าร้านเลือกใช้ตอนรับออเดอร์
-- ฐานข้อมูลตรวจว่าโปรใช้ได้ "ตอนนี้" ตามเขตเวลาร้าน และคำนวณส่วนลดเอง (ไม่เชื่อตัวเลขจากหน้าเว็บ)

-- ===== 1) บทบาท manager =====
alter table staff_members drop constraint if exists staff_members_role_check;
alter table staff_members add constraint staff_members_role_check
  check (role in ('owner', 'manager', 'staff', 'kitchen', 'accountant', 'stock'));

-- ===== 2) จัดการพนักงาน =====
drop policy if exists manager_manage_staff on staff_members;
create policy manager_manage_staff on staff_members for all
  using (has_role(restaurant_id, array['manager']) and role in ('staff', 'kitchen', 'accountant', 'stock'))
  with check (has_role(restaurant_id, array['manager']) and role in ('staff', 'kitchen', 'accountant', 'stock'));

-- ===== 3) จัดการเมนูและหมวด (เจ้าของ + ผู้จัดการ) =====
drop policy if exists menu_items_owner on menu_items;
create policy menu_items_owner on menu_items for all
  using (has_role(restaurant_id, array['owner', 'manager']))
  with check (has_role(restaurant_id, array['owner', 'manager']));
drop policy if exists menu_categories_owner on menu_categories;
create policy menu_categories_owner on menu_categories for all
  using (has_role(restaurant_id, array['owner', 'manager']))
  with check (has_role(restaurant_id, array['owner', 'manager']));

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
  update menu_items set is_available = p_available where id = p_item_id;
end;
$$;

-- ===== 4) นำเข้า CSV: ผู้จัดการนำเข้าและย้อนการนำเข้าได้ =====
create or replace function import_sales_history(
  p_restaurant_id uuid,
  p_rows jsonb,
  p_dry_run boolean default false,
  p_skip_unknown boolean default false
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tz text;
  v_batch uuid := gen_random_uuid();
  v_unknown jsonb;
  v_unknown_rows int;
  v_lines int;
  v_orders int;
  v_blocked boolean := false;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager']) then
    raise exception 'forbidden';
  end if;
  if jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) = 0
     or jsonb_array_length(p_rows) > 20000 then
    raise exception 'invalid_rows';
  end if;
  select timezone into v_tz from restaurants where id = p_restaurant_id;

  drop table if exists import_stage;
  drop table if exists import_orders;

  create temp table import_stage on commit drop as
  select (r->>'line')::int as line,
         coalesce(nullif(trim(r->>'ref'), ''), 'line-' || (r->>'line'))
           || '|' || ((r->>'at')::timestamp)::date as group_key,
         (r->>'at')::timestamp as at_local,
         trim(r->>'item') as item,
         (r->>'qty')::int as qty,
         m.id as menu_item_id,
         coalesce(nullif(r->>'price', '')::numeric, m.price) as unit_price
  from jsonb_array_elements(p_rows) r
  left join lateral (
    select mi.id, mi.price from menu_items mi
    where mi.restaurant_id = p_restaurant_id
      and lower(mi.name) = lower(trim(r->>'item'))
    order by mi.id
    limit 1
  ) m on true;

  if exists (
    select 1 from import_stage
    where qty < 1 or qty > 1000
       or unit_price < 0
       or at_local < timestamp '2000-01-01'
       or at_local > (now() at time zone v_tz) + interval '1 day'
  ) then
    raise exception 'invalid_row';
  end if;

  select coalesce(jsonb_agg(distinct item), '[]'::jsonb), count(*)
    into v_unknown, v_unknown_rows
    from import_stage where menu_item_id is null;

  select count(*) into v_lines from import_stage where menu_item_id is not null;

  create temp table import_orders on commit drop as
  select group_key,
         gen_random_uuid() as order_id,
         min(at_local) as at_local,
         sum(qty * unit_price) as total
  from import_stage
  where menu_item_id is not null
  group by group_key;

  select count(*) into v_orders from import_orders;

  if v_unknown_rows > 0 and not p_skip_unknown then
    v_blocked := true;
  end if;

  if not p_dry_run and not v_blocked and v_orders > 0 then
    insert into orders (id, restaurant_id, status, total, created_at, paid_at, stock_deducted_at, import_batch)
    select o.order_id, p_restaurant_id, 'paid'::order_status, o.total,
           o.at_local at time zone v_tz,
           o.at_local at time zone v_tz,
           o.at_local at time zone v_tz,
           v_batch
    from import_orders o;

    insert into order_items (order_id, menu_item_id, quantity, unit_price)
    select o.order_id, s.menu_item_id, s.qty, s.unit_price
    from import_stage s
    join import_orders o on o.group_key = s.group_key
    where s.menu_item_id is not null;
  end if;

  return jsonb_build_object(
    'batch_id', case when p_dry_run or v_blocked or v_orders = 0 then null else v_batch end,
    'dry_run', p_dry_run,
    'blocked', v_blocked,
    'orders', v_orders,
    'lines', v_lines,
    'skipped_lines', v_unknown_rows,
    'unknown_items', v_unknown
  );
end;
$$;

-- ผู้จัดการเห็นและลบได้เฉพาะออเดอร์ที่มาจากการนำเข้า (ย้อนการนำเข้า) ไม่เห็นและลบออเดอร์จริงไม่ได้
drop policy if exists orders_select_manager_import on orders;
create policy orders_select_manager_import on orders for select
  using (has_role(restaurant_id, array['manager']) and import_batch is not null);

drop policy if exists orders_delete on orders;
create policy orders_delete on orders for delete
  using (
    has_role(restaurant_id, array['owner'])
    or (has_role(restaurant_id, array['manager']) and import_batch is not null)
  );

-- ===== 5) โปรโมชัน =====
create table if not exists promotions (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 80),
  discount_type text not null check (discount_type in ('percent', 'amount')),
  value numeric(10,2) not null check (value > 0),
  min_subtotal numeric(10,2) not null default 0 check (min_subtotal >= 0),
  starts_on date,                -- ว่าง = เริ่มทันที
  ends_on date,                  -- ว่าง = ไม่มีวันหมดอายุ
  days_of_week smallint[],       -- 0 = อาทิตย์ ... 6 = เสาร์, ว่าง = ทุกวัน
  start_time time,               -- ช่วงเวลาในวัน (เวลาร้าน) เช่น 14:00-17:00 ช่วงออฟพีค
  end_time time,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (discount_type <> 'percent' or value <= 100),
  check (ends_on is null or starts_on is null or ends_on >= starts_on),
  check (days_of_week is null or days_of_week <@ array[0,1,2,3,4,5,6]::smallint[]),
  check (start_time is null or end_time is null or end_time > start_time)
);
create index if not exists promotions_restaurant_idx on promotions (restaurant_id);

-- โปรเฉพาะบางเมนู (ไม่มีแถว = ลดทั้งบิล)
create table if not exists promotion_items (
  promotion_id uuid not null references promotions(id) on delete cascade,
  menu_item_id uuid not null references menu_items(id) on delete cascade,
  primary key (promotion_id, menu_item_id)
);

alter table promotions enable row level security;
alter table promotion_items enable row level security;

drop policy if exists promotions_read on promotions;
create policy promotions_read on promotions for select using (is_staff_of(restaurant_id));
drop policy if exists promotions_write on promotions;
create policy promotions_write on promotions for all
  using (has_role(restaurant_id, array['owner', 'manager']))
  with check (has_role(restaurant_id, array['owner', 'manager']));

drop policy if exists promotion_items_read on promotion_items;
create policy promotion_items_read on promotion_items for select
  using (exists (select 1 from promotions p where p.id = promotion_id and is_staff_of(p.restaurant_id)));
drop policy if exists promotion_items_write on promotion_items;
create policy promotion_items_write on promotion_items for all
  using (exists (
    select 1 from promotions p
    where p.id = promotion_id and has_role(p.restaurant_id, array['owner', 'manager'])
  ))
  with check (exists (
    select 1 from promotions p join menu_items m on m.id = menu_item_id
    where p.id = promotion_id and m.restaurant_id = p.restaurant_id
      and has_role(p.restaurant_id, array['owner', 'manager'])
  ));

revoke all on promotions, promotion_items from anon;

-- โปรใช้ได้ ณ เวลานี้หรือไม่ (ตามเขตเวลาร้าน)
create or replace function promotion_is_live(p promotions)
returns boolean
language sql stable set search_path = public, pg_temp as $$
  with t as (
    select (now() at time zone r.timezone) as local_now
    from restaurants r where r.id = p.restaurant_id
  )
  select p.is_active
     and (p.starts_on is null or t.local_now::date >= p.starts_on)
     and (p.ends_on is null or t.local_now::date <= p.ends_on)
     and (p.days_of_week is null or cardinality(p.days_of_week) = 0
          or extract(dow from t.local_now)::smallint = any (p.days_of_week))
     and (p.start_time is null or t.local_now::time >= p.start_time)
     and (p.end_time is null or t.local_now::time < p.end_time)
  from t;
$$;

-- โปรที่เลือกใช้ได้ตอนนี้ (หน้ารับออเดอร์) สิทธิ์อ่านตาม RLS
create or replace function promotions_available(p_restaurant_id uuid)
returns setof promotions
language sql stable set search_path = public, pg_temp as $$
  select p.* from promotions p
  where p.restaurant_id = p_restaurant_id and promotion_is_live(p)
  order by p.name;
$$;
revoke execute on function promotions_available(uuid) from public, anon;
grant execute on function promotions_available(uuid) to authenticated;

-- ===== 6) ส่วนลดในออเดอร์ =====
alter table orders add column if not exists subtotal numeric(10,2);           -- ก่อนลด (ว่าง = ออเดอร์ก่อนมีโปร/นำเข้า)
alter table orders add column if not exists discount_total numeric(10,2) not null default 0;
alter table orders drop constraint if exists orders_discount_check;
alter table orders add constraint orders_discount_check check (discount_total >= 0);
alter table orders add column if not exists promotion_id uuid references promotions(id);  -- ลบโปรที่เคยใช้แล้วไม่ได้ ให้ปิดใช้งานแทน

drop function if exists staff_place_order(uuid, jsonb, uuid, text, text, text);
create or replace function staff_place_order(
  p_restaurant_id uuid,
  p_items jsonb,
  p_table_id uuid default null,
  p_order_type text default 'dine_in',
  p_customer_label text default null,
  p_note text default null,
  p_promotion_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order uuid;
  v_subtotal numeric(10,2) := 0;
  v_eligible numeric(10,2) := 0;
  v_discount numeric(10,2) := 0;
  v_item jsonb;
  v_menu menu_items%rowtype;
  v_promo promotions%rowtype;
  v_qty int;
begin
  if not has_role(p_restaurant_id, array['owner', 'staff']) then
    raise exception 'forbidden';
  end if;
  if p_order_type is null or p_order_type not in ('dine_in', 'takeaway') then
    raise exception 'invalid_order_type';
  end if;
  if p_order_type = 'dine_in' then
    if p_table_id is null
       or not exists (select 1 from dining_tables where id = p_table_id and restaurant_id = p_restaurant_id) then
      raise exception 'invalid_table';
    end if;
  else
    p_table_id := null;
  end if;
  if jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) = 0
     or jsonb_array_length(p_items) > 50 then
    raise exception 'invalid_items';
  end if;
  if p_promotion_id is not null then
    select * into v_promo from promotions where id = p_promotion_id and restaurant_id = p_restaurant_id;
    if not found or not promotion_is_live(v_promo) then
      raise exception 'promotion_not_available';
    end if;
  end if;

  insert into orders (restaurant_id, table_id, order_type, customer_label, note, created_by, promotion_id)
  values (p_restaurant_id, p_table_id, p_order_type,
          nullif(left(trim(p_customer_label), 50), ''), nullif(left(trim(p_note), 200), ''), auth.uid(),
          p_promotion_id)
  returning id into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::int;
    if v_qty is null or v_qty < 1 or v_qty > 50 then raise exception 'invalid_quantity'; end if;

    select * into v_menu from menu_items
      where id = (v_item->>'menu_item_id')::uuid and restaurant_id = p_restaurant_id;
    if not found then raise exception 'invalid_menu_item'; end if;
    if not v_menu.is_available then raise exception 'item_unavailable: %', v_menu.name; end if;

    insert into order_items (order_id, menu_item_id, quantity, unit_price, note)
    values (v_order, v_menu.id, v_qty, v_menu.price, nullif(left(trim(v_item->>'note'), 200), ''));

    v_subtotal := v_subtotal + v_menu.price * v_qty;
  end loop;

  if p_promotion_id is not null then
    if v_subtotal < v_promo.min_subtotal then
      raise exception 'promotion_min_subtotal: %', v_promo.min_subtotal;
    end if;
    select coalesce(sum(oi.quantity * oi.unit_price), 0) into v_eligible
    from order_items oi
    where oi.order_id = v_order
      and (not exists (select 1 from promotion_items pi where pi.promotion_id = p_promotion_id)
           or exists (select 1 from promotion_items pi
                      where pi.promotion_id = p_promotion_id and pi.menu_item_id = oi.menu_item_id));
    if v_eligible = 0 then
      raise exception 'promotion_no_eligible_items';
    end if;
    v_discount := case v_promo.discount_type
      when 'percent' then round(v_eligible * v_promo.value / 100, 2)
      else least(v_promo.value, v_eligible)
    end;
  end if;

  update orders
     set subtotal = v_subtotal, discount_total = v_discount, total = v_subtotal - v_discount
   where id = v_order;
  return v_order;
end;
$$;

revoke execute on function staff_place_order(uuid, jsonb, uuid, text, text, text, uuid) from public, anon;
grant execute on function staff_place_order(uuid, jsonb, uuid, text, text, text, uuid) to authenticated;

-- ===== 7) สรุปบัญชีมียอดส่วนลดโปรโมชัน =====
drop function if exists accounting_summary(uuid, int);
create or replace function accounting_summary(p_restaurant_id uuid, p_days int default 1)
returns table (
  from_date date,
  to_date date,
  revenue_total numeric,
  paid_orders bigint,
  expense_total numeric,
  expenses_by_category jsonb,
  discount_total numeric
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_tz text;
  v_to date;
  v_from date;
begin
  if not has_role(p_restaurant_id, array['owner', 'accountant']) then
    raise exception 'forbidden';
  end if;
  if p_days is null or p_days < 1 or p_days > 366 then
    raise exception 'invalid_days';
  end if;

  select timezone into v_tz from restaurants where id = p_restaurant_id;
  v_to := (now() at time zone v_tz)::date;
  v_from := v_to - (p_days - 1);

  return query
  select v_from,
         v_to,
         coalesce((select sum(o.total) from orders o
                   where o.restaurant_id = p_restaurant_id and o.status = 'paid'
                     and (o.paid_at at time zone v_tz)::date between v_from and v_to), 0)::numeric,
         (select count(*) from orders o
           where o.restaurant_id = p_restaurant_id and o.status = 'paid'
             and (o.paid_at at time zone v_tz)::date between v_from and v_to)::bigint,
         coalesce((select sum(e.amount) from expenses e
                   where e.restaurant_id = p_restaurant_id and e.spent_on between v_from and v_to), 0)::numeric,
         coalesce((select jsonb_object_agg(x.category, x.amount) from (
                     select e.category::text as category, sum(e.amount) as amount
                     from expenses e
                     where e.restaurant_id = p_restaurant_id and e.spent_on between v_from and v_to
                     group by e.category) x), '{}'::jsonb),
         coalesce((select sum(o.discount_total) from orders o
                   where o.restaurant_id = p_restaurant_id and o.status = 'paid'
                     and (o.paid_at at time zone v_tz)::date between v_from and v_to), 0)::numeric;
end;
$$;

revoke execute on function accounting_summary(uuid, int) from public, anon;
grant execute on function accounting_summary(uuid, int) to authenticated;
