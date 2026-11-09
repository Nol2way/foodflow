-- Plato — migration 0001: แกนหลัก: ร้าน เมนู ออเดอร์ บทบาท สถานะออเดอร์ โปรโมชัน
-- รวมจาก migration เดิม 0001–0012 (12 ไฟล์) ต่อกันตามลำดับเดิม เนื้อหาไม่เปลี่ยน
-- ไฟล์เดิมเก็บไว้ที่ migrations/archive/ (เลขในคอมเมนต์ด้านล่าง เช่น "0017" หมายถึงไฟล์เดิมเหล่านั้น)

-- ========================================================================
-- เดิม: 0001_schema.sql
-- ========================================================================

-- FoodFlow — โครงสร้างฐานข้อมูลเริ่มต้น (เฟส 1)
-- รันใน Supabase SQL Editor ทั้งไฟล์
-- ออกแบบให้รองรับหลายร้าน (multi-tenant): ทุกตารางหลักมี restaurant_id

create extension if not exists "pgcrypto";

-- ===== ร้านและสมาชิก =====
create table restaurants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create type staff_role as enum ('owner', 'staff');

create table staff_members (
  user_id uuid not null references auth.users(id) on delete cascade,
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  role staff_role not null default 'staff',
  primary key (user_id, restaurant_id)
);

-- ===== เมนู =====
create table menu_categories (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  name text not null,
  sort_order int not null default 0
);

create table menu_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  category_id uuid references menu_categories(id) on delete set null,
  name text not null,
  price numeric(10,2) not null check (price >= 0),
  is_available boolean not null default true,
  image_url text
);

-- ===== โต๊ะและออเดอร์ =====
create table dining_tables (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  label text not null,
  unique (restaurant_id, label)
);

create type order_status as enum ('received', 'preparing', 'ready', 'served', 'paid', 'cancelled');

create table orders (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  table_id uuid references dining_tables(id) on delete set null,
  status order_status not null default 'received',
  total numeric(10,2) not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,   -- เริ่มทำ (ใช้วัดเวลาครัว)
  ready_at timestamptz,     -- ทำเสร็จ
  paid_at timestamptz
);

create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  menu_item_id uuid not null references menu_items(id),
  quantity int not null check (quantity > 0),
  unit_price numeric(10,2) not null,
  note text
);

-- ===== บัญชี =====
create type expense_category as enum ('ingredients', 'labor', 'rent', 'utilities', 'other');

create table expenses (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  category expense_category not null,
  amount numeric(12,2) not null check (amount >= 0),
  spent_on date not null default current_date,
  note text,
  receipt_url text
);

-- ===== สต็อกและสูตรอาหาร =====
create table ingredients (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  name text not null,
  unit text not null,                          -- เช่น g, ml, ชิ้น
  quantity_on_hand numeric(12,3) not null default 0 check (quantity_on_hand >= 0),
  reorder_level numeric(12,3) not null default 0,
  cost_per_unit numeric(12,4) not null default 0
);

create table recipes (
  menu_item_id uuid not null references menu_items(id) on delete cascade,
  ingredient_id uuid not null references ingredients(id) on delete cascade,
  quantity_used numeric(12,3) not null check (quantity_used > 0),
  primary key (menu_item_id, ingredient_id)
);

create type stock_reason as enum ('purchase', 'sale', 'waste', 'adjustment');

create table stock_movements (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  ingredient_id uuid not null references ingredients(id) on delete cascade,
  change numeric(12,3) not null,               -- บวก = เข้า, ลบ = ออก
  reason stock_reason not null,
  created_at timestamptz not null default now()
);

-- ===== ดัชนีสำหรับรายงานและ AI =====
create index orders_restaurant_created_idx on orders (restaurant_id, created_at);
create index expenses_restaurant_date_idx on expenses (restaurant_id, spent_on);
create index stock_movements_ing_idx on stock_movements (ingredient_id, created_at);

-- ===== Row Level Security =====
-- ฟังก์ชันเช็คว่าผู้ใช้ปัจจุบันเป็นพนักงานของร้านนั้นหรือไม่
create or replace function is_staff_of(rid uuid) returns boolean
language sql stable security definer as $$
  select exists (
    select 1 from staff_members
    where user_id = auth.uid() and restaurant_id = rid
  );
$$;

alter table restaurants      enable row level security;
alter table staff_members    enable row level security;
alter table menu_categories  enable row level security;
alter table menu_items       enable row level security;
alter table dining_tables    enable row level security;
alter table orders           enable row level security;
alter table order_items      enable row level security;
alter table expenses         enable row level security;
alter table ingredients      enable row level security;
alter table recipes          enable row level security;
alter table stock_movements  enable row level security;

-- พนักงานของร้านจัดการข้อมูลของร้านตัวเองได้
create policy staff_all on menu_categories for all using (is_staff_of(restaurant_id)) with check (is_staff_of(restaurant_id));
create policy staff_all on menu_items      for all using (is_staff_of(restaurant_id)) with check (is_staff_of(restaurant_id));
create policy staff_all on dining_tables   for all using (is_staff_of(restaurant_id)) with check (is_staff_of(restaurant_id));
create policy staff_all on orders          for all using (is_staff_of(restaurant_id)) with check (is_staff_of(restaurant_id));
create policy staff_all on expenses        for all using (is_staff_of(restaurant_id)) with check (is_staff_of(restaurant_id));
create policy staff_all on ingredients     for all using (is_staff_of(restaurant_id)) with check (is_staff_of(restaurant_id));
create policy staff_all on stock_movements for all using (is_staff_of(restaurant_id)) with check (is_staff_of(restaurant_id));

create policy staff_read_self on staff_members for select using (user_id = auth.uid());
create policy staff_read_restaurant on restaurants for select using (is_staff_of(id));

create policy staff_all on order_items for all
  using (exists (select 1 from orders o where o.id = order_id and is_staff_of(o.restaurant_id)))
  with check (exists (select 1 from orders o where o.id = order_id and is_staff_of(o.restaurant_id)));

create policy staff_all on recipes for all
  using (exists (select 1 from menu_items m where m.id = menu_item_id and is_staff_of(m.restaurant_id)))
  with check (exists (select 1 from menu_items m where m.id = menu_item_id and is_staff_of(m.restaurant_id)));

-- ลูกค้า (ไม่ต้องล็อกอิน) อ่านเมนูที่เปิดขายได้
create policy public_read_menu on menu_items for select using (is_available);
create policy public_read_categories on menu_categories for select using (true);

-- หมายเหตุ: การสร้างออเดอร์ของลูกค้าให้ทำผ่าน backend API (service role)
-- เพื่อตรวจโต๊ะ ราคา และสต็อกฝั่งเซิร์ฟเวอร์ ไม่เปิดให้เขียนตรงจากหน้าเว็บ

-- ========================================================================
-- เดิม: 0002_customer_ordering.sql
-- ========================================================================

-- FoodFlow — migration 0002: การสั่งอาหารของลูกค้า (ไม่ต้องล็อกอิน)
-- ⚠️ การสั่งอาหารเองของลูกค้าในไฟล์นี้ถูกยกเลิกโดย 0007_staff_ordering.sql (พนักงานเป็นผู้รับออเดอร์เท่านั้น)
-- รันหลัง 0001_schema.sql
-- หลักการ: ลูกค้าไม่เขียนตารางตรงๆ ทุกอย่างผ่านฟังก์ชันที่ตรวจโต๊ะ ราคา และเมนูฝั่งฐานข้อมูล

-- ลูกค้าอ่านเมนูได้ทั้งหมด เพื่อแสดงป้าย "หมด" ได้
drop policy if exists public_read_menu on menu_items;
create policy public_read_menu on menu_items for select using (true);

-- ข้อมูลโต๊ะจาก QR
create or replace function get_table_info(p_table_id uuid)
returns table (restaurant_id uuid, restaurant_name text, table_label text)
language sql stable security definer set search_path = public as $$
  select r.id, r.name, t.label
  from dining_tables t
  join restaurants r on r.id = t.restaurant_id
  where t.id = p_table_id;
$$;

-- สร้างออเดอร์: ใช้ราคาจากฐานข้อมูลเสมอ ไม่เชื่อราคาที่ client ส่งมา
create or replace function place_order(p_table_id uuid, p_items jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_rid uuid;
  v_order uuid;
  v_total numeric(10,2) := 0;
  v_item jsonb;
  v_menu menu_items%rowtype;
  v_qty int;
begin
  select restaurant_id into v_rid from dining_tables where id = p_table_id;
  if v_rid is null then raise exception 'invalid_table'; end if;

  if jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0
     or jsonb_array_length(p_items) > 50 then
    raise exception 'invalid_items';
  end if;

  insert into orders (restaurant_id, table_id) values (v_rid, p_table_id) returning id into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::int;
    if v_qty is null or v_qty < 1 or v_qty > 50 then raise exception 'invalid_quantity'; end if;

    select * into v_menu from menu_items
      where id = (v_item->>'menu_item_id')::uuid and restaurant_id = v_rid;
    if not found then raise exception 'invalid_menu_item'; end if;
    if not v_menu.is_available then raise exception 'item_unavailable: %', v_menu.name; end if;

    insert into order_items (order_id, menu_item_id, quantity, unit_price, note)
    values (v_order, v_menu.id, v_qty, v_menu.price, left(v_item->>'note', 200));

    v_total := v_total + v_menu.price * v_qty;
  end loop;

  update orders set total = v_total where id = v_order;
  return v_order;
end;
$$;

-- ลูกค้าดูสถานะออเดอร์ของตัวเอง (ต้องรู้ id ซึ่งเป็น UUID เดายาก)
create or replace function get_order_status(p_order_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'status', o.status,
    'total', o.total,
    'created_at', o.created_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('name', m.name, 'quantity', oi.quantity))
      from order_items oi
      join menu_items m on m.id = oi.menu_item_id
      where oi.order_id = o.id
    ), '[]'::jsonb)
  )
  from orders o
  where o.id = p_order_id;
$$;

revoke execute on function get_table_info(uuid) from public;
revoke execute on function place_order(uuid, jsonb) from public;
revoke execute on function get_order_status(uuid) from public;
grant execute on function get_table_info(uuid) to anon, authenticated;
grant execute on function place_order(uuid, jsonb) to anon, authenticated;
grant execute on function get_order_status(uuid) to anon, authenticated;

-- บันทึกเวลาอัตโนมัติเมื่อสถานะเปลี่ยน (ใช้วัดเวลาที่ครัวใช้ทำอาหาร)
create or replace function set_order_timestamps()
returns trigger language plpgsql as $$
begin
  if new.status = 'preparing' and old.status <> 'preparing' and new.started_at is null then
    new.started_at := now();
  end if;
  if new.status = 'ready' and old.status <> 'ready' and new.ready_at is null then
    new.ready_at := now();
  end if;
  if new.status = 'paid' and old.status <> 'paid' and new.paid_at is null then
    new.paid_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists orders_set_timestamps on orders;
create trigger orders_set_timestamps before update on orders
  for each row execute function set_order_timestamps();

-- เปิด Realtime ให้ตาราง orders (หน้าจอครัวรับออเดอร์ใหม่ทันที)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'orders'
  ) then
    alter publication supabase_realtime add table orders;
  end if;
end;
$$;

-- ========================================================================
-- เดิม: 0003_roles.sql
-- ========================================================================

-- FoodFlow — migration 0003: บทบาทและสิทธิ์
-- รันหลัง 0002_customer_ordering.sql
--
-- บทบาท: owner (เจ้าของ) · staff (พนักงานหน้าร้าน/แคชเชียร์) · kitchen (ครัว)
--        accountant (พนักงานบัญชี) · stock (พนักงานสต็อก)
-- ลูกค้าไม่มีบทบาท ใช้เฉพาะฟังก์ชันใน 0002
-- สิทธิ์จริงบังคับที่ฐานข้อมูล (RLS) การซ่อนเมนูในหน้าเว็บเป็นแค่ความสะดวกของผู้ใช้

-- ===== 1) บทบาท: เปลี่ยนจาก enum เป็น text + check เพื่อเพิ่มบทบาทภายหลังได้ง่าย =====
alter table staff_members alter column role drop default;
alter table staff_members alter column role type text using role::text;
alter table staff_members alter column role set default 'staff';
alter table staff_members drop constraint if exists staff_members_role_check;
alter table staff_members add constraint staff_members_role_check
  check (role in ('owner', 'staff', 'kitchen', 'accountant', 'stock'));
drop type if exists staff_role;

-- ===== 2) ฟังก์ชันตรวจบทบาท =====
create or replace function has_role(rid uuid, roles text[])
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from staff_members
    where user_id = auth.uid()
      and restaurant_id = rid
      and role = any(roles)
  );
$$;

-- ===== 3) ลบ policy แบบเดิม (สิทธิ์เท่ากันทุกคน) =====
drop policy if exists staff_all on menu_categories;
drop policy if exists staff_all on menu_items;
drop policy if exists staff_all on dining_tables;
drop policy if exists staff_all on orders;
drop policy if exists staff_all on order_items;
drop policy if exists staff_all on expenses;
drop policy if exists staff_all on ingredients;
drop policy if exists staff_all on recipes;
drop policy if exists staff_all on stock_movements;

-- ===== 4) จัดการพนักงาน: เจ้าของเท่านั้น =====
drop policy if exists owner_manage_staff on staff_members;
create policy owner_manage_staff on staff_members for all
  using (has_role(restaurant_id, array['owner']))
  with check (has_role(restaurant_id, array['owner']));

-- ===== 5) เมนูและโต๊ะ: เจ้าของแก้ไขได้ (ลูกค้าอ่านเมนูได้อยู่แล้วจาก 0002) =====
create policy menu_categories_owner on menu_categories for all
  using (has_role(restaurant_id, array['owner']))
  with check (has_role(restaurant_id, array['owner']));

create policy menu_items_owner on menu_items for all
  using (has_role(restaurant_id, array['owner']))
  with check (has_role(restaurant_id, array['owner']));

create policy tables_owner on dining_tables for all
  using (has_role(restaurant_id, array['owner']))
  with check (has_role(restaurant_id, array['owner']));

create policy tables_crew_read on dining_tables for select
  using (has_role(restaurant_id, array['staff', 'kitchen']));

-- ===== 6) ออเดอร์ =====
-- อ่าน: เจ้าของ หน้าร้าน ครัว บัญชี (บัญชีต้องใช้ยอดขาย)
create policy orders_select on orders for select
  using (has_role(restaurant_id, array['owner', 'staff', 'kitchen', 'accountant']));

create policy orders_insert on orders for insert
  with check (has_role(restaurant_id, array['owner', 'staff']));

-- แก้สถานะ: ครัวทำได้เฉพาะ received → preparing → ready → served
-- ส่วน paid / cancelled เป็นของหน้าร้านและเจ้าของเท่านั้น
create policy orders_update on orders for update
  using (has_role(restaurant_id, array['owner', 'staff', 'kitchen']))
  with check (
    has_role(restaurant_id, array['owner', 'staff'])
    or (
      has_role(restaurant_id, array['kitchen'])
      and status in ('received', 'preparing', 'ready', 'served')
    )
  );

create policy orders_delete on orders for delete
  using (has_role(restaurant_id, array['owner']));

create policy order_items_read on order_items for select
  using (exists (
    select 1 from orders o
    where o.id = order_id
      and has_role(o.restaurant_id, array['owner', 'staff', 'kitchen', 'accountant'])
  ));

create policy order_items_write on order_items for all
  using (exists (
    select 1 from orders o
    where o.id = order_id and has_role(o.restaurant_id, array['owner', 'staff'])
  ))
  with check (exists (
    select 1 from orders o
    where o.id = order_id and has_role(o.restaurant_id, array['owner', 'staff'])
  ));

-- ===== 7) บัญชี: เจ้าของและพนักงานบัญชี =====
create policy expenses_accounting on expenses for all
  using (has_role(restaurant_id, array['owner', 'accountant']))
  with check (has_role(restaurant_id, array['owner', 'accountant']));

-- ===== 8) สต็อก =====
create policy ingredients_read on ingredients for select
  using (has_role(restaurant_id, array['owner', 'stock', 'accountant', 'kitchen']));

create policy ingredients_write on ingredients for all
  using (has_role(restaurant_id, array['owner', 'stock']))
  with check (has_role(restaurant_id, array['owner', 'stock']));

-- ห้ามแก้ยอดคงเหลือตรงๆ ต้องผ่าน stock_movements เสมอ (มีประวัติทุกครั้ง)
revoke update on ingredients from authenticated;
grant update (name, unit, reorder_level, cost_per_unit) on ingredients to authenticated;

create policy recipes_read on recipes for select
  using (exists (
    select 1 from menu_items m
    where m.id = menu_item_id
      and has_role(m.restaurant_id, array['owner', 'stock', 'accountant', 'kitchen'])
  ));

create policy recipes_write on recipes for all
  using (exists (
    select 1 from menu_items m
    where m.id = menu_item_id and has_role(m.restaurant_id, array['owner', 'stock'])
  ))
  with check (exists (
    select 1 from menu_items m
    where m.id = menu_item_id and has_role(m.restaurant_id, array['owner', 'stock'])
  ));

create policy stock_movements_read on stock_movements for select
  using (has_role(restaurant_id, array['owner', 'stock', 'accountant']));

-- เพิ่มประวัติได้อย่างเดียว (ไม่มี update/delete) ครัวบันทึกได้เฉพาะของเสีย
create policy stock_movements_insert on stock_movements for insert
  with check (
    has_role(restaurant_id, array['owner', 'stock'])
    or (has_role(restaurant_id, array['kitchen']) and reason = 'waste' and change < 0)
  );

-- ทุกครั้งที่มีประวัติเข้า/ออก ปรับยอดคงเหลือให้อัตโนมัติ
-- ถ้าทำให้ยอดติดลบ จะผิดกฎ check ของตาราง ingredients และถูกปฏิเสธทั้งรายการ
create or replace function apply_stock_movement()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update ingredients
     set quantity_on_hand = quantity_on_hand + new.change
   where id = new.ingredient_id
     and restaurant_id = new.restaurant_id;
  if not found then
    raise exception 'invalid_ingredient';
  end if;
  return new;
end;
$$;

drop trigger if exists stock_movements_apply on stock_movements;
create trigger stock_movements_apply after insert on stock_movements
  for each row execute function apply_stock_movement();

-- ===== 9) เปิด/ปิดเมนู "หมด": เจ้าของ หน้าร้าน ครัว สต็อก (แก้ได้เฉพาะช่อง is_available) =====
create or replace function set_menu_availability(p_item_id uuid, p_available boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_rid uuid;
begin
  select restaurant_id into v_rid from menu_items where id = p_item_id;
  if v_rid is null or not has_role(v_rid, array['owner', 'staff', 'kitchen', 'stock']) then
    raise exception 'forbidden';
  end if;
  update menu_items set is_available = p_available where id = p_item_id;
end;
$$;

revoke execute on function set_menu_availability(uuid, boolean) from public;
grant execute on function set_menu_availability(uuid, boolean) to authenticated;

-- ========================================================================
-- เดิม: 0004_stock_costs_analytics.sql
-- ========================================================================

-- FoodFlow — migration 0004: ตัดสต็อกตามสูตรอาหาร · ต้นทุนต่อเมนู · วิเคราะห์ช่วงพีค/ออฟพีค
-- รันหลัง 0003_roles.sql

-- ===== 1) คอลัมน์ที่เพิ่ม =====
alter table restaurants add column if not exists timezone text not null default 'Asia/Bangkok';
alter table orders add column if not exists stock_deducted_at timestamptz;  -- กันตัดสต็อกซ้ำ
alter table orders add column if not exists is_demo boolean not null default false;  -- ข้อมูลทดลอง ลบได้: delete from orders where is_demo

-- ออเดอร์เก่าที่เลยขั้น "รับออเดอร์" ไปแล้ว ถือว่าไม่ต้องตัดสต็อกย้อนหลัง
update orders set stock_deducted_at = coalesce(started_at, created_at)
 where status <> 'received' and stock_deducted_at is null;

-- ===== 2) สูตรอาหาร: วัตถุดิบต้องเป็นของร้านเดียวกับเมนู =====
drop policy if exists recipes_write on recipes;
create policy recipes_write on recipes for all
  using (exists (
    select 1 from menu_items m
    where m.id = menu_item_id and has_role(m.restaurant_id, array['owner', 'stock'])
  ))
  with check (exists (
    select 1 from menu_items m
    join ingredients i on i.restaurant_id = m.restaurant_id
    where m.id = menu_item_id
      and i.id = ingredient_id
      and has_role(m.restaurant_id, array['owner', 'stock'])
  ));

-- ===== 3) ตัดสต็อกอัตโนมัติ =====
-- ตัดเมื่อออเดอร์เริ่มทำ (preparing) เป็นครั้งแรก ตามสูตร x จำนวนที่สั่ง
-- ถ้าสต็อกในระบบน้อยกว่าที่ต้องใช้ จะตัดเท่าที่มี (ไม่ขวางครัว เพราะอาหารถูกทำไปแล้วจริง)
-- เมนูที่ยังไม่มีสูตรจะไม่ตัดอะไร
create or replace function deduct_stock_for_order()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.stock_deducted_at is null
     and new.status in ('preparing', 'ready', 'served', 'paid') then
    insert into stock_movements (restaurant_id, ingredient_id, change, reason)
    select new.restaurant_id,
           r.ingredient_id,
           -least(sum(r.quantity_used * oi.quantity), i.quantity_on_hand),
           'sale'::stock_reason
    from order_items oi
    join recipes r on r.menu_item_id = oi.menu_item_id
    join ingredients i on i.id = r.ingredient_id and i.restaurant_id = new.restaurant_id
    where oi.order_id = new.id
    group by r.ingredient_id, i.quantity_on_hand
    having least(sum(r.quantity_used * oi.quantity), i.quantity_on_hand) > 0;

    new.stock_deducted_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists orders_deduct_stock on orders;
create trigger orders_deduct_stock before update on orders
  for each row execute function deduct_stock_for_order();

-- ===== 4) ต้นทุนต่อเมนู (ใช้สิทธิ์ของผู้เรียก: เจ้าของ/บัญชีเห็นต้นทุนจริง) =====
create or replace view menu_item_costs with (security_invoker = true) as
select m.id as menu_item_id,
       m.restaurant_id,
       m.name,
       m.price,
       coalesce(sum(r.quantity_used * i.cost_per_unit), 0)::numeric(12,2) as unit_cost,
       count(r.ingredient_id) as ingredient_count
from menu_items m
left join recipes r on r.menu_item_id = m.id
left join ingredients i on i.id = r.ingredient_id
group by m.id;

grant select on menu_item_costs to authenticated;

-- ===== 5) วิเคราะห์ลูกค้า: เจ้าของและพนักงานบัญชีเท่านั้น =====
-- นับ "ความต้องการ" จากออเดอร์ที่ไม่ถูกยกเลิก ส่วนรายได้นับเฉพาะที่ชำระแล้ว
-- ไม่ใช้ข้อมูลส่วนบุคคลของลูกค้า (ลูกค้าไม่ต้องสมัครสมาชิก)

-- จำนวนออเดอร์แยกตาม วันในสัปดาห์ (0=อาทิตย์) x ชั่วโมง ตามเขตเวลาของร้าน
create or replace function analytics_hourly(p_restaurant_id uuid, p_days int default 28)
returns table (day_of_week int, hour_of_day int, order_count bigint, revenue_total numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  v_tz text;
begin
  if not has_role(p_restaurant_id, array['owner', 'accountant']) then
    raise exception 'forbidden';
  end if;
  select timezone into v_tz from restaurants where id = p_restaurant_id;

  return query
  select extract(dow from (o.created_at at time zone v_tz))::int,
         extract(hour from (o.created_at at time zone v_tz))::int,
         count(*)::bigint,
         coalesce(sum(o.total) filter (where o.status = 'paid'), 0)::numeric
  from orders o
  where o.restaurant_id = p_restaurant_id
    and o.status <> 'cancelled'
    and o.created_at >= now() - make_interval(days => least(greatest(p_days, 1), 120))
  group by 1, 2;
end;
$$;

create or replace function analytics_summary(p_restaurant_id uuid, p_days int default 28)
returns table (
  order_count bigint,
  revenue_total numeric,
  avg_bill numeric,
  avg_prep_minutes numeric,
  first_order_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'accountant']) then
    raise exception 'forbidden';
  end if;

  return query
  select count(*)::bigint,
         coalesce(sum(o.total) filter (where o.status = 'paid'), 0)::numeric,
         coalesce(avg(o.total) filter (where o.status = 'paid'), 0)::numeric,
         coalesce(avg(extract(epoch from (o.ready_at - o.started_at)) / 60)
                  filter (where o.ready_at is not null and o.started_at is not null), 0)::numeric,
         (select min(x.created_at) from orders x
           where x.restaurant_id = p_restaurant_id and x.status <> 'cancelled')
  from orders o
  where o.restaurant_id = p_restaurant_id
    and o.status <> 'cancelled'
    and o.created_at >= now() - make_interval(days => least(greatest(p_days, 1), 120));
end;
$$;

create or replace function analytics_top_items(p_restaurant_id uuid, p_days int default 28)
returns table (item_name text, quantity_sold bigint, revenue_total numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'accountant']) then
    raise exception 'forbidden';
  end if;

  return query
  select m.name,
         sum(oi.quantity)::bigint,
         sum(oi.quantity * oi.unit_price)::numeric
  from order_items oi
  join orders o on o.id = oi.order_id
  join menu_items m on m.id = oi.menu_item_id
  where o.restaurant_id = p_restaurant_id
    and o.status <> 'cancelled'
    and o.created_at >= now() - make_interval(days => least(greatest(p_days, 1), 120))
  group by m.id, m.name
  order by 2 desc
  limit 10;
end;
$$;

revoke execute on function analytics_hourly(uuid, int) from public;
revoke execute on function analytics_summary(uuid, int) from public;
revoke execute on function analytics_top_items(uuid, int) from public;
grant execute on function analytics_hourly(uuid, int) to authenticated;
grant execute on function analytics_summary(uuid, int) to authenticated;
grant execute on function analytics_top_items(uuid, int) to authenticated;

-- ========================================================================
-- เดิม: 0005_import_and_hardening.sql
-- ========================================================================

-- FoodFlow — migration 0005: นำเข้ายอดขายย้อนหลัง (CSV) + เสริมความปลอดภัยฟังก์ชัน
-- รันหลัง 0004_stock_costs_analytics.sql

-- ===== 1) นำเข้ายอดขายย้อนหลัง =====
alter table orders add column if not exists import_batch uuid;  -- รหัสรอบการนำเข้า ใช้ย้อนลบได้
create index if not exists orders_import_batch_idx on orders (import_batch) where import_batch is not null;

-- p_rows: [{line, ref, at, item, qty, price}]
--   at   = เวลาท้องถิ่นของร้าน 'YYYY-MM-DD HH:MM[:SS]' (แปลงตาม restaurants.timezone)
--   ref  = เลขที่ออเดอร์/บิล (ไม่บังคับ) แถวที่ ref เดียวกันในวันเดียวกันรวมเป็น 1 ออเดอร์
--          ref เดียวกันคนละวันถือเป็นคนละออเดอร์ (POS หลายตัวรีเซ็ตเลขบิลทุกวัน)
--   item = ชื่อเมนู ต้องตรงกับในระบบ (ไม่สนตัวพิมพ์เล็ก/ใหญ่) ไม่เดาชื่อที่ไม่รู้จัก
--   price = ราคาต่อหน่วย (ไม่บังคับ ถ้าไม่ใส่ใช้ราคาเมนูปัจจุบัน)
-- ออเดอร์ที่นำเข้า: สถานะ paid, ไม่ตัดสต็อก (ถือว่าเกิดขึ้นแล้ว), ไม่มีเวลาครัว (ไม่กระทบค่าเฉลี่ยเวลาทำอาหาร)
-- เมนูที่ไม่รู้จัก: ถ้าไม่ระบุ p_skip_unknown จะไม่นำเข้าอะไรเลย (blocked) แล้วรายงานรายชื่อกลับ
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
  if not has_role(p_restaurant_id, array['owner']) then
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

revoke execute on function import_sales_history(uuid, jsonb, boolean, boolean) from public, anon;
grant execute on function import_sales_history(uuid, jsonb, boolean, boolean) to authenticated;

-- ===== 2) จัดการพนักงาน (ใช้ผ่าน backend เท่านั้น) =====
-- หา user id จากอีเมล และรายชื่อพนักงานพร้อมอีเมล ต้องอ่าน auth.users จึงให้เฉพาะ service_role
-- backend ตรวจว่าผู้เรียกเป็นเจ้าของร้านก่อนเรียกเสมอ
create or replace function staff_find_user(p_email text)
returns uuid
language sql stable security definer set search_path = public, auth, pg_temp as $$
  select id from auth.users where lower(email) = lower(trim(p_email)) limit 1;
$$;

create or replace function staff_list(p_restaurant_id uuid)
returns table (user_id uuid, email text, role text)
language sql stable security definer set search_path = public, auth, pg_temp as $$
  select s.user_id, u.email::text, s.role
  from staff_members s join auth.users u on u.id = s.user_id
  where s.restaurant_id = p_restaurant_id
  order by s.role, u.email;
$$;

revoke execute on function staff_find_user(text) from public, anon, authenticated;
revoke execute on function staff_list(uuid) from public, anon, authenticated;
grant execute on function staff_find_user(text) to service_role;
grant execute on function staff_list(uuid) to service_role;

-- กันร้านไม่มีเจ้าของ: ลบหรือเปลี่ยนบทบาทเจ้าของคนสุดท้ายไม่ได้
-- (ยกเว้นกำลังลบทั้งร้าน ซึ่งแถวร้านถูกลบไปก่อนแล้วตอน cascade)
create or replace function keep_last_owner()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner' or new.restaurant_id <> old.restaurant_id)
     and exists (select 1 from restaurants where id = old.restaurant_id)
     and not exists (
       select 1 from staff_members
       where restaurant_id = old.restaurant_id and role = 'owner' and user_id <> old.user_id
     ) then
    raise exception 'last_owner';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists staff_keep_last_owner on staff_members;
create trigger staff_keep_last_owner
  before update or delete on staff_members
  for each row execute function keep_last_owner();

-- ===== 3) backend (service role) เรียกสร้างออเดอร์ได้ =====
grant execute on function place_order(uuid, jsonb) to service_role;

-- ===== 4) search_path ของฟังก์ชัน security definer ทั้งหมด =====
-- ระบุ pg_temp ไว้ท้ายสุด กันตารางชั่วคราวที่ผู้เรียกสร้างมาบังตารางจริงในฟังก์ชัน
alter function is_staff_of(uuid) set search_path = public, pg_temp;
alter function has_role(uuid, text[]) set search_path = public, pg_temp;
alter function get_table_info(uuid) set search_path = public, pg_temp;
alter function place_order(uuid, jsonb) set search_path = public, pg_temp;
alter function get_order_status(uuid) set search_path = public, pg_temp;
alter function apply_stock_movement() set search_path = public, pg_temp;
alter function deduct_stock_for_order() set search_path = public, pg_temp;
alter function set_menu_availability(uuid, boolean) set search_path = public, pg_temp;
alter function analytics_hourly(uuid, int) set search_path = public, pg_temp;
alter function analytics_summary(uuid, int) set search_path = public, pg_temp;
alter function analytics_top_items(uuid, int) set search_path = public, pg_temp;

-- ========================================================================
-- เดิม: 0006_accounting_summary.sql
-- ========================================================================

-- FoodFlow — migration 0006: สรุปบัญชีคำนวณในฐานข้อมูล
-- รันหลัง 0005_import_and_hardening.sql
--
-- แก้ปัญหา: หน้าบัญชีเดิมดึงออเดอร์ทุกแถวมารวมยอดในเบราว์เซอร์ แต่ Supabase ส่งได้สูงสุด 1,000 แถวต่อครั้ง (max rows)
-- ร้านที่มีออเดอร์ชำระแล้วเกิน 1,000 รายการในช่วงที่เลือก ยอดรายรับ/กำไรจะต่ำกว่าจริงโดยไม่มีคำเตือน
-- และขอบเขต "วันนี้" ใช้เขตเวลาของเครื่องผู้ใช้ ไม่ใช่ของร้าน
-- ฟังก์ชันนี้รวมยอดในฐานข้อมูลตามเขตเวลาของร้าน (restaurants.timezone)

create or replace function accounting_summary(p_restaurant_id uuid, p_days int default 1)
returns table (
  from_date date,
  to_date date,
  revenue_total numeric,
  paid_orders bigint,
  expense_total numeric,
  expenses_by_category jsonb
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
                     group by e.category) x), '{}'::jsonb);
end;
$$;

revoke execute on function accounting_summary(uuid, int) from public, anon;
grant execute on function accounting_summary(uuid, int) to authenticated;

-- ========================================================================
-- เดิม: 0007_staff_ordering.sql
-- ========================================================================

-- FoodFlow — migration 0007: พนักงานเป็นผู้รับออเดอร์เท่านั้น
-- รันหลัง 0006_accounting_summary.sql
--
-- เปลี่ยนจากเดิม: ลูกค้าไม่สั่งอาหารเอง (ยกเลิกการสแกน QR สั่งอาหารจาก 0002)
-- พนักงานหน้าร้าน/เจ้าของคีย์ออเดอร์ผ่าน staff_place_order แล้วออเดอร์เข้าหน้าจอครัวทันที (Realtime)
-- ไม่มีผู้ใช้ที่ไม่ล็อกอิน (anon) เข้าถึงข้อมูลร้านได้อีก

-- ===== 1) ปิดทางของลูกค้า (anon) =====
drop policy if exists public_read_menu on menu_items;
drop policy if exists public_read_categories on menu_categories;
drop function if exists place_order(uuid, jsonb);
drop function if exists get_table_info(uuid);
drop function if exists get_order_status(uuid);

-- พนักงานทุกบทบาทในร้านอ่านเมนูและหมวดได้ (หน้ารับออเดอร์ หน้าครัว หน้าสต็อก)
drop policy if exists menu_items_crew_read on menu_items;
create policy menu_items_crew_read on menu_items for select using (is_staff_of(restaurant_id));
drop policy if exists menu_categories_crew_read on menu_categories;
create policy menu_categories_crew_read on menu_categories for select using (is_staff_of(restaurant_id));

-- ===== 2) ข้อมูลออเดอร์เพิ่มเติม =====
alter table orders add column if not exists order_type text not null default 'dine_in';
alter table orders drop constraint if exists orders_order_type_check;
alter table orders add constraint orders_order_type_check check (order_type in ('dine_in', 'takeaway'));
alter table orders add column if not exists customer_label text;   -- เช่น ชื่อ/เบอร์ลูกค้าที่สั่งกลับบ้าน
alter table orders drop constraint if exists orders_customer_label_check;
alter table orders add constraint orders_customer_label_check check (char_length(customer_label) <= 50);
alter table orders add column if not exists note text;              -- หมายเหตุทั้งออเดอร์ถึงครัว
alter table orders drop constraint if exists orders_note_check;
alter table orders add constraint orders_note_check check (char_length(note) <= 200);
alter table orders add column if not exists created_by uuid references auth.users(id) on delete set null;

-- ===== 3) ห้ามเขียนออเดอร์ตรงๆ ต้องผ่าน staff_place_order (ราคาจากฐานข้อมูลเสมอ) =====
-- เดิมหน้าร้านแก้คอลัมน์ total หรือราคาในรายการได้ ซึ่งทำให้ยอดบัญชีผิดได้
drop policy if exists orders_insert on orders;
drop policy if exists order_items_write on order_items;
revoke insert on orders from anon, authenticated;
revoke update on orders from anon, authenticated;
grant update (status) on orders to authenticated;            -- เปลี่ยนได้เฉพาะสถานะ (สิทธิ์รายบทบาทตาม policy orders_update)
revoke insert, update, delete on order_items from anon, authenticated;
revoke all on orders, order_items from anon;

-- ===== 4) พนักงานรับออเดอร์ =====
-- p_items: [{ "menu_item_id": uuid, "quantity": 1-50, "note": "ไม่เผ็ด" }]
-- ทานที่ร้านต้องระบุโต๊ะของร้านนี้ / กลับบ้านไม่มีโต๊ะ ใส่ชื่อลูกค้าได้
create or replace function staff_place_order(
  p_restaurant_id uuid,
  p_items jsonb,
  p_table_id uuid default null,
  p_order_type text default 'dine_in',
  p_customer_label text default null,
  p_note text default null
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order uuid;
  v_total numeric(10,2) := 0;
  v_item jsonb;
  v_menu menu_items%rowtype;
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

  insert into orders (restaurant_id, table_id, order_type, customer_label, note, created_by)
  values (p_restaurant_id, p_table_id, p_order_type,
          nullif(left(trim(p_customer_label), 50), ''), nullif(left(trim(p_note), 200), ''), auth.uid())
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

    v_total := v_total + v_menu.price * v_qty;
  end loop;

  update orders set total = v_total where id = v_order;
  return v_order;
end;
$$;

revoke execute on function staff_place_order(uuid, jsonb, uuid, text, text, text) from public, anon;
grant execute on function staff_place_order(uuid, jsonb, uuid, text, text, text) to authenticated;

-- ===== 5) Realtime ของเมนู: หน้ารับออเดอร์เห็นเมนูหมด/เปิดขายทันที =====
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'menu_items'
  ) then
    alter publication supabase_realtime add table menu_items;
  end if;
end;
$$;

-- ========================================================================
-- เดิม: 0008_order_status_rules.sql
-- ========================================================================

-- FoodFlow — migration 0008: บังคับลำดับสถานะออเดอร์
-- รันหลัง 0007_staff_ordering.sql
--
-- ปัญหาเดิม: policy ตรวจแค่ "ใครแก้ได้" ไม่ตรวจ "เปลี่ยนจากอะไรไปอะไร"
--   - หน้าร้านเปลี่ยนบิลที่ชำระแล้ว (paid) เป็นยกเลิกได้ → รายรับหายจากบัญชีโดยไม่มีร่องรอย
--   - ครัวย้อนสถานะได้ (served → received) และข้ามขั้นได้ (received → paid)
--
-- ลำดับที่อนุญาต
--   received  → preparing | cancelled
--   preparing → ready     | cancelled (เจ้าของเท่านั้น: ของถูกตัดสต็อกไปแล้ว)
--   ready     → served
--   served    → paid      | cancelled (เจ้าของเท่านั้น)
--   paid      → cancelled (เจ้าของเท่านั้น = ยกเลิกบิล ต้องระบุเหตุผล)
--   cancelled → (สถานะสุดท้าย)
-- ทุกการยกเลิกบันทึกผู้ยกเลิก เวลา และสถานะก่อนยกเลิก

alter table orders add column if not exists cancel_reason text;
alter table orders drop constraint if exists orders_cancel_reason_check;
alter table orders add constraint orders_cancel_reason_check check (char_length(cancel_reason) <= 200);
alter table orders add column if not exists cancelled_at timestamptz;
alter table orders add column if not exists cancelled_by uuid references auth.users(id) on delete set null;
alter table orders add column if not exists cancelled_from text;  -- สถานะก่อนยกเลิก (เช่น paid = ยกเลิกบิลที่ชำระแล้ว)

-- พนักงานแก้ได้เฉพาะสถานะและเหตุผลการยกเลิก
grant update (status, cancel_reason) on orders to authenticated;

create or replace function enforce_order_status()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  v_owner boolean := has_role(old.restaurant_id, array['owner']);
  v_ok boolean;
begin
  -- ระบบภายใน (ไม่มีผู้ใช้ล็อกอิน เช่น service role / SQL Editor) ไม่ถูกบังคับ
  if auth.uid() is null then
    return new;
  end if;

  if new.status is distinct from old.status then
    v_ok := case old.status::text
      when 'received'  then new.status::text in ('preparing', 'cancelled')
      when 'preparing' then new.status::text = 'ready' or (new.status::text = 'cancelled' and v_owner)
      when 'ready'     then new.status::text = 'served'
      when 'served'    then new.status::text = 'paid' or (new.status::text = 'cancelled' and v_owner)
      when 'paid'      then new.status::text = 'cancelled' and v_owner
      else false
    end;
    if not v_ok then
      raise exception 'invalid_status_change: % -> %', old.status, new.status;
    end if;

    if new.status = 'cancelled' then
      if old.status = 'paid' and coalesce(trim(new.cancel_reason), '') = '' then
        raise exception 'cancel_reason_required';
      end if;
      new.cancelled_at := now();
      new.cancelled_by := auth.uid();
      new.cancelled_from := old.status::text;
    end if;
  elsif new.cancel_reason is distinct from old.cancel_reason then
    raise exception 'cancel_reason_only_when_cancelling';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_enforce_status on orders;
create trigger orders_enforce_status
  before update on orders
  for each row execute function enforce_order_status();

-- ========================================================================
-- เดิม: 0009_manager_promotions.sql
-- ========================================================================

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

-- ========================================================================
-- เดิม: 0010_kitchen_item_done.sql
-- ========================================================================

-- FoodFlow — migration 0010: ครัวติ๊กเสร็จทีละเมนู
-- รันหลัง 0009_manager_promotions.sql
--
-- ในออเดอร์ที่ "กำลังทำ" ครัวแตะแต่ละเมนูเพื่อทำเครื่องหมายว่าเสร็จแล้ว (แตะอีกครั้ง = ยกเลิกเครื่องหมาย)
-- ใช้เป็นตัวช่วยของครัวเท่านั้น สถานะของทั้งออเดอร์ยังเปลี่ยนด้วยปุ่ม "ทำเสร็จ" ตามเดิม
-- order_items ยังแก้ตรงไม่ได้ (0007) ต้องผ่านฟังก์ชัน kitchen_set_item_done เท่านั้น

alter table order_items add column if not exists done_at timestamptz;

create or replace function kitchen_set_item_done(p_item_id uuid, p_done boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rid uuid;
  v_status order_status;
begin
  select o.restaurant_id, o.status into v_rid, v_status
  from order_items i join orders o on o.id = i.order_id
  where i.id = p_item_id;

  if v_rid is null or not has_role(v_rid, array['owner', 'staff', 'kitchen']) then
    raise exception 'forbidden';
  end if;
  if v_status <> 'preparing' then
    raise exception 'order_not_preparing';
  end if;

  update order_items
  set done_at = case when p_done then coalesce(done_at, now()) end
  where id = p_item_id;
end;
$$;

revoke execute on function kitchen_set_item_done(uuid, boolean) from public, anon;
grant execute on function kitchen_set_item_done(uuid, boolean) to authenticated;

-- เปิด Realtime ให้ order_items (ครัวหลายเครื่องเห็นเครื่องหมายเสร็จตรงกันทันที)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'order_items'
  ) then
    alter publication supabase_realtime add table order_items;
  end if;
end;
$$;

-- ========================================================================
-- เดิม: 0011_item_served.sql
-- ========================================================================

-- FoodFlow — migration 0011: ติ๊กเสิร์ฟแล้วทีละเมนู
-- รันหลัง 0010_kitchen_item_done.sql
--
-- ในออเดอร์ที่ "พร้อมเสิร์ฟ" พนักงานแตะแต่ละเมนูเมื่อยกไปเสิร์ฟแล้ว (แตะอีกครั้ง = ยกเลิกเครื่องหมาย)
-- เป็นตัวช่วยเหมือน 0010 สถานะของทั้งออเดอร์ยังเปลี่ยนด้วยปุ่ม "เสิร์ฟแล้ว" ตามเดิม
-- order_items ยังแก้ตรงไม่ได้ (0007) ต้องผ่านฟังก์ชัน set_item_served เท่านั้น

alter table order_items add column if not exists served_at timestamptz;

create or replace function set_item_served(p_item_id uuid, p_served boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rid uuid;
  v_status order_status;
begin
  select o.restaurant_id, o.status into v_rid, v_status
  from order_items i join orders o on o.id = i.order_id
  where i.id = p_item_id;

  if v_rid is null or not has_role(v_rid, array['owner', 'staff', 'kitchen']) then
    raise exception 'forbidden';
  end if;
  if v_status <> 'ready' then
    raise exception 'order_not_ready';
  end if;

  update order_items
  set served_at = case when p_served then coalesce(served_at, now()) end
  where id = p_item_id;
end;
$$;

revoke execute on function set_item_served(uuid, boolean) from public, anon;
grant execute on function set_item_served(uuid, boolean) to authenticated;

-- ========================================================================
-- เดิม: 0012_promotion_rules.sql
-- ========================================================================

-- FoodFlow — migration 0012: กฎวันที่ของโปร + จำกัดจำนวนครั้ง + ใช้หลายโปรพร้อมกัน + เลือกโปรตอนรับชำระ
-- รันหลัง 0011_item_served.sql (รันซ้ำได้)
--
-- 1) วันที่: ตั้งวันเริ่ม/วันสิ้นสุดย้อนหลังกว่าวันนี้ (เวลาร้าน) ไม่ได้ · วันสิ้นสุดต้องไม่ก่อนวันเริ่ม (มีตั้งแต่ 0009)
--    ตรวจเฉพาะตอนสร้าง หรือตอนแก้ค่าวันที่ (แก้ชื่อโปรเก่าที่เริ่มไปแล้วได้ตามปกติ)
-- 2) จำนวนครั้ง: max_uses (ว่าง = ไม่จำกัด) นับ 1 ครั้งต่อการใช้ 1 ครั้ง
--    (ตอนรับออเดอร์ = 1 ออเดอร์, ตอนรับชำระ = 1 บิลทั้งโต๊ะ) ออเดอร์ที่ถูกยกเลิกหมดแล้วคืนสิทธิ์ให้
-- 3) ใช้หลายโปรพร้อมกันได้ ถ้าเงื่อนไขไม่ทับกัน
--    - โปรรายเมนู: รวมกันได้ถ้าเมนูที่ร่วมโปรในบิลไม่ซ้ำกัน (เมนูเดียวลดได้โปรเดียว)
--    - โปรทั้งบิล: ใช้ได้ทีละ 1 โปร คิดจากยอดที่เหลือหลังหักโปรรายเมนูแล้ว
--    - ซื้อขั้นต่ำ: เทียบกับยอดก่อนลด
-- 4) หน้ารับชำระเลือกโปรให้ทั้งบิลได้ (counter_pay_bill) แทนที่โปรที่ใส่ไว้ตอนรับออเดอร์ของบิลนั้น
-- ส่วนลดของแต่ละโปรถูกกระจายลงแต่ละออเดอร์ (order_promotions) และรวมไว้ที่ orders.discount_total เหมือนเดิม

-- ===== 1) วันที่ =====
create or replace function enforce_promotion_dates()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  v_today date;
begin
  -- ระบบภายใน (service role / SQL Editor) ไม่ถูกบังคับ
  if auth.uid() is null then
    return new;
  end if;
  select (now() at time zone r.timezone)::date into v_today from restaurants r where r.id = new.restaurant_id;

  if new.starts_on is not null
     and (tg_op = 'INSERT' or new.starts_on is distinct from old.starts_on)
     and new.starts_on < v_today then
    raise exception 'promotion_start_in_past';
  end if;
  if new.ends_on is not null
     and (tg_op = 'INSERT' or new.ends_on is distinct from old.ends_on)
     and new.ends_on < v_today then
    raise exception 'promotion_end_in_past';
  end if;
  return new;
end;
$$;

drop trigger if exists promotions_enforce_dates on promotions;
create trigger promotions_enforce_dates
  before insert or update on promotions
  for each row execute function enforce_promotion_dates();

-- ===== 2) จำนวนครั้ง + การใช้โปรในออเดอร์ =====
alter table promotions add column if not exists max_uses int;
alter table promotions drop constraint if exists promotions_max_uses_check;
alter table promotions add constraint promotions_max_uses_check check (max_uses is null or max_uses between 1 and 1000000);

-- 1 แถว = ใช้โปร 1 ครั้ง (1 ออเดอร์ตอนรับออเดอร์ หรือ 1 บิลตอนรับชำระ)
create table if not exists promotion_uses (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references promotions(id),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  used_at timestamptz not null default now(),
  used_by uuid references auth.users(id) on delete set null
);
create index if not exists promotion_uses_promotion_idx on promotion_uses (promotion_id);

-- ส่วนลดของแต่ละโปรในแต่ละออเดอร์ (ออเดอร์หนึ่งมีได้หลายโปร)
create table if not exists order_promotions (
  order_id uuid not null references orders(id) on delete cascade,
  promotion_id uuid not null references promotions(id),
  promotion_use_id uuid not null references promotion_uses(id),
  discount numeric(10,2) not null check (discount >= 0),
  primary key (order_id, promotion_id)
);
create index if not exists order_promotions_use_idx on order_promotions (promotion_use_id);

alter table promotion_uses enable row level security;
alter table order_promotions enable row level security;
drop policy if exists promotion_uses_read on promotion_uses;
create policy promotion_uses_read on promotion_uses for select using (is_staff_of(restaurant_id));
drop policy if exists order_promotions_read on order_promotions;
create policy order_promotions_read on order_promotions for select
  using (exists (select 1 from orders o where o.id = order_id and is_staff_of(o.restaurant_id)));
revoke all on promotion_uses, order_promotions from anon;
revoke insert, update, delete on promotion_uses, order_promotions from authenticated;

-- จำนวนครั้งที่ใช้ไปแล้ว (นับเฉพาะการใช้ที่ยังมีออเดอร์ไม่ถูกยกเลิก)
create or replace function promotion_uses_count(p_promotion_id uuid)
returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::int from promotion_uses u
  where u.promotion_id = p_promotion_id
    and exists (select 1 from order_promotions op join orders o on o.id = op.order_id
                where op.promotion_use_id = u.id and o.status <> 'cancelled');
$$;
revoke execute on function promotion_uses_count(uuid) from public, anon;
grant execute on function promotion_uses_count(uuid) to authenticated;

-- จำนวนครั้งที่ใช้ของทุกโปรในร้าน (หน้าจัดการโปร)
create or replace function promotion_usage(p_restaurant_id uuid)
returns table (promotion_id uuid, used int)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.id, promotion_uses_count(p.id)
  from promotions p
  where p.restaurant_id = p_restaurant_id and is_staff_of(p_restaurant_id);
$$;
revoke execute on function promotion_usage(uuid) from public, anon;
grant execute on function promotion_usage(uuid) to authenticated;

-- ใช้ได้ตอนนี้ = เงื่อนไขเดิม + ยังไม่ครบจำนวนครั้ง
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
     and (p.max_uses is null or promotion_uses_count(p.id) < p.max_uses)
  from t;
$$;

-- ===== 3) คำนวณและบันทึกโปรของกลุ่มออเดอร์ (ใช้ภายใน ไม่เปิดให้เรียกตรง) =====
-- แทนที่โปรเดิมของออเดอร์เหล่านี้ทั้งหมด (คืนสิทธิ์โปรเดิม) แล้วใช้ชุดโปรใหม่ · คืนค่าส่วนลดรวม
create or replace function apply_promotions(p_restaurant_id uuid, p_order_ids uuid[], p_promotion_ids uuid[])
returns numeric
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ids uuid[];
  v_prev uuid[];
  v_pid uuid;
  v_promo promotions%rowtype;
  v_subtotal numeric(10,2);
  v_bill_count int := 0;
  v_elig numeric(10,2);
  v_disc numeric(10,2);
  v_last uuid;
  v_use uuid;
  p record;
begin
  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(coalesce(p_promotion_ids, '{}')) x where x is not null;
  if cardinality(v_ids) > 10 then
    raise exception 'too_many_promotions';
  end if;

  -- โปรที่บิลนี้ได้ไปแล้วตอนรับออเดอร์ ยังใช้ต่อได้แม้หมดช่วงเวลา/ปิดไปแล้ว (ลูกค้าได้สิทธิ์ไปแล้ว)
  select coalesce(array_agg(distinct promotion_id), '{}') into v_prev from order_promotions where order_id = any (p_order_ids);

  -- ถอดโปรเดิม (คืนสิทธิ์) ก่อนตรวจว่าโปรที่เลือกยังใช้ได้
  delete from order_promotions where order_id = any (p_order_ids);
  update orders set promotion_id = null where id = any (p_order_ids);

  drop table if exists ap_orders;
  create temp table ap_orders on commit drop as
  select oi.order_id, sum(oi.quantity * oi.unit_price)::numeric(10,2) as subtotal
  from order_items oi where oi.order_id = any (p_order_ids) group by oi.order_id;
  select coalesce(sum(subtotal), 0) into v_subtotal from ap_orders;

  drop table if exists ap_lines;
  create temp table ap_lines on commit drop as
  select oi.order_id, oi.menu_item_id, (oi.quantity * oi.unit_price)::numeric(10,2) as amount, null::uuid as promo
  from order_items oi where oi.order_id = any (p_order_ids);

  drop table if exists ap_promos;
  create temp table ap_promos (promotion_id uuid, is_bill boolean, discount_type text, value numeric, eligible numeric(10,2), discount numeric(10,2)) on commit drop;
  drop table if exists ap_alloc;
  create temp table ap_alloc (order_id uuid, promotion_id uuid, base numeric(10,2), share numeric(10,2) not null default 0) on commit drop;

  -- ตรวจทุกโปร (ล็อกแถวโปร กันใช้ครั้งสุดท้ายพร้อมกันสองเครื่อง)
  for v_pid in select x from unnest(v_ids) x order by x loop
    select * into v_promo from promotions where id = v_pid and restaurant_id = p_restaurant_id for update;
    if not found or not (v_pid = any (v_prev) or promotion_is_live(v_promo)) then
      raise exception 'promotion_not_available';
    end if;
    if v_subtotal < v_promo.min_subtotal then
      raise exception 'promotion_min_subtotal: %', v_promo.min_subtotal;
    end if;

    if exists (select 1 from promotion_items pi where pi.promotion_id = v_pid) then
      -- โปรรายเมนู: เมนูในบิลที่ร่วมโปรนี้ต้องยังไม่ถูกโปรอื่นใช้
      if exists (select 1 from ap_lines l join promotion_items pi on pi.promotion_id = v_pid and pi.menu_item_id = l.menu_item_id
                 where l.promo is not null) then
        raise exception 'promotion_conflict';
      end if;
      update ap_lines l set promo = v_pid
       where exists (select 1 from promotion_items pi where pi.promotion_id = v_pid and pi.menu_item_id = l.menu_item_id);
      select coalesce(sum(amount), 0) into v_elig from ap_lines where promo = v_pid;
      if v_elig = 0 then
        raise exception 'promotion_no_eligible_items';
      end if;
      insert into ap_promos values (v_pid, false, v_promo.discount_type, v_promo.value, v_elig, null);
      insert into ap_alloc (order_id, promotion_id, base)
      select order_id, v_pid, sum(amount) from ap_lines where promo = v_pid group by order_id;
    else
      v_bill_count := v_bill_count + 1;
      if v_bill_count > 1 then
        raise exception 'promotion_conflict';
      end if;
      insert into ap_promos values (v_pid, true, v_promo.discount_type, v_promo.value, null, null);
    end if;
  end loop;

  -- คำนวณส่วนลด: รายเมนูก่อน แล้วโปรทั้งบิลจากยอดที่เหลือ · กระจายลงแต่ละออเดอร์ (ปัดลง เศษไปออเดอร์ฐานใหญ่สุด)
  for p in select * from ap_promos order by is_bill, promotion_id loop
    if p.is_bill then
      insert into ap_alloc (order_id, promotion_id, base)
      select o.order_id, p.promotion_id,
             o.subtotal - coalesce((select sum(a.share) from ap_alloc a where a.order_id = o.order_id), 0)
      from ap_orders o;
      select coalesce(sum(base), 0) into v_elig from ap_alloc where promotion_id = p.promotion_id;
      if v_elig <= 0 then
        raise exception 'promotion_no_eligible_items';
      end if;
    else
      v_elig := p.eligible;
    end if;

    v_disc := case p.discount_type
      when 'percent' then round(v_elig * p.value / 100, 2)
      else least(p.value, v_elig)
    end;
    update ap_promos set eligible = v_elig, discount = v_disc where promotion_id = p.promotion_id;

    select order_id into v_last from ap_alloc where promotion_id = p.promotion_id order by base desc, order_id limit 1;
    update ap_alloc set share = trunc(v_disc * base / v_elig, 2)
     where promotion_id = p.promotion_id and order_id <> v_last;
    update ap_alloc set share = least(base, v_disc - coalesce(
             (select sum(a.share) from ap_alloc a where a.promotion_id = p.promotion_id and a.order_id <> v_last), 0))
     where promotion_id = p.promotion_id and order_id = v_last;
  end loop;

  -- บันทึกการใช้ (1 ครั้งต่อโปร) และส่วนลดรายออเดอร์
  for p in select * from ap_promos loop
    insert into promotion_uses (promotion_id, restaurant_id, used_by)
    values (p.promotion_id, p_restaurant_id, auth.uid())
    returning id into v_use;
    insert into order_promotions (order_id, promotion_id, promotion_use_id, discount)
    select order_id, p.promotion_id, v_use, share from ap_alloc where promotion_id = p.promotion_id;
  end loop;

  update orders o
     set subtotal = x.subtotal,
         discount_total = coalesce(d.discount, 0),
         total = x.subtotal - coalesce(d.discount, 0),
         -- โปรหลักของออเดอร์ (ส่วนลดมากสุด) ไว้แสดงผลแบบเดิม
         promotion_id = (select op.promotion_id from order_promotions op where op.order_id = o.id
                         order by op.discount desc, op.promotion_id limit 1)
    from ap_orders x
    left join (select order_id, sum(share) as discount from ap_alloc group by order_id) d on d.order_id = x.order_id
   where o.id = x.order_id;

  return (select coalesce(sum(discount), 0) from ap_promos);
end;
$$;
revoke execute on function apply_promotions(uuid, uuid[], uuid[]) from public, anon, authenticated;

-- ===== รับออเดอร์ (เหมือน 0009 แต่รับได้หลายโปร) =====
drop function if exists staff_place_order(uuid, jsonb, uuid, text, text, text, uuid);
create or replace function staff_place_order(
  p_restaurant_id uuid,
  p_items jsonb,
  p_table_id uuid default null,
  p_order_type text default 'dine_in',
  p_customer_label text default null,
  p_note text default null,
  p_promotion_ids uuid[] default null
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order uuid;
  v_subtotal numeric(10,2) := 0;
  v_item jsonb;
  v_menu menu_items%rowtype;
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

  insert into orders (restaurant_id, table_id, order_type, customer_label, note, created_by)
  values (p_restaurant_id, p_table_id, p_order_type,
          nullif(left(trim(p_customer_label), 50), ''), nullif(left(trim(p_note), 200), ''), auth.uid())
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

  update orders set subtotal = v_subtotal, discount_total = 0, total = v_subtotal where id = v_order;
  if coalesce(cardinality(p_promotion_ids), 0) > 0 then
    perform apply_promotions(p_restaurant_id, array[v_order], p_promotion_ids);
  end if;
  return v_order;
end;
$$;

revoke execute on function staff_place_order(uuid, jsonb, uuid, text, text, text, uuid[]) from public, anon;
grant execute on function staff_place_order(uuid, jsonb, uuid, text, text, text, uuid[]) to authenticated;

-- ===== 4) รับชำระทั้งบิล พร้อมเลือกโปร =====
-- p_order_ids = ออเดอร์ทั้งหมดในบิล (ต้องเสิร์ฟแล้วทุกใบ)
-- p_promotion_ids: ว่าง (null) = ใช้ส่วนลดเดิมจากตอนรับออเดอร์ · ระบุ = แทนที่ด้วยชุดนี้ทั้งบิล ({} = ไม่ใช้โปร)
drop function if exists counter_pay_bill(uuid, uuid[], uuid);
create or replace function counter_pay_bill(
  p_restaurant_id uuid,
  p_order_ids uuid[],
  p_promotion_ids uuid[] default null
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_count int;
begin
  if not has_role(p_restaurant_id, array['owner', 'staff']) then
    raise exception 'forbidden';
  end if;
  if p_order_ids is null or cardinality(p_order_ids) = 0 or cardinality(p_order_ids) > 50 then
    raise exception 'invalid_orders';
  end if;

  -- ล็อกออเดอร์ในบิล กันกดรับชำระซ้ำจากสองเครื่อง
  perform 1 from orders where id = any (p_order_ids) for update;
  select count(*) into v_count from orders
   where id = any (p_order_ids) and restaurant_id = p_restaurant_id and status = 'served';
  if v_count <> cardinality(p_order_ids) then
    raise exception 'bill_not_ready';
  end if;

  if p_promotion_ids is not null then
    perform apply_promotions(p_restaurant_id, p_order_ids, p_promotion_ids);
  end if;

  update orders set status = 'paid' where id = any (p_order_ids);

  return (
    select jsonb_build_object(
      'subtotal', coalesce(sum(coalesce(subtotal, total + discount_total)), 0),
      'discount', coalesce(sum(discount_total), 0),
      'total', coalesce(sum(total), 0)
    )
    from orders where id = any (p_order_ids)
  );
end;
$$;

revoke execute on function counter_pay_bill(uuid, uuid[], uuid[]) from public, anon;
grant execute on function counter_pay_bill(uuid, uuid[], uuid[]) to authenticated;
