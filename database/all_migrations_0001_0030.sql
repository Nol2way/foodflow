-- Plato: migrations 0001-0030 รวมเป็นไฟล์เดียว (สร้างจาก database/migrations/ · แก้ที่ไฟล์ต้นฉบับ ไม่ใช่ไฟล์นี้)
-- รันครั้งเดียวบนฐานข้อมูลว่าง หลังคำสั่ง GRANT ของ schema public แล้วค่อยรัน seed


-- ======================================================================
-- 0001_schema.sql
-- ======================================================================
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


-- ======================================================================
-- 0002_customer_ordering.sql
-- ======================================================================
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


-- ======================================================================
-- 0003_roles.sql
-- ======================================================================
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


-- ======================================================================
-- 0004_stock_costs_analytics.sql
-- ======================================================================
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


-- ======================================================================
-- 0005_import_and_hardening.sql
-- ======================================================================
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


-- ======================================================================
-- 0006_accounting_summary.sql
-- ======================================================================
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


-- ======================================================================
-- 0007_staff_ordering.sql
-- ======================================================================
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


-- ======================================================================
-- 0008_order_status_rules.sql
-- ======================================================================
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


-- ======================================================================
-- 0009_manager_promotions.sql
-- ======================================================================
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


-- ======================================================================
-- 0010_kitchen_item_done.sql
-- ======================================================================
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


-- ======================================================================
-- 0011_item_served.sql
-- ======================================================================
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


-- ======================================================================
-- 0012_promotion_rules.sql
-- ======================================================================
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


-- ======================================================================
-- 0013_display_magazine.sql
-- ======================================================================
-- 0013: จอแสดงผล iPad แบบแมกกาซีน (เมนูแนะนำ + โปรโมชันที่ใช้ได้ตอนนี้)
-- เปิดผ่านลิงก์ลับของร้าน ไม่ต้องล็อกอิน · เห็นแค่เนื้อหาบนสไลด์ ไม่เห็นข้อมูลอื่นของร้าน

-- ===== 1) ข้อมูลเมนูสำหรับโชว์ =====
alter table menu_items add column if not exists is_recommended boolean not null default false;
alter table menu_items add column if not exists description text;
alter table menu_items add column if not exists media_path text;   -- path ใน storage bucket 'menu-media'
alter table menu_items add column if not exists media_type text;

alter table menu_items drop constraint if exists menu_items_description_len;
alter table menu_items add constraint menu_items_description_len check (char_length(description) <= 200);
alter table menu_items drop constraint if exists menu_items_media_type_check;
alter table menu_items add constraint menu_items_media_type_check
  check (media_type in ('image', 'video') and media_path is not null or media_type is null);

-- ===== 2) ลิงก์ลับของจอแสดงผล (ร้านละ 1 ลิงก์) =====
-- แยกตารางเพื่อไม่ให้พนักงานทุกคนอ่านโทเค็นได้จากตาราง restaurants
create table if not exists display_screens (
  restaurant_id uuid primary key references restaurants(id) on delete cascade,
  token text not null unique,
  created_at timestamptz not null default now()
);
alter table display_screens enable row level security;
drop policy if exists display_screens_read on display_screens;
create policy display_screens_read on display_screens for select
  using (has_role(restaurant_id, array['owner', 'manager']));
-- เขียนผ่านฟังก์ชันด้านล่างเท่านั้น
revoke insert, update, delete on display_screens from anon, authenticated;

-- สร้างใหม่/เปลี่ยนลิงก์ (ลิงก์เก่าใช้ไม่ได้ทันที)
create or replace function display_rotate_token(p_restaurant_id uuid)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_token text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  if not has_role(p_restaurant_id, array['owner', 'manager']) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into display_screens(restaurant_id, token) values (p_restaurant_id, v_token)
  on conflict (restaurant_id) do update set token = excluded.token, created_at = now();
  return v_token;
end;
$$;

create or replace function display_disable(p_restaurant_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'manager']) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from display_screens where restaurant_id = p_restaurant_id;
end;
$$;

revoke execute on function display_rotate_token(uuid) from public, anon;
revoke execute on function display_disable(uuid) from public, anon;
grant execute on function display_rotate_token(uuid) to authenticated;
grant execute on function display_disable(uuid) to authenticated;

-- ===== 3) เนื้อหาบนจอ (เรียกได้โดยไม่ล็อกอิน แต่ต้องมีโทเค็นที่ถูกต้อง) =====
-- คืน null ถ้าโทเค็นผิดหรือถูกปิดแล้ว · เมนูที่หมดจะไม่ขึ้นจอ
create or replace function display_content(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_rid uuid;
begin
  if p_token is null or length(p_token) < 32 then
    return null;
  end if;
  select restaurant_id into v_rid from display_screens where token = p_token;
  if v_rid is null then
    return null;
  end if;

  return jsonb_build_object(
    'restaurant', (select name from restaurants where id = v_rid),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'name', m.name, 'price', m.price, 'description', m.description,
               'media_path', m.media_path, 'media_type', m.media_type, 'category', c.name)
             order by c.sort_order nulls last, m.name)
      from menu_items m
      left join menu_categories c on c.id = m.category_id
      where m.restaurant_id = v_rid and m.is_recommended and m.is_available
    ), '[]'::jsonb),
    'promotions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'discount_type', p.discount_type, 'value', p.value,
               'min_subtotal', p.min_subtotal, 'ends_on', p.ends_on,
               'start_time', p.start_time, 'end_time', p.end_time,
               'items', coalesce((
                 select jsonb_agg(jsonb_build_object('name', m.name, 'media_path', m.media_path, 'media_type', m.media_type)
                                  order by m.name)
                 from promotion_items pi join menu_items m on m.id = pi.menu_item_id
                 where pi.promotion_id = p.id and m.is_available
               ), '[]'::jsonb))
             order by p.name)
      from promotions p
      where p.restaurant_id = v_rid and promotion_is_live(p)
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function display_content(text) from public;
grant execute on function display_content(text) to anon, authenticated;

-- ===== 4) ที่เก็บรูป/วิดีโอเมนู (Supabase Storage) =====
-- โฟลเดอร์แรกของไฟล์ต้องเป็น restaurant_id เช่น '<restaurant_id>/<menu_id>-123.jpg'
create or replace function can_manage_menu_media(p_name text)
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return has_role(split_part(p_name, '/', 1)::uuid, array['owner', 'manager']);
exception when invalid_text_representation then
  return false;
end;
$$;
revoke execute on function can_manage_menu_media(text) from public, anon;
grant execute on function can_manage_menu_media(text) to authenticated;

-- ข้ามส่วนนี้ถ้าไม่มี schema storage (เช่น Postgres ทดสอบในเครื่อง)
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    -- อ่านได้สาธารณะ (รูปเมนูไม่ใช่ข้อมูลลับ) · จำกัด 50 MB และเฉพาะรูป/วิดีโอ
    execute $q$
      insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('menu-media', 'menu-media', true, 52428800, array['image/*', 'video/*'])
      on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types
    $q$;
    execute 'drop policy if exists menu_media_select on storage.objects';
    execute 'drop policy if exists menu_media_insert on storage.objects';
    execute 'drop policy if exists menu_media_update on storage.objects';
    execute 'drop policy if exists menu_media_delete on storage.objects';
    -- Storage ต้องมีสิทธิ์ select ด้วยจึงจะลบ/เขียนทับไฟล์ได้
    execute $q$
      create policy menu_media_select on storage.objects for select to authenticated
      using (bucket_id = 'menu-media' and public.can_manage_menu_media(name))
    $q$;
    execute $q$
      create policy menu_media_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'menu-media' and public.can_manage_menu_media(name))
    $q$;
    execute $q$
      create policy menu_media_update on storage.objects for update to authenticated
      using (bucket_id = 'menu-media' and public.can_manage_menu_media(name))
      with check (bucket_id = 'menu-media' and public.can_manage_menu_media(name))
    $q$;
    execute $q$
      create policy menu_media_delete on storage.objects for delete to authenticated
      using (bucket_id = 'menu-media' and public.can_manage_menu_media(name))
    $q$;
  end if;
end;
$$;


-- ======================================================================
-- 0014_display_media.sql
-- ======================================================================
-- 0014: สื่อบนจอแสดงผล iPad
--   - เมนูหนึ่งมีได้หลายรูป/วิดีโอ (วนเปลี่ยนทุกรอบที่จอเล่นครบ)
--   - ใส่เป็นลิงก์ได้ (ไฟล์รูป/วิดีโอ https หรือ YouTube) นอกจากอัปโหลดไฟล์
--   - สไลด์โฆษณาร้าน (สื่อที่ไม่ผูกกับเมนู เช่น คลิปบรรยากาศร้าน)
-- แทนคอลัมน์ menu_items.media_path / media_type จาก 0013 (ย้ายข้อมูลเดิมมาให้)

create table if not exists display_media (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  menu_item_id uuid references menu_items(id) on delete cascade,  -- ว่าง = สไลด์โฆษณาร้าน
  kind text not null check (kind in ('image', 'video', 'youtube')),
  storage_path text,   -- ไฟล์ที่อัปโหลดใน bucket 'menu-media'
  url text,            -- หรือลิงก์ภายนอก
  title text check (char_length(title) <= 80),
  caption text check (char_length(caption) <= 200),
  credit text check (char_length(credit) <= 120),     -- เครดิตเจ้าของภาพ/คลิป (สัญญาอนุญาตบางแบบบังคับ)
  duration_sec int check (duration_sec between 5 and 120),  -- ว่าง = อัตโนมัติ
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check ((storage_path is null) <> (url is null)),
  check (storage_path is null or (kind <> 'youtube' and split_part(storage_path, '/', 1) = restaurant_id::text)),
  check (url is null or url ~ '^https://[^[:space:]]+$'),
  check (kind <> 'youtube' or url ~ '^https://www\.youtube\.com/watch\?v=[A-Za-z0-9_-]{11}$'),
  check (char_length(url) <= 1000)
);
create index if not exists display_media_restaurant_idx on display_media (restaurant_id);
create index if not exists display_media_item_idx on display_media (menu_item_id);

alter table display_media enable row level security;
drop policy if exists display_media_read on display_media;
create policy display_media_read on display_media for select
  using (has_role(restaurant_id, array['owner', 'manager']));
drop policy if exists display_media_write on display_media;
create policy display_media_write on display_media for all
  using (has_role(restaurant_id, array['owner', 'manager']))
  with check (
    has_role(restaurant_id, array['owner', 'manager'])
    and (menu_item_id is null or exists (
      select 1 from menu_items m where m.id = menu_item_id and m.restaurant_id = display_media.restaurant_id))
  );

-- ===== ย้ายสื่อเดิมจาก 0013 =====
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'menu_items' and column_name = 'media_path') then
    execute $q$
      insert into display_media (restaurant_id, menu_item_id, kind, storage_path)
      select restaurant_id, id, media_type, media_path from menu_items
      where media_path is not null and media_type in ('image', 'video')
        and split_part(media_path, '/', 1) = restaurant_id::text
    $q$;
  end if;
end;
$$;
alter table menu_items drop column if exists media_path;
alter table menu_items drop column if exists media_type;

-- ===== เนื้อหาบนจอ (แทนของ 0013) =====
create or replace function display_media_json(d display_media)
returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('id', d.id, 'kind', d.kind, 'path', d.storage_path, 'url', d.url,
    'title', d.title, 'caption', d.caption, 'credit', d.credit, 'duration_sec', d.duration_sec);
$$;

create or replace function display_content(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_rid uuid;
begin
  if p_token is null or length(p_token) < 32 then
    return null;
  end if;
  select restaurant_id into v_rid from display_screens where token = p_token;
  if v_rid is null then
    return null;
  end if;

  return jsonb_build_object(
    'restaurant', (select name from restaurants where id = v_rid),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'name', m.name, 'price', m.price, 'description', m.description, 'category', c.name,
               'media', coalesce((
                 select jsonb_agg(display_media_json(d) order by d.sort_order, d.created_at)
                 from display_media d where d.menu_item_id = m.id and d.is_active
               ), '[]'::jsonb))
             order by c.sort_order nulls last, m.name)
      from menu_items m
      left join menu_categories c on c.id = m.category_id
      where m.restaurant_id = v_rid and m.is_recommended and m.is_available
    ), '[]'::jsonb),
    'promotions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'discount_type', p.discount_type, 'value', p.value,
               'min_subtotal', p.min_subtotal, 'ends_on', p.ends_on,
               'start_time', p.start_time, 'end_time', p.end_time,
               'items', coalesce((
                 select jsonb_agg(jsonb_build_object('name', m.name, 'image', (
                          select display_media_json(d) from display_media d
                          where d.menu_item_id = m.id and d.is_active and d.kind = 'image'
                          order by d.sort_order, d.created_at limit 1))
                        order by m.name)
                 from promotion_items pi join menu_items m on m.id = pi.menu_item_id
                 where pi.promotion_id = p.id and m.is_available
               ), '[]'::jsonb))
             order by p.name)
      from promotions p
      where p.restaurant_id = v_rid and promotion_is_live(p)
    ), '[]'::jsonb),
    'ads', coalesce((
      select jsonb_agg(display_media_json(d) order by d.sort_order, d.created_at)
      from display_media d where d.restaurant_id = v_rid and d.menu_item_id is null and d.is_active
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function display_content(text) from public;
grant execute on function display_content(text) to anon, authenticated;


-- ======================================================================
-- 0015_display_customize.sql
-- ======================================================================
-- 0015: ปรับแต่งจอแสดงผล iPad
--   - โปสเตอร์จากเทมเพลต: เก็บค่าที่ใช้สร้าง (display_media.poster) เพื่อเปิดมาแก้ต่อได้
--   - ตั้งค่าหน้าตาจอต่อร้าน (สี ธีม ฟอนต์ เวลาต่อสไลด์ ฯลฯ) ใน display_settings
-- ค่าต่างๆ ตรวจรูปแบบละเอียดที่หน้าเว็บ (normalizeSettings) ฐานข้อมูลตรวจแค่ชนิดและขนาด

alter table display_media add column if not exists poster jsonb;
alter table display_media drop constraint if exists display_media_poster_check;
alter table display_media add constraint display_media_poster_check
  check (poster is null or (jsonb_typeof(poster) = 'object' and pg_column_size(poster) <= 8000 and kind = 'image'));

create table if not exists display_settings (
  restaurant_id uuid primary key references restaurants(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb
    check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) <= 4000),
  updated_at timestamptz not null default now()
);
alter table display_settings enable row level security;
drop policy if exists display_settings_owner on display_settings;
create policy display_settings_owner on display_settings for all
  using (has_role(restaurant_id, array['owner', 'manager']))
  with check (has_role(restaurant_id, array['owner', 'manager']));

-- ===== เนื้อหาบนจอ + การตั้งค่า (แทนของ 0014) =====
create or replace function display_content(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_rid uuid;
begin
  if p_token is null or length(p_token) < 32 then
    return null;
  end if;
  select restaurant_id into v_rid from display_screens where token = p_token;
  if v_rid is null then
    return null;
  end if;

  return jsonb_build_object(
    'restaurant', (select name from restaurants where id = v_rid),
    'settings', coalesce((select settings from display_settings where restaurant_id = v_rid), '{}'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'name', m.name, 'price', m.price, 'description', m.description, 'category', c.name,
               'media', coalesce((
                 select jsonb_agg(display_media_json(d) order by d.sort_order, d.created_at)
                 from display_media d where d.menu_item_id = m.id and d.is_active
               ), '[]'::jsonb))
             order by c.sort_order nulls last, m.name)
      from menu_items m
      left join menu_categories c on c.id = m.category_id
      where m.restaurant_id = v_rid and m.is_recommended and m.is_available
    ), '[]'::jsonb),
    'promotions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'discount_type', p.discount_type, 'value', p.value,
               'min_subtotal', p.min_subtotal, 'ends_on', p.ends_on,
               'start_time', p.start_time, 'end_time', p.end_time,
               'items', coalesce((
                 select jsonb_agg(jsonb_build_object('name', m.name, 'image', (
                          select display_media_json(d) from display_media d
                          where d.menu_item_id = m.id and d.is_active and d.kind = 'image'
                          order by d.sort_order, d.created_at limit 1))
                        order by m.name)
                 from promotion_items pi join menu_items m on m.id = pi.menu_item_id
                 where pi.promotion_id = p.id and m.is_available
               ), '[]'::jsonb))
             order by p.name)
      from promotions p
      where p.restaurant_id = v_rid and promotion_is_live(p)
    ), '[]'::jsonb),
    'ads', coalesce((
      select jsonb_agg(display_media_json(d) order by d.sort_order, d.created_at)
      from display_media d where d.restaurant_id = v_rid and d.menu_item_id is null and d.is_active
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function display_content(text) from public;
grant execute on function display_content(text) to anon, authenticated;


-- ======================================================================
-- 0016_manager_accounting.sql
-- ======================================================================
-- 0016: ผู้จัดการดูบัญชีได้ (อ่านอย่างเดียว)
--   - เรียกสรุปบัญชี (accounting_summary) ได้
--   - เห็นรายการรายจ่าย แต่บันทึก/แก้/ลบรายจ่ายไม่ได้ (ยังเป็นสิทธิ์ของเจ้าของและพนักงานบัญชี)
--   - เห็นวัตถุดิบและสูตร (อ่านอย่างเดียว) เพื่อให้ตารางต้นทุนต่อเมนูในหน้าบัญชีคำนวณได้

drop policy if exists expenses_manager_read on expenses;
create policy expenses_manager_read on expenses for select
  using (has_role(restaurant_id, array['manager']));

drop policy if exists ingredients_manager_read on ingredients;
create policy ingredients_manager_read on ingredients for select
  using (has_role(restaurant_id, array['manager']));

drop policy if exists recipes_manager_read on recipes;
create policy recipes_manager_read on recipes for select
  using (exists (
    select 1 from menu_items m
    where m.id = menu_item_id and has_role(m.restaurant_id, array['manager'])
  ));

-- ===== สรุปบัญชี (แทนของ 0009: เพิ่ม manager) =====
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
  if not has_role(p_restaurant_id, array['owner', 'accountant', 'manager']) then
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


-- ======================================================================
-- 0017_payment_loyalty.sql
-- ======================================================================
-- 0017: รับชำระด้วย QR พร้อมเพย์ + ใบเสร็จ + สะสมแต้มสมาชิก
--   - shop_settings: พร้อมเพย์ ข้อความหัว/ท้ายใบเสร็จ กติกาแต้ม (ปิดแต้มได้ทั้งระบบด้วย loyalty_enabled)
--   - members + point_ledger: สมาชิกระบุด้วยเบอร์โทร แต้มเปลี่ยนผ่านฟังก์ชันเท่านั้น มีประวัติทุกครั้ง
--   - counter_pay_bill: เพิ่มวิธีชำระ สมาชิก และแลกแต้ม (คิดหลังหักโปรแล้ว)
--   - ยกเลิกบิลที่ชำระแล้ว: คืนแต้มที่แลกไป และหักแต้มที่ได้จากบิลนั้น

-- ===== 1) ตั้งค่าร้าน =====
create table if not exists shop_settings (
  restaurant_id uuid primary key references restaurants(id) on delete cascade,
  promptpay_id text check (promptpay_id ~ '^([0-9]{10}|[0-9]{13}|[0-9]{15})$'),  -- เบอร์มือถือ / เลขบัตร ปชช. หรือเลขผู้เสียภาษี / e-Wallet
  receipt_header text check (char_length(receipt_header) <= 300),  -- ที่อยู่ เบอร์โทร เลขผู้เสียภาษี
  receipt_footer text check (char_length(receipt_footer) <= 200),  -- เช่น ขอบคุณที่ใช้บริการ
  loyalty_enabled boolean not null default false,
  loyalty_baht_per_point int not null default 10 check (loyalty_baht_per_point between 1 and 10000),  -- จ่ายครบกี่บาทได้ 1 แต้ม
  loyalty_point_value numeric(10,2) not null default 1 check (loyalty_point_value > 0 and loyalty_point_value <= 1000),  -- 1 แต้มลดได้กี่บาท
  loyalty_min_redeem int not null default 10 check (loyalty_min_redeem between 1 and 100000),  -- แลกขั้นต่ำกี่แต้ม
  line_to text check (line_to ~ '^[UCR][0-9a-f]{32}$'),  -- ผู้รับรายงานรายวันทาง LINE (userId / groupId / roomId)
  updated_at timestamptz not null default now()
);
alter table shop_settings enable row level security;
drop policy if exists shop_settings_read on shop_settings;
create policy shop_settings_read on shop_settings for select using (is_staff_of(restaurant_id));
drop policy if exists shop_settings_write on shop_settings;
create policy shop_settings_write on shop_settings for all
  using (has_role(restaurant_id, array['owner']))
  with check (has_role(restaurant_id, array['owner']));

-- ===== 2) สมาชิกและแต้ม =====
create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  phone text not null check (phone ~ '^0[0-9]{8,9}$'),
  name text check (char_length(name) <= 60),
  points int not null default 0 check (points >= 0),
  created_at timestamptz not null default now(),
  unique (restaurant_id, phone)
);
create table if not exists point_ledger (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  change int not null,
  reason text not null check (reason in ('earn', 'redeem', 'reverse', 'adjust')),
  order_ids uuid[],
  note text check (char_length(note) <= 200),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists point_ledger_member_idx on point_ledger (member_id, created_at);

alter table members enable row level security;
alter table point_ledger enable row level security;
drop policy if exists members_read on members;
create policy members_read on members for select using (has_role(restaurant_id, array['owner', 'manager', 'staff']));
drop policy if exists members_insert on members;
create policy members_insert on members for insert
  with check (has_role(restaurant_id, array['owner', 'manager', 'staff']) and points = 0);
drop policy if exists members_update on members;
create policy members_update on members for update
  using (has_role(restaurant_id, array['owner', 'manager', 'staff']))
  with check (has_role(restaurant_id, array['owner', 'manager', 'staff']));
drop policy if exists members_delete on members;
create policy members_delete on members for delete using (has_role(restaurant_id, array['owner']));
-- แก้ได้แค่ชื่อ แต้มต้องเปลี่ยนผ่านการรับชำระ/ปรับแต้มเท่านั้น
revoke update on members from authenticated;
grant update (name) on members to authenticated;

drop policy if exists point_ledger_read on point_ledger;
create policy point_ledger_read on point_ledger for select using (has_role(restaurant_id, array['owner', 'manager', 'staff']));
revoke insert, update, delete on point_ledger from anon, authenticated;

-- ปรับแต้มเอง (เช่น ชดเชยลูกค้า) เจ้าของ/ผู้จัดการ ต้องระบุเหตุผล
create or replace function member_adjust_points(p_member_id uuid, p_change int, p_note text)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rid uuid;
  v_points int;
begin
  select restaurant_id into v_rid from members where id = p_member_id for update;
  if v_rid is null or not has_role(v_rid, array['owner', 'manager']) then
    raise exception 'forbidden';
  end if;
  if p_change = 0 or abs(p_change) > 100000 then
    raise exception 'invalid_points';
  end if;
  if coalesce(trim(p_note), '') = '' then
    raise exception 'note_required';
  end if;
  update members set points = points + p_change where id = p_member_id returning points into v_points;  -- ติดลบไม่ได้ (check)
  insert into point_ledger (restaurant_id, member_id, change, reason, note, created_by)
  values (v_rid, p_member_id, p_change, 'adjust', left(trim(p_note), 200), auth.uid());
  return v_points;
end;
$$;
revoke execute on function member_adjust_points(uuid, int, text) from public, anon;
grant execute on function member_adjust_points(uuid, int, text) to authenticated;

-- ===== 3) ข้อมูลการชำระในออเดอร์ =====
alter table orders add column if not exists payment_method text check (payment_method in ('cash', 'promptpay', 'card', 'other'));
alter table orders add column if not exists member_id uuid references members(id) on delete set null;
alter table orders add column if not exists points_earned int not null default 0 check (points_earned >= 0);
alter table orders add column if not exists points_redeemed int not null default 0 check (points_redeemed >= 0);
alter table orders add column if not exists points_discount numeric(10,2) not null default 0 check (points_discount >= 0);

-- ===== 4) รับชำระ (แทนของ 0012) =====
drop function if exists counter_pay_bill(uuid, uuid[], uuid[]);
create or replace function counter_pay_bill(
  p_restaurant_id uuid,
  p_order_ids uuid[],
  p_promotion_ids uuid[] default null,
  p_payment_method text default 'cash',
  p_member_id uuid default null,
  p_redeem_points int default 0
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_count int;
  v_set shop_settings%rowtype;
  v_member members%rowtype;
  v_total numeric(10,2);
  v_disc numeric(10,2) := 0;
  v_earned int := 0;
  v_left numeric(10,2);
  v_share numeric(10,2);
  o record;
  v_i int := 0;
  v_n int;
begin
  if not has_role(p_restaurant_id, array['owner', 'staff']) then
    raise exception 'forbidden';
  end if;
  if p_order_ids is null or cardinality(p_order_ids) = 0 or cardinality(p_order_ids) > 50 then
    raise exception 'invalid_orders';
  end if;
  if coalesce(p_payment_method, '') not in ('cash', 'promptpay', 'card', 'other') then
    raise exception 'invalid_payment_method';
  end if;
  if p_redeem_points is null or p_redeem_points < 0 then
    raise exception 'invalid_points';
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

  -- ===== แต้มสมาชิก =====
  select * into v_set from shop_settings where restaurant_id = p_restaurant_id;
  if p_member_id is not null then
    if not coalesce(v_set.loyalty_enabled, false) then
      raise exception 'loyalty_disabled';
    end if;
    select * into v_member from members where id = p_member_id and restaurant_id = p_restaurant_id for update;
    if v_member.id is null then
      raise exception 'member_not_found';
    end if;
  elsif p_redeem_points > 0 then
    raise exception 'member_required';
  end if;

  select coalesce(sum(total), 0) into v_total from orders where id = any (p_order_ids);

  if p_redeem_points > 0 then
    if p_redeem_points > v_member.points then
      raise exception 'not_enough_points';
    end if;
    if p_redeem_points < v_set.loyalty_min_redeem then
      raise exception 'below_min_redeem';
    end if;
    v_disc := round(p_redeem_points * v_set.loyalty_point_value, 2);
    if v_disc > v_total then
      raise exception 'redeem_exceeds_total';
    end if;
    -- แบ่งส่วนลดจากแต้มตามยอดแต่ละออเดอร์ เศษไปที่ออเดอร์สุดท้าย
    v_left := v_disc;
    v_n := cardinality(p_order_ids);
    for o in select id, total from orders where id = any (p_order_ids) order by total, id loop
      v_i := v_i + 1;
      v_share := case when v_i = v_n then v_left
                      when v_total = 0 then 0
                      else least(o.total, trunc(v_disc * o.total / v_total, 2)) end;
      v_left := v_left - v_share;
      update orders set total = total - v_share,
                        discount_total = coalesce(discount_total, 0) + v_share,
                        points_discount = v_share
       where id = o.id;
    end loop;
    v_total := v_total - v_disc;
    update members set points = points - p_redeem_points where id = p_member_id;
    insert into point_ledger (restaurant_id, member_id, change, reason, order_ids, created_by)
    values (p_restaurant_id, p_member_id, -p_redeem_points, 'redeem', p_order_ids, auth.uid());
  end if;

  if p_member_id is not null then
    v_earned := floor(v_total / v_set.loyalty_baht_per_point);
    if v_earned > 0 then
      update members set points = points + v_earned where id = p_member_id;
      insert into point_ledger (restaurant_id, member_id, change, reason, order_ids, created_by)
      values (p_restaurant_id, p_member_id, v_earned, 'earn', p_order_ids, auth.uid());
    end if;
    -- บันทึกแต้มไว้ที่ออเดอร์ที่ยอดมากที่สุด (ใช้ตอนยกเลิกบิล)
    update orders set member_id = p_member_id where id = any (p_order_ids);
    update orders set points_earned = v_earned, points_redeemed = p_redeem_points
     where id = (select id from orders where id = any (p_order_ids) order by total desc, id limit 1);
  end if;

  update orders set status = 'paid', payment_method = p_payment_method where id = any (p_order_ids);

  return (
    select jsonb_build_object(
      'subtotal', coalesce(sum(coalesce(subtotal, total + discount_total)), 0),
      'discount', coalesce(sum(discount_total), 0),
      'points_discount', coalesce(sum(points_discount), 0),
      'total', coalesce(sum(total), 0),
      'points_earned', v_earned,
      'points_redeemed', p_redeem_points,
      'member_points', (select points from members where id = p_member_id)
    )
    from orders where id = any (p_order_ids)
  );
end;
$$;
revoke execute on function counter_pay_bill(uuid, uuid[], uuid[], text, uuid, int) from public, anon;
grant execute on function counter_pay_bill(uuid, uuid[], uuid[], text, uuid, int) to authenticated;

-- ===== 5) ยกเลิกบิลที่ชำระแล้ว: คืน/หักแต้ม =====
create or replace function reverse_order_points()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_change int;
begin
  if new.status = 'cancelled' and old.status = 'paid' and old.member_id is not null
     and (old.points_earned > 0 or old.points_redeemed > 0) then
    v_change := old.points_redeemed - old.points_earned;
    -- แต้มที่ได้ไปถ้าใช้หมดแล้ว หักได้ไม่เกินที่มี (ไม่ให้ติดลบ)
    update members set points = greatest(0, points + v_change) where id = old.member_id;
    insert into point_ledger (restaurant_id, member_id, change, reason, order_ids, note, created_by)
    values (old.restaurant_id, old.member_id, v_change, 'reverse', array[old.id], 'ยกเลิกบิล', auth.uid());
    new.points_earned := 0;
    new.points_redeemed := 0;
  end if;
  return new;
end;
$$;
drop trigger if exists orders_reverse_points on orders;
create trigger orders_reverse_points
  before update of status on orders
  for each row execute function reverse_order_points();

-- ===== 6) ข้อมูลใบเสร็จ =====
-- รวมออเดอร์ในบิลเดียว: รายการอาหาร โปร แต้ม วิธีชำระ (พนักงานหน้าร้าน/เจ้าของ/บัญชี)
create or replace function bill_receipt(p_order_ids uuid[])
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_rid uuid;
begin
  if p_order_ids is null or cardinality(p_order_ids) = 0 or cardinality(p_order_ids) > 50 then
    raise exception 'invalid_orders';
  end if;
  select min(restaurant_id::text)::uuid into v_rid from orders where id = any (p_order_ids);
  if v_rid is null or not has_role(v_rid, array['owner', 'staff', 'accountant'])
     or exists (select 1 from orders where id = any (p_order_ids) and restaurant_id <> v_rid) then
    raise exception 'forbidden';
  end if;

  return jsonb_build_object(
    'restaurant', (select name from restaurants where id = v_rid),
    'header', (select receipt_header from shop_settings where restaurant_id = v_rid),
    'footer', (select receipt_footer from shop_settings where restaurant_id = v_rid),
    'paid_at', (select max(paid_at) from orders where id = any (p_order_ids)),
    'payment_method', (select max(payment_method) from orders where id = any (p_order_ids)),
    'table', (select string_agg(distinct t.label, ', ') from orders o join dining_tables t on t.id = o.table_id where o.id = any (p_order_ids)),
    'bill_no', upper(left(replace((select min(id::text) from orders where id = any (p_order_ids)), '-', ''), 8)),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('name', x.name, 'quantity', x.qty, 'unit_price', x.unit_price, 'amount', x.amount) order by x.name)
      from (
        select m.name, oi.unit_price, sum(oi.quantity) as qty, sum(oi.quantity * oi.unit_price) as amount
        from order_items oi join menu_items m on m.id = oi.menu_item_id
        where oi.order_id = any (p_order_ids)
        group by m.name, oi.unit_price
      ) x
    ), '[]'::jsonb),
    'promotions', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.name, 'discount', d.discount) order by p.name)
      from (select promotion_id, sum(discount) as discount from order_promotions where order_id = any (p_order_ids) group by promotion_id) d
      join promotions p on p.id = d.promotion_id
    ), '[]'::jsonb),
    'subtotal', (select coalesce(sum(coalesce(subtotal, total + discount_total)), 0) from orders where id = any (p_order_ids)),
    'points_discount', (select coalesce(sum(points_discount), 0) from orders where id = any (p_order_ids)),
    'total', (select coalesce(sum(total), 0) from orders where id = any (p_order_ids)),
    'member', (
      select jsonb_build_object('phone', '***' || right(m.phone, 4), 'points', m.points,
                                'earned', (select sum(points_earned) from orders where id = any (p_order_ids)),
                                'redeemed', (select sum(points_redeemed) from orders where id = any (p_order_ids)))
      from members m where m.id = (select min(member_id::text)::uuid from orders where id = any (p_order_ids))
    )
  );
end;
$$;
revoke execute on function bill_receipt(uuid[]) from public, anon;
grant execute on function bill_receipt(uuid[]) to authenticated;


-- ======================================================================
-- 0018_reports_insights.sql
-- ======================================================================
-- 0018: รายงานสรุปรายวัน (ส่ง LINE ได้) + ข้อมูลสำหรับแนะนำโปร (AI)
--   - daily_report(ร้าน, วันที่): ยอดขาย ส่วนลด เมนูขายดี ช่วงพีค ของเสีย รายจ่าย แต้มสมาชิก
--   - daily_report_targets(): ร้านที่ตั้งผู้รับ LINE ไว้ (ให้ backend ส่งอัตโนมัติทุกสิ้นวัน)
--   - promo_insights(ร้าน, จำนวนวัน): ยอดตามชั่วโมง + ยอดขาย/กำไรต่อเมนู ใช้คิดโปรที่ควรทำ

-- ===== 1) รายงานรายวัน =====
-- ใช้ภายใน (ไม่ตรวจสิทธิ์) · เรียกตรงได้เฉพาะ service role
create or replace function daily_report_data(p_restaurant_id uuid, p_date date)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_tz text;
  v_from timestamptz;
  v_to timestamptz;
  v_prev_from timestamptz;
begin
  select timezone into v_tz from restaurants where id = p_restaurant_id;
  if v_tz is null then
    return null;
  end if;
  v_from := p_date::timestamp at time zone v_tz;
  v_to := (p_date + 1)::timestamp at time zone v_tz;
  v_prev_from := (p_date - 7)::timestamp at time zone v_tz;  -- วันเดียวกันของสัปดาห์ก่อน

  return jsonb_build_object(
    'restaurant', (select name from restaurants where id = p_restaurant_id),
    'date', p_date,
    'orders', (select count(*) from orders where restaurant_id = p_restaurant_id and status = 'paid'
                and created_at >= v_from and created_at < v_to),
    'revenue', (select coalesce(sum(total), 0) from orders where restaurant_id = p_restaurant_id and status = 'paid'
                and created_at >= v_from and created_at < v_to),
    'discount', (select coalesce(sum(discount_total), 0) from orders where restaurant_id = p_restaurant_id and status = 'paid'
                and created_at >= v_from and created_at < v_to),
    'revenue_last_week', (select coalesce(sum(total), 0) from orders where restaurant_id = p_restaurant_id and status = 'paid'
                and created_at >= v_prev_from and created_at < v_prev_from + interval '1 day'),
    'cancelled', (select count(*) from orders where restaurant_id = p_restaurant_id and status = 'cancelled'
                and created_at >= v_from and created_at < v_to),
    'payments', coalesce((
      select jsonb_object_agg(coalesce(payment_method, 'unknown'), amount)
      from (select payment_method, sum(total) as amount from orders
            where restaurant_id = p_restaurant_id and status = 'paid' and created_at >= v_from and created_at < v_to
            group by payment_method) x
    ), '{}'::jsonb),
    'top_items', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'quantity', qty, 'amount', amount) order by qty desc, name)
      from (
        select m.name, sum(oi.quantity) as qty, sum(oi.quantity * oi.unit_price) as amount
        from order_items oi
        join orders o on o.id = oi.order_id
        join menu_items m on m.id = oi.menu_item_id
        where o.restaurant_id = p_restaurant_id and o.status = 'paid' and o.created_at >= v_from and o.created_at < v_to
        group by m.name
        order by qty desc, m.name
        limit 5
      ) t
    ), '[]'::jsonb),
    'peak_hour', (
      select extract(hour from created_at at time zone v_tz)::int
      from orders
      where restaurant_id = p_restaurant_id and status <> 'cancelled' and created_at >= v_from and created_at < v_to
      group by 1 order by count(*) desc, 1 limit 1
    ),
    'waste', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'quantity', qty, 'unit', unit, 'cost', cost) order by cost desc, name)
      from (
        select i.name, i.unit, sum(-sm.change) as qty, round(sum(-sm.change * i.cost_per_unit), 2) as cost
        from stock_movements sm join ingredients i on i.id = sm.ingredient_id
        where sm.restaurant_id = p_restaurant_id and sm.reason = 'waste'
          and sm.created_at >= v_from and sm.created_at < v_to
        group by i.name, i.unit
      ) w
    ), '[]'::jsonb),
    'expenses', (select coalesce(sum(amount), 0) from expenses where restaurant_id = p_restaurant_id and spent_on = p_date),
    'new_members', (select count(*) from members where restaurant_id = p_restaurant_id and created_at >= v_from and created_at < v_to),
    'points_earned', (select coalesce(sum(change), 0) from point_ledger where restaurant_id = p_restaurant_id and reason = 'earn'
                      and created_at >= v_from and created_at < v_to),
    'points_redeemed', (select coalesce(-sum(change), 0) from point_ledger where restaurant_id = p_restaurant_id and reason = 'redeem'
                      and created_at >= v_from and created_at < v_to)
  );
end;
$$;
revoke execute on function daily_report_data(uuid, date) from public, anon, authenticated;
grant execute on function daily_report_data(uuid, date) to service_role;

-- เรียกจากหน้าเว็บ: เจ้าของ ผู้จัดการ บัญชี
create or replace function daily_report(p_restaurant_id uuid, p_date date default null)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_date date := p_date;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'accountant']) then
    raise exception 'forbidden';
  end if;
  if v_date is null then
    select (now() at time zone timezone)::date into v_date from restaurants where id = p_restaurant_id;
  end if;
  return daily_report_data(p_restaurant_id, v_date);
end;
$$;
revoke execute on function daily_report(uuid, date) from public, anon;
grant execute on function daily_report(uuid, date) to authenticated;

-- ร้านที่ตั้งผู้รับ LINE + วันที่ปัจจุบันตามเวลาร้าน (backend ใช้ส่งรายงานอัตโนมัติ)
create or replace function daily_report_targets()
returns table (restaurant_id uuid, line_to text, local_date date, local_hour int)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.restaurant_id, s.line_to, (now() at time zone r.timezone)::date, extract(hour from now() at time zone r.timezone)::int
  from shop_settings s join restaurants r on r.id = s.restaurant_id
  where s.line_to is not null;
$$;
revoke execute on function daily_report_targets() from public, anon, authenticated;
grant execute on function daily_report_targets() to service_role;

-- ===== 2) ข้อมูลสำหรับแนะนำโปร =====
-- ไม่มีข้อมูลส่วนบุคคล: แค่ยอดตามชั่วโมงและยอด/ต้นทุนต่อเมนู
create or replace function promo_insights(p_restaurant_id uuid, p_days int default 28)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_tz text;
  v_days int := least(greatest(coalesce(p_days, 28), 7), 120);
  v_from timestamptz;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'accountant']) then
    raise exception 'forbidden';
  end if;
  select timezone into v_tz from restaurants where id = p_restaurant_id;
  v_from := now() - make_interval(days => v_days);

  return jsonb_build_object(
    'days', v_days,
    'hours', coalesce((
      select jsonb_agg(jsonb_build_object('hour', h, 'orders_per_day', round(n::numeric / v_days, 2), 'revenue', rev) order by h)
      from (
        select extract(hour from created_at at time zone v_tz)::int as h, count(*) as n,
               coalesce(sum(total) filter (where status = 'paid'), 0) as rev
        from orders
        where restaurant_id = p_restaurant_id and status <> 'cancelled' and created_at >= v_from
        group by 1
      ) x
    ), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'name', m.name, 'price', m.price, 'unit_cost', c.unit_cost,
               'has_recipe', c.ingredient_count > 0, 'quantity', coalesce(s.qty, 0), 'revenue', coalesce(s.amount, 0),
               'is_available', m.is_available)
             order by coalesce(s.qty, 0) desc, m.name)
      from menu_items m
      join menu_item_costs c on c.menu_item_id = m.id
      left join (
        select oi.menu_item_id, sum(oi.quantity) as qty, sum(oi.quantity * oi.unit_price) as amount
        from order_items oi join orders o on o.id = oi.order_id
        where o.restaurant_id = p_restaurant_id and o.status <> 'cancelled' and o.created_at >= v_from
        group by oi.menu_item_id
      ) s on s.menu_item_id = m.id
      where m.restaurant_id = p_restaurant_id
    ), '[]'::jsonb),
    'active_promotions', coalesce((
      select jsonb_agg(p.name order by p.name) from promotions p where p.restaurant_id = p_restaurant_id and p.is_active
    ), '[]'::jsonb)
  );
end;
$$;
revoke execute on function promo_insights(uuid, int) from public, anon;
grant execute on function promo_insights(uuid, int) to authenticated;


-- ======================================================================
-- 0019_stock_history.sql
-- ======================================================================
-- 0019: ประวัติสต็อก
--   - stock_movements เก็บเพิ่ม: ใครทำ (created_by) คงเหลือหลังรายการ (balance_after) ออเดอร์ที่ตัด (order_id) หมายเหตุ (note)
--   - stock_history(ร้าน, ช่วงเวลา, ตัวกรอง): รายการพร้อมชื่อวัตถุดิบ อีเมลคนทำ และโต๊ะของออเดอร์

-- ===== 1) คอลัมน์ใหม่ (รายการเก่าเป็นค่าว่าง) =====
alter table stock_movements add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table stock_movements add column if not exists balance_after numeric(12,3);
alter table stock_movements add column if not exists order_id uuid references orders(id) on delete set null;
alter table stock_movements add column if not exists note text check (char_length(note) <= 200);

create index if not exists stock_movements_restaurant_created_idx on stock_movements (restaurant_id, created_at desc);

-- ===== 2) ปรับยอดก่อนบันทึก เพื่อเก็บคงเหลือหลังรายการไว้ในแถวเดียวกัน =====
-- คนทำมาจาก auth.uid() เสมอ (ปลอมไม่ได้) · ตัดจากออเดอร์ = คนที่กดเปลี่ยนสถานะ
create or replace function apply_stock_movement()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.created_by := auth.uid();
  update ingredients
     set quantity_on_hand = quantity_on_hand + new.change
   where id = new.ingredient_id
     and restaurant_id = new.restaurant_id
  returning quantity_on_hand into new.balance_after;
  if not found then
    raise exception 'invalid_ingredient';
  end if;
  return new;
end;
$$;

drop trigger if exists stock_movements_apply on stock_movements;
create trigger stock_movements_apply before insert on stock_movements
  for each row execute function apply_stock_movement();

-- ===== 3) ตัดสต็อกจากออเดอร์: จำว่ามาจากออเดอร์ไหน =====
create or replace function deduct_stock_for_order()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.stock_deducted_at is null
     and new.status in ('preparing', 'ready', 'served', 'paid') then
    insert into stock_movements (restaurant_id, ingredient_id, change, reason, order_id)
    select new.restaurant_id,
           r.ingredient_id,
           -least(sum(r.quantity_used * oi.quantity), i.quantity_on_hand),
           'sale'::stock_reason,
           new.id
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

-- ===== 4) ดึงประวัติ: สิทธิ์เดียวกับการอ่าน stock_movements (เจ้าของ สต็อก บัญชี) =====
create or replace function stock_history(
  p_restaurant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_ingredient_id uuid default null,
  p_reason stock_reason default null,
  p_limit int default 200
)
returns table (
  id uuid,
  created_at timestamptz,
  ingredient_id uuid,
  ingredient_name text,
  unit text,
  change numeric,
  reason stock_reason,
  balance_after numeric,
  cost numeric,
  note text,
  actor_email text,
  order_id uuid,
  order_label text
)
language plpgsql stable security definer set search_path = public, auth, pg_temp as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;

  return query
  select sm.id, sm.created_at, sm.ingredient_id, i.name, i.unit, sm.change, sm.reason, sm.balance_after,
         round(abs(sm.change) * i.cost_per_unit, 2),
         sm.note, u.email::text, sm.order_id,
         case
           when o.id is null then null
           when o.order_type = 'takeaway' then coalesce('กลับบ้าน · ' || o.customer_label, 'กลับบ้าน')
           else coalesce(t.label, 'ไม่ระบุโต๊ะ')
         end
  from stock_movements sm
  join ingredients i on i.id = sm.ingredient_id
  left join auth.users u on u.id = sm.created_by
  left join orders o on o.id = sm.order_id
  left join dining_tables t on t.id = o.table_id
  where sm.restaurant_id = p_restaurant_id
    and sm.created_at >= p_from and sm.created_at < p_to
    and (p_ingredient_id is null or sm.ingredient_id = p_ingredient_id)
    and (p_reason is null or sm.reason = p_reason)
  order by sm.created_at desc, sm.id
  limit least(greatest(p_limit, 1), 1000);
end;
$$;

revoke execute on function stock_history(uuid, timestamptz, timestamptz, uuid, stock_reason, int) from public, anon;
grant execute on function stock_history(uuid, timestamptz, timestamptz, uuid, stock_reason, int) to authenticated;


-- ======================================================================
-- 0020_multi_roles.sql
-- ======================================================================
-- 0020: พนักงาน 1 คนมีได้หลายบทบาท (เช่น หน้าร้าน + สต็อก)
--   - staff_members เก็บ 1 แถวต่อ 1 บทบาท (คีย์หลัก user_id + restaurant_id + role)
--     has_role() และ RLS ทุกตารางใช้ได้เหมือนเดิม เพราะตรวจว่า "มีแถวบทบาทนั้นไหม"
--   - staff_set_roles(): ตั้งบทบาททั้งชุดของพนักงาน 1 คนในครั้งเดียว (ใช้สิทธิ์ผู้เรียก)
--   - staff_list(): คืนบทบาทเป็น array
--   - ผู้จัดการแก้ได้เฉพาะพนักงานที่ไม่มีบทบาทเจ้าของ/ผู้จัดการเลย และแก้ตัวเองไม่ได้

-- ===== 1) คีย์หลักใหม่ =====
alter table staff_members drop constraint if exists staff_members_pkey;
alter table staff_members add primary key (user_id, restaurant_id, role);
create index if not exists staff_members_restaurant_user_idx on staff_members (restaurant_id, user_id);

-- ===== 2) ผู้จัดการ: ห้ามแตะคนที่มีบทบาทเจ้าของ/ผู้จัดการ (ดูทุกแถวของคนนั้น ไม่ใช่แค่แถวที่แก้) =====
-- security definer เพื่ออ่าน staff_members ได้โดยไม่วน policy ของตารางเดียวกัน
create or replace function staff_is_senior(p_restaurant_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from staff_members
    where restaurant_id = p_restaurant_id and user_id = p_user_id and role in ('owner', 'manager')
  );
$$;
revoke execute on function staff_is_senior(uuid, uuid) from public, anon;
grant execute on function staff_is_senior(uuid, uuid) to authenticated;

drop policy if exists manager_manage_staff on staff_members;
create policy manager_manage_staff on staff_members for all
  using (
    has_role(restaurant_id, array['manager'])
    and role in ('staff', 'kitchen', 'accountant', 'stock')
    and user_id <> auth.uid()
    and not staff_is_senior(restaurant_id, user_id)
  )
  with check (
    has_role(restaurant_id, array['manager'])
    and role in ('staff', 'kitchen', 'accountant', 'stock')
    and user_id <> auth.uid()
    and not staff_is_senior(restaurant_id, user_id)
  );

-- ===== 3) กันร้านไม่มีเจ้าของ: นับเป็นรายคน (คนเดียวมีหลายแถวได้) =====
create or replace function keep_last_owner()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner' or new.restaurant_id <> old.restaurant_id or new.user_id <> old.user_id)
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

-- ===== 4) ตั้งบทบาททั้งชุด: เพิ่มที่ขาดก่อน แล้วลบที่ไม่อยู่ในชุด (ทั้งหมดเป็นธุรกรรมเดียว) =====
-- security invoker: RLS ของผู้เรียกตรวจทุกแถว (เจ้าของ / ผู้จัดการตามข้อ 2)
create or replace function staff_set_roles(p_restaurant_id uuid, p_user_id uuid, p_roles text[])
returns text[]
language plpgsql set search_path = public, pg_temp as $$
declare
  v_roles text[];
begin
  if p_roles is null or cardinality(p_roles) = 0 then
    raise exception 'roles_required';
  end if;
  if not exists (select 1 from staff_members where restaurant_id = p_restaurant_id and user_id = p_user_id) then
    raise exception 'not_found';
  end if;

  insert into staff_members (user_id, restaurant_id, role)
  select p_user_id, p_restaurant_id, r from unnest(p_roles) as r
  on conflict do nothing;

  delete from staff_members
  where restaurant_id = p_restaurant_id and user_id = p_user_id and role <> all(p_roles);

  select array_agg(role order by role) into v_roles
  from staff_members where restaurant_id = p_restaurant_id and user_id = p_user_id;
  return v_roles;
end;
$$;
revoke execute on function staff_set_roles(uuid, uuid, text[]) from public, anon;
grant execute on function staff_set_roles(uuid, uuid, text[]) to authenticated;

-- ===== 5) รายชื่อพนักงาน: 1 แถวต่อคน บทบาทเป็น array =====
drop function if exists staff_list(uuid);
create function staff_list(p_restaurant_id uuid)
returns table (user_id uuid, email text, roles text[])
language sql stable security definer set search_path = public, auth, pg_temp as $$
  select s.user_id, u.email::text, array_agg(s.role order by s.role)
  from staff_members s join auth.users u on u.id = s.user_id
  where s.restaurant_id = p_restaurant_id
  group by s.user_id, u.email
  order by min(case s.role when 'owner' then 0 when 'manager' then 1 else 2 end), u.email;
$$;
revoke execute on function staff_list(uuid) from public, anon, authenticated;
grant execute on function staff_list(uuid) to service_role;


-- ======================================================================
-- 0021_app_users.sql
-- ======================================================================
-- 0021: ผู้ใช้ของระบบเอง (app_users) แทน Supabase Auth
--   - app_users: อีเมล รหัสผ่าน (bcrypt ผ่าน pgcrypto) ชื่อ เบอร์ สถานะ
--   - ย้ายบัญชีเดิมจาก auth.users มาพร้อมรหัสผ่านเดิม (Supabase เก็บเป็น bcrypt อยู่แล้ว ล็อกอินด้วยรหัสเดิมได้)
--   - foreign key ทุกตัวที่เคยชี้ auth.users ย้ายมาชี้ app_users
--   - ล็อกอินผ่าน backend: ตรวจรหัสด้วย app_login() แล้ว backend ออก JWT (ลงนามด้วย JWT secret ของโปรเจกต์)
--     auth.uid() อ่าน sub จาก JWT นั้น RLS ทุกตารางจึงใช้ได้เหมือนเดิม
--   - ตาราง app_users ปิดจากหน้าเว็บทั้งหมด (ไม่มี policy) ใช้ผ่านฟังก์ชันของ service role เท่านั้น

create extension if not exists pgcrypto with schema extensions;

-- ===== 1) ตารางผู้ใช้ =====
create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(trim(email)) and char_length(email) between 3 and 254),
  password_hash text,                                   -- null = ยังล็อกอินไม่ได้
  display_name text check (char_length(display_name) <= 80),
  phone text check (char_length(phone) <= 30),
  is_active boolean not null default true,
  must_change_password boolean not null default false,  -- รหัสชั่วคราว ต้องเปลี่ยนหลังล็อกอินครั้งแรก
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index if not exists app_users_email_key on app_users (email);

alter table app_users enable row level security;
revoke all on app_users from public, anon, authenticated;

-- ===== 2) ย้ายบัญชีเดิมจาก Supabase Auth (ถ้ามี) =====
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'auth' and table_name = 'users' and column_name = 'encrypted_password') then
    execute $q$
      insert into app_users (id, email, password_hash, created_at, last_login_at)
      select id, lower(trim(coalesce(email, id::text || '@no-email.local'))),
             nullif(encrypted_password, ''), coalesce(created_at, now()), last_sign_in_at
      from auth.users
      on conflict do nothing
    $q$;
  elsif to_regclass('auth.users') is not null then
    execute $q$
      insert into app_users (id, email)
      select id, lower(coalesce(email, id::text || '@no-email.local')) from auth.users
      on conflict do nothing
    $q$;
  end if;
end;
$$;

-- ===== 3) foreign key: auth.users -> app_users (คง on delete เดิม) =====
do $$
declare
  r record;
begin
  if to_regclass('auth.users') is null then
    return;
  end if;
  for r in
    select c.conname, c.conrelid::regclass as tbl, a.attname as col, c.confdeltype
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f'
      and c.confrelid = 'auth.users'::regclass
      and c.connamespace = 'public'::regnamespace
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
    execute format('alter table %s add constraint %I foreign key (%I) references app_users(id) on delete %s',
                   r.tbl, r.conname, r.col,
                   case r.confdeltype when 'c' then 'cascade' when 'n' then 'set null' else 'no action' end);
  end loop;
end;
$$;

-- ===== 4) ฟังก์ชันของ backend (service role เท่านั้น) =====
-- ตรวจรหัสผ่าน: คืนผู้ใช้ถ้าถูกต้องและยังใช้งานอยู่ (ไม่บอกว่าผิดเพราะอีเมลหรือรหัส)
create or replace function app_login(p_email text, p_password text)
returns table (id uuid, email text, display_name text, must_change_password boolean)
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  u app_users;
begin
  select * into u from app_users a where a.email = lower(trim(p_email));
  if u.id is null or u.password_hash is null or not u.is_active
     or u.password_hash <> crypt(coalesce(p_password, ''), u.password_hash) then
    return;
  end if;
  update app_users set last_login_at = now() where app_users.id = u.id;
  return query select u.id, u.email, u.display_name, u.must_change_password;
end;
$$;

-- ผู้ใช้ยังใช้งานได้ไหม (backend ตรวจทุกคำขอ: ปิดบัญชีแล้วโทเคนเดิมใช้ต่อไม่ได้)
create or replace function app_user_active(p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select is_active from app_users where id = p_user_id), false);
$$;

create or replace function app_set_password(p_user_id uuid, p_password text, p_must_change boolean default false)
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  if char_length(coalesce(p_password, '')) < 8 or char_length(p_password) > 72 then
    raise exception 'weak_password';
  end if;
  update app_users
     set password_hash = crypt(p_password, gen_salt('bf', 10)),
         must_change_password = p_must_change
   where id = p_user_id;
  if not found then
    raise exception 'not_found';
  end if;
end;
$$;

-- สร้างผู้ใช้ใหม่ (รหัสชั่วคราว ต้องเปลี่ยนหลังล็อกอินครั้งแรก)
create or replace function app_create_user(p_email text, p_password text, p_display_name text default null, p_must_change boolean default true)
returns uuid
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_id uuid;
begin
  insert into app_users (email, display_name)
  values (lower(trim(p_email)), nullif(left(trim(p_display_name), 80), ''))
  returning id into v_id;
  perform app_set_password(v_id, p_password, p_must_change);
  return v_id;
end;
$$;

-- ข้อมูลโปรไฟล์ของผู้ใช้ (ไม่รวมรหัสผ่าน)
create or replace function app_user_profile(p_user_id uuid)
returns table (id uuid, email text, display_name text, phone text, must_change_password boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select id, email, display_name, phone, must_change_password from app_users where id = p_user_id and is_active;
$$;

create or replace function app_update_profile(p_user_id uuid, p_display_name text, p_phone text)
returns void
language sql security definer set search_path = public, pg_temp as $$
  update app_users
     set display_name = nullif(left(trim(p_display_name), 80), ''),
         phone = nullif(left(trim(p_phone), 30), '')
   where id = p_user_id;
$$;

revoke execute on function app_login(text, text) from public, anon, authenticated;
revoke execute on function app_user_active(uuid) from public, anon, authenticated;
revoke execute on function app_set_password(uuid, text, boolean) from public, anon, authenticated;
revoke execute on function app_create_user(text, text, text, boolean) from public, anon, authenticated;
revoke execute on function app_user_profile(uuid) from public, anon, authenticated;
revoke execute on function app_update_profile(uuid, text, text) from public, anon, authenticated;
grant execute on function app_login(text, text) to service_role;
grant execute on function app_user_active(uuid) to service_role;
grant execute on function app_set_password(uuid, text, boolean) to service_role;
grant execute on function app_create_user(text, text, text, boolean) to service_role;
grant execute on function app_user_profile(uuid) to service_role;
grant execute on function app_update_profile(uuid, text, text) to service_role;

-- ===== 5) ฟังก์ชันเดิมที่อ่านอีเมลจาก auth.users =====
create or replace function staff_find_user(p_email text)
returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select id from app_users where email = lower(trim(p_email)) limit 1;
$$;

drop function if exists staff_list(uuid);
create function staff_list(p_restaurant_id uuid)
returns table (user_id uuid, email text, display_name text, roles text[])
language sql stable security definer set search_path = public, pg_temp as $$
  select s.user_id, u.email, u.display_name, array_agg(s.role order by s.role)
  from staff_members s join app_users u on u.id = s.user_id
  where s.restaurant_id = p_restaurant_id
  group by s.user_id, u.email, u.display_name
  order by min(case s.role when 'owner' then 0 when 'manager' then 1 else 2 end), u.email;
$$;
revoke execute on function staff_find_user(text) from public, anon, authenticated;
revoke execute on function staff_list(uuid) from public, anon, authenticated;
grant execute on function staff_find_user(text) to service_role;
grant execute on function staff_list(uuid) to service_role;

create or replace function stock_history(
  p_restaurant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_ingredient_id uuid default null,
  p_reason stock_reason default null,
  p_limit int default 200
)
returns table (
  id uuid,
  created_at timestamptz,
  ingredient_id uuid,
  ingredient_name text,
  unit text,
  change numeric,
  reason stock_reason,
  balance_after numeric,
  cost numeric,
  note text,
  actor_email text,
  order_id uuid,
  order_label text
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;

  return query
  select sm.id, sm.created_at, sm.ingredient_id, i.name, i.unit, sm.change, sm.reason, sm.balance_after,
         round(abs(sm.change) * i.cost_per_unit, 2),
         sm.note, coalesce(u.display_name, u.email), sm.order_id,
         case
           when o.id is null then null
           when o.order_type = 'takeaway' then coalesce('กลับบ้าน · ' || o.customer_label, 'กลับบ้าน')
           else coalesce(t.label, 'ไม่ระบุโต๊ะ')
         end
  from stock_movements sm
  join ingredients i on i.id = sm.ingredient_id
  left join app_users u on u.id = sm.created_by
  left join orders o on o.id = sm.order_id
  left join dining_tables t on t.id = o.table_id
  where sm.restaurant_id = p_restaurant_id
    and sm.created_at >= p_from and sm.created_at < p_to
    and (p_ingredient_id is null or sm.ingredient_id = p_ingredient_id)
    and (p_reason is null or sm.reason = p_reason)
  order by sm.created_at desc, sm.id
  limit least(greatest(p_limit, 1), 1000);
end;
$$;


-- ======================================================================
-- 0022_stock_counts.sql
-- ======================================================================
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


-- ======================================================================
-- 0023_seafood_inventory.sql
-- ======================================================================
-- 0023: สต็อกแบบร้านอาหารทะเล (น้ำหนักผันผวน ของเสียสูง ปริมาณต่อจานไม่คงที่)
--   1) วัตถุดิบ: Yield % (ส่วนที่ใช้ได้จริงหลังแกะ/ล้าง/ตัดแต่ง), เกณฑ์เตือนส่วนต่าง %, หมวด
--      สูตรอาหารกรอก "น้ำหนักสุทธิที่ใช้ได้" ระบบตัดน้ำหนักดิบ = สุทธิ x 100 / yield%
--   2) ของเตรียม / สูตรย่อย (เช่น น้ำจิ้มซีฟู้ด): ผลิตทีละถัง -> ตัดส่วนผสม (มะนาว พริก กระเทียม)
--      แล้วเพิ่มสต็อกน้ำจิ้ม · ขายอาหาร -> ตัดน้ำจิ้มตามกรัมต่อถ้วย
--   3) ใบรับของ (Receiving): ผู้ขาย เลขบิล หลายรายการ -> เพิ่มสต็อก + ต้นทุนเฉลี่ยถ่วงน้ำหนัก (+ บันทึกรายจ่าย)
--   4) ของเสียแยกประเภท (เน่า/เสีย, ตัดแต่ง, ตกหล่น, ลูกค้าคืน, หมดอายุ)
--   5) ขายตามน้ำหนักจริง (ปู/ปลาสดหน้าตู้): ชั่งแล้วคีย์น้ำหนัก ราคา = ราคาต่อ กก. x น้ำหนัก ตัดสต็อกตามน้ำหนักจริง
--   6) รายงานส่วนต่างชุดใหญ่ (Mass Variance) ระหว่างใบตรวจนับ 2 ใบ (รายสัปดาห์/รายเดือน)
--      ใช้จริง = ยอดนับต้นงวด + รับเข้า + ผลิตได้ - ยอดนับปลายงวด
--      ตามทฤษฎี = ยอดขายใน POS ย้อนกลับเป็นวัตถุดิบตามสูตร / yield% + ส่วนผสมที่ใช้ผลิตของเตรียม
--      ส่วนต่าง = ใช้จริง - ตามทฤษฎี · % = ส่วนต่าง / ตามทฤษฎี x 100 · เกินเกณฑ์ (ค่าเริ่มต้น ±5%) = เตือน

alter type stock_reason add value if not exists 'production';

-- ===== 1) วัตถุดิบ =====
alter table ingredients add column if not exists yield_pct numeric(5,2) not null default 100
  check (yield_pct > 0 and yield_pct <= 100);
alter table ingredients add column if not exists variance_threshold_pct numeric(5,2) not null default 5
  check (variance_threshold_pct >= 0 and variance_threshold_pct <= 100);
alter table ingredients add column if not exists category text check (char_length(category) <= 40);
alter table ingredients add column if not exists is_prep boolean not null default false;          -- ของเตรียม/สูตรย่อย
alter table ingredients add column if not exists batch_output_qty numeric(12,3) check (batch_output_qty > 0); -- ผลิต 1 ถังได้เท่าไร
grant update (yield_pct, variance_threshold_pct, category, is_prep, batch_output_qty) on ingredients to authenticated;

-- แปลงกรัมเป็นหน่วยของวัตถุดิบ (ใช้กับของขายตามน้ำหนัก) · หน่วยอื่นคืน null
create or replace function grams_to_unit(p_unit text)
returns numeric
language sql immutable set search_path = public, pg_temp as $$
  select case
    when lower(trim(p_unit)) in ('g', 'gram', 'grams', 'กรัม') then 1::numeric
    when lower(trim(p_unit)) in ('kg', 'kilogram', 'กก', 'กก.', 'กิโลกรัม', 'กิโล') then 0.001::numeric
  end;
$$;

-- ต้นทุนต่อเมนู: คิดจากน้ำหนักดิบ (สุทธิ / yield%)
create or replace view menu_item_costs with (security_invoker = true) as
select m.id as menu_item_id,
       m.restaurant_id,
       m.name,
       m.price,
       coalesce(sum(r.quantity_used * 100 / i.yield_pct * i.cost_per_unit), 0)::numeric(12,2) as unit_cost,
       count(r.ingredient_id) as ingredient_count
from menu_items m
left join recipes r on r.menu_item_id = m.id
left join ingredients i on i.id = r.ingredient_id
group by m.id;

-- ===== 2) ของเตรียม / สูตรย่อย =====
create table if not exists prep_components (
  prep_id uuid not null references ingredients(id) on delete cascade,
  ingredient_id uuid not null references ingredients(id) on delete cascade,
  quantity numeric(12,3) not null check (quantity > 0),   -- ปริมาณสุทธิต่อ 1 ถัง (batch)
  primary key (prep_id, ingredient_id),
  check (prep_id <> ingredient_id)
);

create table if not exists prep_batches (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  prep_id uuid not null references ingredients(id) on delete cascade,
  output_qty numeric(12,3) not null check (output_qty > 0),
  note text check (char_length(note) <= 200),
  produced_by uuid references app_users(id) on delete set null,
  produced_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists prep_batches_restaurant_idx on prep_batches (restaurant_id, created_at);

alter table prep_components enable row level security;
alter table prep_batches enable row level security;

drop policy if exists prep_components_read on prep_components;
create policy prep_components_read on prep_components for select
  using (exists (
    select 1 from ingredients p
    where p.id = prep_id and has_role(p.restaurant_id, array['owner', 'stock', 'accountant', 'kitchen'])
  ));
drop policy if exists prep_components_write on prep_components;
create policy prep_components_write on prep_components for all
  using (exists (select 1 from ingredients p where p.id = prep_id and has_role(p.restaurant_id, array['owner', 'stock'])))
  with check (exists (
    select 1 from ingredients p join ingredients c on c.restaurant_id = p.restaurant_id
    where p.id = prep_id and c.id = ingredient_id and p.is_prep and has_role(p.restaurant_id, array['owner', 'stock'])
  ));

drop policy if exists prep_batches_read on prep_batches;
create policy prep_batches_read on prep_batches for select
  using (has_role(restaurant_id, array['owner', 'stock', 'accountant', 'kitchen']));
revoke insert, update, delete on prep_batches from anon, authenticated;

alter table stock_movements add column if not exists batch_id uuid references prep_batches(id) on delete set null;

-- ผลิตของเตรียม: ตัดส่วนผสมตามสัดส่วน (ปริมาณสุทธิ / yield%) แล้วเพิ่มสต็อกของเตรียม
-- ส่วนผสมในระบบไม่พอ ตัดเท่าที่มี (ของถูกทำไปแล้วจริง) รายงานส่วนต่างจะเห็นเอง
create or replace function produce_prep(p_prep_id uuid, p_output_qty numeric, p_note text default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prep ingredients;
  v_id uuid;
  v_name text;
  c record;
  v_need numeric;
begin
  select * into v_prep from ingredients where id = p_prep_id;
  if v_prep.id is null or not v_prep.is_prep then
    raise exception 'invalid_prep';
  end if;
  if not has_role(v_prep.restaurant_id, array['owner', 'stock', 'kitchen']) then
    raise exception 'forbidden';
  end if;
  if p_output_qty is null or p_output_qty <= 0 or p_output_qty > 1000000 then
    raise exception 'invalid_quantity';
  end if;
  if v_prep.batch_output_qty is null then
    raise exception 'batch_output_not_set';
  end if;
  if not exists (select 1 from prep_components where prep_id = p_prep_id) then
    raise exception 'no_components';
  end if;

  select coalesce(display_name, email) into v_name from app_users where id = auth.uid();
  insert into prep_batches (restaurant_id, prep_id, output_qty, note, produced_by, produced_by_name)
  values (v_prep.restaurant_id, p_prep_id, round(p_output_qty, 3), nullif(left(trim(p_note), 200), ''), auth.uid(), v_name)
  returning id into v_id;

  for c in
    select i.id, i.quantity_on_hand, pc.quantity * p_output_qty / v_prep.batch_output_qty * 100 / i.yield_pct as need
    from prep_components pc join ingredients i on i.id = pc.ingredient_id
    where pc.prep_id = p_prep_id
    for update of i
  loop
    v_need := least(round(c.need, 3), c.quantity_on_hand);
    if v_need > 0 then
      insert into stock_movements (restaurant_id, ingredient_id, change, reason, note, batch_id)
      values (v_prep.restaurant_id, c.id, -v_need, 'production', 'ใช้ผลิต ' || v_prep.name, v_id);
    end if;
  end loop;

  insert into stock_movements (restaurant_id, ingredient_id, change, reason, note, batch_id)
  values (v_prep.restaurant_id, p_prep_id, round(p_output_qty, 3), 'production', 'ผลิตได้', v_id);
  return v_id;
end;
$$;
revoke execute on function produce_prep(uuid, numeric, text) from public, anon;
grant execute on function produce_prep(uuid, numeric, text) to authenticated;

-- ===== 3) ใบรับของ =====
create table if not exists stock_receipts (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  supplier text check (char_length(supplier) <= 100),
  invoice_no text check (char_length(invoice_no) <= 50),
  received_on date not null default current_date,
  note text check (char_length(note) <= 300),
  item_count int not null default 0,
  total_cost numeric(12,2) not null default 0,
  expense_id uuid references expenses(id) on delete set null,
  received_by uuid references app_users(id) on delete set null,
  received_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists stock_receipts_restaurant_idx on stock_receipts (restaurant_id, created_at desc);

create table if not exists stock_receipt_lines (
  receipt_id uuid not null references stock_receipts(id) on delete cascade,
  ingredient_id uuid not null references ingredients(id) on delete cascade,
  ingredient_name text not null,
  unit text not null,
  quantity numeric(12,3) not null check (quantity > 0),
  unit_cost numeric(12,4) not null check (unit_cost >= 0),
  line_total numeric(12,2) not null,
  primary key (receipt_id, ingredient_id)
);

alter table stock_receipts enable row level security;
alter table stock_receipt_lines enable row level security;
drop policy if exists stock_receipts_read on stock_receipts;
create policy stock_receipts_read on stock_receipts for select
  using (has_role(restaurant_id, array['owner', 'stock', 'accountant']));
drop policy if exists stock_receipt_lines_read on stock_receipt_lines;
create policy stock_receipt_lines_read on stock_receipt_lines for select
  using (exists (
    select 1 from stock_receipts r where r.id = receipt_id and has_role(r.restaurant_id, array['owner', 'stock', 'accountant'])
  ));
revoke insert, update, delete on stock_receipts, stock_receipt_lines from anon, authenticated;

alter table stock_movements add column if not exists receipt_id uuid references stock_receipts(id) on delete set null;

-- p_lines: [{ "ingredient_id": "...", "quantity": 12.5, "unit_cost": 320 }, ...]
-- ต้นทุนต่อหน่วยใหม่ = (คงเหลือ x ต้นทุนเดิม + รับเข้า x ราคาใหม่) / (คงเหลือ + รับเข้า)
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
           (e->>'quantity')::numeric as qty, (e->>'unit_cost')::numeric as cost
    from jsonb_array_elements(p_lines) e
    join ingredients i on i.id = (e->>'ingredient_id')::uuid and i.restaurant_id = p_restaurant_id
    order by i.name
    for update of i
  loop
    if l.qty is null or l.qty <= 0 or l.qty > 1000000 then raise exception 'invalid_quantity'; end if;
    if l.cost is null or l.cost < 0 then raise exception 'invalid_cost'; end if;

    insert into stock_receipt_lines (receipt_id, ingredient_id, ingredient_name, unit, quantity, unit_cost, line_total)
    values (v_id, l.id, l.name, l.unit, round(l.qty, 3), round(l.cost, 4), round(l.qty * l.cost, 2));

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
revoke execute on function submit_stock_receipt(uuid, jsonb, text, text, date, text, boolean) from public, anon;
grant execute on function submit_stock_receipt(uuid, jsonb, text, text, date, text, boolean) to authenticated;

-- ===== 4) ของเสียแยกประเภท =====
alter table stock_movements add column if not exists waste_type text
  check (waste_type in ('spoiled', 'trim', 'dropped', 'returned', 'expired', 'other'));
alter table stock_movements drop constraint if exists stock_movements_waste_type_reason;
alter table stock_movements add constraint stock_movements_waste_type_reason
  check (waste_type is null or reason = 'waste');

-- ===== 5) ขายตามน้ำหนักจริง =====
alter table menu_items add column if not exists sold_by_weight boolean not null default false;  -- price = ราคาต่อ 1 กก.
alter table menu_items add column if not exists weight_ingredient_id uuid references ingredients(id) on delete set null;
alter table order_items add column if not exists weight_g numeric(10,1) check (weight_g > 0 and weight_g <= 100000);

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
  v_weight numeric;
  v_price numeric(10,2);
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

    -- ขายตามน้ำหนัก: 1 บรรทัด = 1 ครั้งที่ชั่ง ราคาคิดในฐานข้อมูลจากน้ำหนักจริง
    if v_menu.sold_by_weight then
      v_weight := round((v_item->>'weight_g')::numeric, 1);
      if v_weight is null or v_weight <= 0 or v_weight > 100000 then raise exception 'invalid_weight: %', v_menu.name; end if;
      v_qty := 1;
      v_price := round(v_menu.price * v_weight / 1000, 2);
    else
      v_weight := null;
      v_price := v_menu.price;
    end if;

    insert into order_items (order_id, menu_item_id, quantity, unit_price, note, weight_g)
    values (v_order, v_menu.id, v_qty, v_price, nullif(left(trim(v_item->>'note'), 200), ''), v_weight);

    v_subtotal := v_subtotal + v_price * v_qty;
  end loop;

  update orders set subtotal = v_subtotal, discount_total = 0, total = v_subtotal where id = v_order;
  if coalesce(cardinality(p_promotion_ids), 0) > 0 then
    perform apply_promotions(p_restaurant_id, array[v_order], p_promotion_ids);
  end if;
  return v_order;
end;
$$;

-- ===== 6) ตัดสต็อกเมื่อครัวเริ่มทำ: น้ำหนักดิบตามสูตร (/ yield%) + น้ำหนักจริงของของชั่งขาย =====
create or replace function order_ingredient_need(p_order_id uuid, p_restaurant_id uuid)
returns table (ingredient_id uuid, qty numeric)
language sql stable set search_path = public, pg_temp as $$
  select ingredient_id, sum(qty) from (
    select r.ingredient_id, r.quantity_used * oi.quantity * 100 / i.yield_pct as qty
    from order_items oi
    join recipes r on r.menu_item_id = oi.menu_item_id
    join ingredients i on i.id = r.ingredient_id and i.restaurant_id = p_restaurant_id
    where oi.order_id = p_order_id
    union all
    select m.weight_ingredient_id, oi.weight_g * grams_to_unit(i.unit)
    from order_items oi
    join menu_items m on m.id = oi.menu_item_id and m.sold_by_weight
    join ingredients i on i.id = m.weight_ingredient_id and i.restaurant_id = p_restaurant_id
    where oi.order_id = p_order_id and oi.weight_g is not null and grams_to_unit(i.unit) is not null
  ) x
  group by ingredient_id;
$$;

create or replace function deduct_stock_for_order()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.stock_deducted_at is null
     and new.status in ('preparing', 'ready', 'served', 'paid') then
    insert into stock_movements (restaurant_id, ingredient_id, change, reason, order_id)
    select new.restaurant_id, n.ingredient_id, -least(round(n.qty, 3), i.quantity_on_hand), 'sale'::stock_reason, new.id
    from order_ingredient_need(new.id, new.restaurant_id) n
    join ingredients i on i.id = n.ingredient_id
    where least(round(n.qty, 3), i.quantity_on_hand) > 0;

    new.stock_deducted_at := now();
  end if;
  return new;
end;
$$;

-- ===== 7) รายงานส่วนต่างชุดใหญ่ (Mass Variance) =====
-- การใช้ตามทฤษฎีในช่วงเวลา: ย้อนจากออเดอร์ที่ครัวเริ่มทำ (ตามสูตรปัจจุบัน ไม่จำกัดด้วยสต็อกที่มี)
-- + ส่วนผสมที่ควรใช้ผลิตของเตรียมในช่วงนั้น
create or replace function theoretical_usage(p_restaurant_id uuid, p_from timestamptz, p_to timestamptz)
returns table (ingredient_id uuid, sales_qty numeric, production_qty numeric)
language sql stable set search_path = public, pg_temp as $$
  select ingredient_id, sum(s), sum(p) from (
    select n.ingredient_id, n.qty as s, 0::numeric as p
    from orders o
    cross join lateral order_ingredient_need(o.id, o.restaurant_id) n
    where o.restaurant_id = p_restaurant_id and o.stock_deducted_at > p_from and o.stock_deducted_at <= p_to
    union all
    select pc.ingredient_id, 0, pc.quantity * b.output_qty / pi.batch_output_qty * 100 / i.yield_pct
    from prep_batches b
    join ingredients pi on pi.id = b.prep_id and pi.batch_output_qty is not null
    join prep_components pc on pc.prep_id = b.prep_id
    join ingredients i on i.id = pc.ingredient_id
    where b.restaurant_id = p_restaurant_id and b.created_at > p_from and b.created_at <= p_to
  ) x
  group by ingredient_id;
$$;

create or replace function stock_variance(p_restaurant_id uuid, p_start_count uuid, p_end_count uuid)
returns table (
  ingredient_id uuid,
  ingredient_name text,
  unit text,
  category text,
  is_prep boolean,
  yield_pct numeric,
  threshold_pct numeric,
  unit_cost numeric,
  opening numeric,
  purchased numeric,
  produced numeric,
  closing numeric,
  actual_usage numeric,
  sales_usage numeric,
  production_usage numeric,
  theoretical_usage numeric,
  recorded_waste numeric,
  variance numeric,
  variance_pct numeric,
  variance_value numeric,
  unexplained numeric,
  status text
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_from timestamptz;
  v_to timestamptz;
begin
  if not has_role(p_restaurant_id, array['owner', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;
  select created_at into v_from from stock_counts where id = p_start_count and restaurant_id = p_restaurant_id;
  select created_at into v_to from stock_counts where id = p_end_count and restaurant_id = p_restaurant_id;
  if v_from is null or v_to is null then
    raise exception 'invalid_count';
  end if;
  if v_from >= v_to then
    raise exception 'start_after_end';
  end if;

  return query
  with mv as (
    select m.ingredient_id,
           coalesce(sum(m.change) filter (where m.reason = 'purchase'), 0) as purchased,
           coalesce(sum(m.change) filter (where m.reason = 'production' and m.change > 0), 0) as produced,
           coalesce(-sum(m.change) filter (where m.reason = 'waste'), 0) as waste
    from stock_movements m
    where m.restaurant_id = p_restaurant_id and m.created_at > v_from and m.created_at <= v_to
    group by m.ingredient_id
  ),
  th as (select * from theoretical_usage(p_restaurant_id, v_from, v_to)),
  base as (
    select i.id, i.name, i.unit, i.category, i.is_prep, i.yield_pct, i.variance_threshold_pct, i.cost_per_unit,
           s.counted_qty as opening, e.counted_qty as closing,
           coalesce(mv.purchased, 0) as purchased, coalesce(mv.produced, 0) as produced, coalesce(mv.waste, 0) as waste,
           coalesce(th.sales_qty, 0) as sales, coalesce(th.production_qty, 0) as prod_use
    from stock_count_lines s
    join stock_count_lines e on e.ingredient_id = s.ingredient_id and e.count_id = p_end_count
    join ingredients i on i.id = s.ingredient_id
    left join mv on mv.ingredient_id = i.id
    left join th on th.ingredient_id = i.id
    where s.count_id = p_start_count
  ),
  calc as (
    select b.*,
           b.opening + b.purchased + b.produced - b.closing as actual,
           b.sales + b.prod_use as theory
    from base b
  )
  select c.id, c.name, c.unit, c.category, c.is_prep, c.yield_pct, c.variance_threshold_pct, c.cost_per_unit,
         c.opening, round(c.purchased, 3), round(c.produced, 3), c.closing,
         round(c.actual, 3), round(c.sales, 3), round(c.prod_use, 3), round(c.theory, 3), round(c.waste, 3),
         round(c.actual - c.theory, 3),
         case when c.theory > 0 then round((c.actual - c.theory) / c.theory * 100, 2) end,
         round((c.actual - c.theory) * c.cost_per_unit, 2),
         round(c.actual - c.theory - c.waste, 3),
         case
           when round(c.theory, 3) = 0 and round(c.actual, 3) = 0 then 'no_usage'
           when round(c.theory, 3) = 0 then 'alert'
           when abs((c.actual - c.theory) / c.theory * 100) > c.variance_threshold_pct then 'alert'
           else 'ok'
         end
  from calc c
  order by abs((c.actual - c.theory) * c.cost_per_unit) desc, c.name;
end;
$$;

revoke execute on function theoretical_usage(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function order_ingredient_need(uuid, uuid) from public, anon, authenticated;
revoke execute on function stock_variance(uuid, uuid, uuid) from public, anon;
grant execute on function stock_variance(uuid, uuid, uuid) to authenticated;

-- ===== 8) ประวัติสต็อก: เพิ่มประเภทของเสีย (เปลี่ยนชนิดผลลัพธ์ ต้องสร้างใหม่) =====
drop function if exists stock_history(uuid, timestamptz, timestamptz, uuid, stock_reason, int);
create function stock_history(
  p_restaurant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_ingredient_id uuid default null,
  p_reason stock_reason default null,
  p_limit int default 200
)
returns table (
  id uuid,
  created_at timestamptz,
  ingredient_id uuid,
  ingredient_name text,
  unit text,
  change numeric,
  reason stock_reason,
  balance_after numeric,
  cost numeric,
  note text,
  actor_email text,
  order_id uuid,
  order_label text,
  waste_type text
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;

  return query
  select sm.id, sm.created_at, sm.ingredient_id, i.name, i.unit, sm.change, sm.reason, sm.balance_after,
         round(abs(sm.change) * i.cost_per_unit, 2),
         sm.note, coalesce(u.display_name, u.email), sm.order_id,
         case
           when o.id is null then null
           when o.order_type = 'takeaway' then coalesce('กลับบ้าน · ' || o.customer_label, 'กลับบ้าน')
           else coalesce(t.label, 'ไม่ระบุโต๊ะ')
         end,
         sm.waste_type
  from stock_movements sm
  join ingredients i on i.id = sm.ingredient_id
  left join app_users u on u.id = sm.created_by
  left join orders o on o.id = sm.order_id
  left join dining_tables t on t.id = o.table_id
  where sm.restaurant_id = p_restaurant_id
    and sm.created_at >= p_from and sm.created_at < p_to
    and (p_ingredient_id is null or sm.ingredient_id = p_ingredient_id)
    and (p_reason is null or sm.reason = p_reason)
  order by sm.created_at desc, sm.id
  limit least(greatest(p_limit, 1), 1000);
end;
$$;
revoke execute on function stock_history(uuid, timestamptz, timestamptz, uuid, stock_reason, int) from public, anon;
grant execute on function stock_history(uuid, timestamptz, timestamptz, uuid, stock_reason, int) to authenticated;


-- ======================================================================
-- 0024_units.sql
-- ======================================================================
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


-- ======================================================================
-- 0025_receiving_check.sql
-- ======================================================================
-- 0025: แยกการนับสต็อก 2 แบบ
--   แบบที่ 1 นับตอนรับเข้า (ใบรับของ = Goods Received Note เทียบบิล)
--     - แต่ละบรรทัด: ตามบิล (จำนวน/หน่วยบนบิล) เทียบ รับจริง (ชั่ง/นับเอง)
--     - อาหารทะเลแช่แข็ง: น้ำหนักรวม (มีน้ำแข็ง) และน้ำหนักสุทธิหลังละลายน้ำแข็ง -> % น้ำแข็ง (glaze)
--     - สต็อกเพิ่มตาม "รับจริง" · ต้นทุน = รับจริง x ราคาต่อหน่วยในบิล
--     - ขาดเกินเกณฑ์ (ค่าเริ่มต้น ±2%) = ขาด/เกิน · รับจริง 0 = ตีกลับ · ส่วนที่ขาดเป็นยอด "รอทวง" ติดตามจนได้ลดหนี้
--   แบบที่ 2 นับตอนนับล่าสุด (ใบตรวจนับ): รายสัปดาห์ (เฉพาะวัตถุดิบที่ติ๊กนับทุกสัปดาห์) / รายเดือน (ทั้งหมด)
--   + รายงานผู้ขาย และสรุป "รับเข้าล่าสุด / นับล่าสุด" ต่อวัตถุดิบ

-- ===== 1) ตั้งค่า =====
alter table shop_settings add column if not exists receive_tolerance_pct numeric(5,2) not null default 2
  check (receive_tolerance_pct >= 0 and receive_tolerance_pct <= 50);
alter table shop_settings add column if not exists glaze_max_pct numeric(5,2) not null default 12
  check (glaze_max_pct >= 0 and glaze_max_pct <= 60);
alter table ingredients add column if not exists count_weekly boolean not null default false;  -- รายการสำคัญ นับทุกสัปดาห์
grant update (count_weekly) on ingredients to authenticated;

-- ===== 2) ใบรับของ: ตามบิล vs รับจริง =====
alter table stock_receipt_lines alter column quantity drop not null;
alter table stock_receipt_lines drop constraint if exists stock_receipt_lines_quantity_check;
alter table stock_receipt_lines add constraint stock_receipt_lines_quantity_check check (quantity >= 0);
alter table stock_receipt_lines add column if not exists invoice_qty numeric(12,3) check (invoice_qty >= 0);   -- ตามบิล (หน่วยหลัก)
alter table stock_receipt_lines add column if not exists invoice_unit text;                                    -- หน่วยบนบิล เช่น ลัง
alter table stock_receipt_lines add column if not exists invoice_unit_qty numeric(12,3);                       -- จำนวนบนบิล เช่น 3
alter table stock_receipt_lines add column if not exists gross_qty numeric(12,3) check (gross_qty >= 0);       -- น้ำหนักรวมก่อนละลายน้ำแข็ง
alter table stock_receipt_lines add column if not exists status text not null default 'ok'
  check (status in ('ok', 'short', 'over', 'rejected'));
alter table stock_receipt_lines add column if not exists claim_value numeric(12,2) not null default 0;        -- มูลค่าที่ขาด (รอทวง)
alter table stock_receipt_lines add column if not exists claim_status text not null default 'none'
  check (claim_status in ('none', 'pending', 'credited', 'accepted'));
alter table stock_receipt_lines add column if not exists prev_unit_cost numeric(12,4);                        -- ราคาครั้งก่อน (ผู้ขายเดิม)
alter table stock_receipt_lines add column if not exists line_note text check (char_length(line_note) <= 200);

alter table stock_receipts add column if not exists invoice_total numeric(12,2) not null default 0;   -- ยอดตามบิล
alter table stock_receipts add column if not exists claim_total numeric(12,2) not null default 0;     -- รอทวงที่ยังไม่จบ

-- ใบเก่าก่อน 0025: ถือว่าตามบิล = รับจริง
update stock_receipt_lines set invoice_qty = quantity where invoice_qty is null;
update stock_receipts set invoice_total = total_cost where invoice_total = 0 and total_cost > 0;

-- p_lines: [{
--   "ingredient_id": "...",
--   "quantity": 25.4,            รับจริง (หน่วยหลัก สุทธิ) · 0 = ตีกลับทั้งบรรทัด
--   "unit_cost": 40,             ราคาต่อหน่วยหลักตามบิล
--   "invoice_qty": 30,           ตามบิล (หน่วยหลัก) ไม่ส่ง = เท่ารับจริง
--   "invoice_unit": "ลัง", "invoice_unit_qty": 3,      หน่วย/จำนวนบนบิล (ไม่บังคับ)
--   "gross_qty": 30.2,           น้ำหนักรวมก่อนละลายน้ำแข็ง (ไม่บังคับ)
--   "entered_unit": ..., "entered_qty": ..., "entered_unit_cost": ...,   ที่กรอกจริง (0024)
--   "note": "ลังบุบ 1 ลัง"
-- }]
-- ยอดตามบิลบันทึกเป็นรายจ่าย (จ่ายตามบิล) ได้ลดหนี้ภายหลัง -> หักออกจากรายจ่ายให้
drop function if exists submit_stock_receipt(uuid, jsonb, text, text, date, text, boolean);
create function submit_stock_receipt(
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
  v_tol numeric;
  v_received_total numeric := 0;
  v_invoice_total numeric := 0;
  v_claim_total numeric := 0;
  v_items int := 0;
  v_expense uuid;
  v_label text;
  v_supplier text := nullif(left(trim(p_supplier), 100), '');
  v_inv numeric;
  v_status text;
  v_claim numeric;
  v_prev numeric;
  v_diff_unit boolean;
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

  select coalesce((select receive_tolerance_pct from shop_settings where restaurant_id = p_restaurant_id), 2) into v_tol;
  select coalesce(display_name, email) into v_name from app_users where id = auth.uid();
  insert into stock_receipts (restaurant_id, supplier, invoice_no, received_on, note, received_by, received_by_name)
  values (p_restaurant_id, v_supplier, nullif(left(trim(p_invoice_no), 50), ''),
          coalesce(p_received_on, current_date), nullif(left(trim(p_note), 300), ''), auth.uid(), v_name)
  returning id into v_id;
  v_label := 'รับของ' || coalesce(' ' || v_supplier, '') || coalesce(' บิล ' || nullif(trim(p_invoice_no), ''), '');

  for l in
    select i.id, i.name, i.unit, i.quantity_on_hand, i.cost_per_unit,
           (e->>'quantity')::numeric as qty, (e->>'unit_cost')::numeric as cost,
           (e->>'invoice_qty')::numeric as inv_qty,
           nullif(left(trim(e->>'invoice_unit'), 30), '') as inv_unit,
           (e->>'invoice_unit_qty')::numeric as inv_unit_qty,
           (e->>'gross_qty')::numeric as gross,
           nullif(left(trim(e->>'entered_unit'), 30), '') as e_unit,
           (e->>'entered_qty')::numeric as e_qty, (e->>'entered_unit_cost')::numeric as e_cost,
           nullif(left(trim(e->>'note'), 200), '') as line_note
    from jsonb_array_elements(p_lines) e
    join ingredients i on i.id = (e->>'ingredient_id')::uuid and i.restaurant_id = p_restaurant_id
    order by i.name
    for update of i
  loop
    if l.qty is null or l.qty < 0 or l.qty > 1000000 then raise exception 'invalid_quantity'; end if;
    if l.cost is null or l.cost < 0 then raise exception 'invalid_cost'; end if;
    if l.inv_qty is not null and (l.inv_qty < 0 or l.inv_qty > 1000000) then raise exception 'invalid_quantity'; end if;
    if l.gross is not null and l.gross < l.qty then raise exception 'gross_less_than_net: %', l.name; end if;
    v_inv := coalesce(l.inv_qty, l.qty);
    if v_inv = 0 and l.qty = 0 then raise exception 'invalid_quantity'; end if;

    -- ผลตรวจรับ: ห่างจากบิลเกินเกณฑ์ % = ขาด/เกิน · รับ 0 = ตีกลับ
    v_status := case
      when l.qty = 0 then 'rejected'
      when l.qty < v_inv * (1 - v_tol / 100) then 'short'
      when l.qty > v_inv * (1 + v_tol / 100) then 'over'
      else 'ok'
    end;
    v_claim := case when v_status in ('short', 'rejected') then round((v_inv - l.qty) * l.cost, 2) else 0 end;

    select rl.unit_cost into v_prev
    from stock_receipt_lines rl join stock_receipts r on r.id = rl.receipt_id
    where rl.ingredient_id = l.id and r.id <> v_id and r.restaurant_id = p_restaurant_id
      and (v_supplier is null or r.supplier = v_supplier)
    order by r.created_at desc limit 1;

    v_diff_unit := l.e_unit is not null and l.e_unit <> l.unit;
    insert into stock_receipt_lines (receipt_id, ingredient_id, ingredient_name, unit, quantity, unit_cost, line_total,
                                     entered_unit, entered_qty, entered_unit_cost,
                                     invoice_qty, invoice_unit, invoice_unit_qty, gross_qty,
                                     status, claim_value, claim_status, prev_unit_cost, line_note)
    values (v_id, l.id, l.name, l.unit, round(l.qty, 3), round(l.cost, 4), round(l.qty * l.cost, 2),
            case when v_diff_unit then l.e_unit end, case when v_diff_unit then round(l.e_qty, 3) end,
            case when v_diff_unit then round(l.e_cost, 4) end,
            round(v_inv, 3), l.inv_unit, round(l.inv_unit_qty, 3), round(l.gross, 3),
            v_status, v_claim, case when v_claim > 0 then 'pending' else 'none' end, v_prev, l.line_note);

    if l.qty > 0 then
      update ingredients
         set cost_per_unit = round((l.quantity_on_hand * l.cost_per_unit + l.qty * l.cost) / (l.quantity_on_hand + l.qty), 4)
       where id = l.id;
      insert into stock_movements (restaurant_id, ingredient_id, change, reason, note, receipt_id)
      values (p_restaurant_id, l.id, round(l.qty, 3), 'purchase', v_label, v_id);
    end if;

    v_received_total := v_received_total + round(l.qty * l.cost, 2);
    v_invoice_total := v_invoice_total + round(v_inv * l.cost, 2);
    v_claim_total := v_claim_total + v_claim;
    v_items := v_items + 1;
  end loop;

  if p_record_expense and v_invoice_total > 0 then
    insert into expenses (restaurant_id, category, amount, spent_on, note)
    values (p_restaurant_id, 'ingredients', v_invoice_total, coalesce(p_received_on, current_date), left(v_label, 200))
    returning id into v_expense;
  end if;

  update stock_receipts
     set item_count = v_items, total_cost = v_received_total, invoice_total = v_invoice_total,
         claim_total = v_claim_total, expense_id = v_expense
   where id = v_id;
  return v_id;
end;
$$;
revoke execute on function submit_stock_receipt(uuid, jsonb, text, text, date, text, boolean) from public, anon;
grant execute on function submit_stock_receipt(uuid, jsonb, text, text, date, text, boolean) to authenticated;

-- ติดตามยอดที่ขาด: pending (รอทวง) -> credited (ได้ลดหนี้) / accepted (ยอมรับ ไม่ทวง)
-- ได้ลดหนี้: หักมูลค่าออกจากรายจ่ายของใบนั้น (ถ้าบันทึกรายจ่ายไว้)
create or replace function set_receipt_claim(p_receipt_id uuid, p_ingredient_id uuid, p_status text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rid uuid;
  v_expense uuid;
  v_invoice numeric;
begin
  select restaurant_id, expense_id, invoice_total into v_rid, v_expense, v_invoice from stock_receipts where id = p_receipt_id;
  if v_rid is null or not has_role(v_rid, array['owner', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;
  if p_status not in ('pending', 'credited', 'accepted') then
    raise exception 'invalid_status';
  end if;
  update stock_receipt_lines set claim_status = p_status
   where receipt_id = p_receipt_id and ingredient_id = p_ingredient_id and claim_value > 0;
  if not found then
    raise exception 'not_found';
  end if;
  update stock_receipts
     set claim_total = (select coalesce(sum(claim_value), 0) from stock_receipt_lines where receipt_id = p_receipt_id and claim_status = 'pending')
   where id = p_receipt_id;
  if v_expense is not null then
    update expenses
       set amount = v_invoice - (select coalesce(sum(claim_value), 0) from stock_receipt_lines where receipt_id = p_receipt_id and claim_status = 'credited')
     where id = v_expense;
  end if;
end;
$$;
revoke execute on function set_receipt_claim(uuid, uuid, text) from public, anon;
grant execute on function set_receipt_claim(uuid, uuid, text) to authenticated;

-- ===== 3) ใบตรวจนับ: รายสัปดาห์ / รายเดือน =====
alter table stock_counts add column if not exists count_type text not null default 'spot'
  check (count_type in ('weekly', 'monthly', 'spot'));

drop function if exists submit_stock_count(uuid, jsonb, text);
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
begin
  if not has_role(p_restaurant_id, array['owner', 'stock']) then
    raise exception 'forbidden';
  end if;
  if coalesce(p_count_type, 'spot') not in ('weekly', 'monthly', 'spot') then
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
    where not exists (
      select 1 from ingredients i where i.id = (e->>'ingredient_id')::uuid and i.restaurant_id = p_restaurant_id
    )
  ) then
    raise exception 'invalid_ingredient';
  end if;

  select coalesce(display_name, email) into v_name from app_users where id = auth.uid();
  insert into stock_counts (restaurant_id, counted_by, counted_by_name, note, count_type)
  values (p_restaurant_id, auth.uid(), v_name, nullif(left(trim(p_note), 300), ''), coalesce(p_count_type, 'spot'))
  returning id into v_id;

  for l in
    select i.id, i.name, i.unit, i.quantity_on_hand, i.cost_per_unit,
           (e->>'counted_qty')::numeric as counted, e->>'entered_text' as entered
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
revoke execute on function submit_stock_count(uuid, jsonb, text, text) from public, anon;
grant execute on function submit_stock_count(uuid, jsonb, text, text) to authenticated;

-- ===== 4) สรุปต่อวัตถุดิบ: รับเข้าล่าสุด / นับล่าสุด (ใช้สิทธิ์ผู้เรียก) =====
create or replace function ingredient_last_activity(p_restaurant_id uuid)
returns table (
  ingredient_id uuid,
  received_at timestamptz,
  received_qty numeric,
  received_invoice_qty numeric,
  received_status text,
  counted_at timestamptz,
  counted_qty numeric,
  count_diff numeric
)
language sql stable security invoker set search_path = public, pg_temp as $$
  select i.id, rc.created_at, rc.quantity, rc.invoice_qty, rc.status, ct.created_at, ct.counted_qty, ct.diff
  from ingredients i
  left join lateral (
    select r.created_at, rl.quantity, rl.invoice_qty, rl.status
    from stock_receipt_lines rl join stock_receipts r on r.id = rl.receipt_id
    where rl.ingredient_id = i.id
    order by r.created_at desc limit 1
  ) rc on true
  left join lateral (
    select c.created_at, cl.counted_qty, cl.diff
    from stock_count_lines cl join stock_counts c on c.id = cl.count_id
    where cl.ingredient_id = i.id
    order by c.created_at desc limit 1
  ) ct on true
  where i.restaurant_id = p_restaurant_id;
$$;
grant execute on function ingredient_last_activity(uuid) to authenticated;

-- ===== 5) รายงานผู้ขาย =====
create or replace function supplier_receiving_report(p_restaurant_id uuid, p_from date, p_to date)
returns table (
  supplier text,
  receipts bigint,
  lines bigint,
  invoice_value numeric,
  received_value numeric,
  claim_pending numeric,
  claim_credited numeric,
  claim_accepted numeric,
  gap_pct numeric,
  short_lines bigint,
  rejected_lines bigint,
  glaze_pct numeric,
  glaze_over_lines bigint,
  price_up_lines bigint
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_glaze numeric;
begin
  if not has_role(p_restaurant_id, array['owner', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;
  select coalesce((select glaze_max_pct from shop_settings where restaurant_id = p_restaurant_id), 12) into v_glaze;

  return query
  select coalesce(r.supplier, 'ไม่ระบุผู้ขาย'),
         count(distinct r.id),
         count(*),
         round(sum(rl.invoice_qty * rl.unit_cost), 2),
         round(sum(rl.quantity * rl.unit_cost), 2),
         coalesce(sum(rl.claim_value) filter (where rl.claim_status = 'pending'), 0),
         coalesce(sum(rl.claim_value) filter (where rl.claim_status = 'credited'), 0),
         coalesce(sum(rl.claim_value) filter (where rl.claim_status = 'accepted'), 0),
         case when sum(rl.invoice_qty * rl.unit_cost) > 0
              then round(sum(rl.claim_value) / sum(rl.invoice_qty * rl.unit_cost) * 100, 2) end,
         count(*) filter (where rl.status = 'short'),
         count(*) filter (where rl.status = 'rejected'),
         case when sum(rl.gross_qty) filter (where rl.gross_qty > 0) > 0
              then round(sum(rl.gross_qty - rl.quantity) filter (where rl.gross_qty > 0)
                         / sum(rl.gross_qty) filter (where rl.gross_qty > 0) * 100, 2) end,
         count(*) filter (where rl.gross_qty > 0 and (rl.gross_qty - rl.quantity) / rl.gross_qty * 100 > v_glaze),
         count(*) filter (where rl.prev_unit_cost > 0 and rl.unit_cost > rl.prev_unit_cost * 1.1)
  from stock_receipts r
  join stock_receipt_lines rl on rl.receipt_id = r.id
  where r.restaurant_id = p_restaurant_id and r.received_on between p_from and p_to
  group by coalesce(r.supplier, 'ไม่ระบุผู้ขาย')
  order by 9 desc nulls last, 1;
end;
$$;
revoke execute on function supplier_receiving_report(uuid, date, date) from public, anon;
grant execute on function supplier_receiving_report(uuid, date, date) to authenticated;


-- ======================================================================
-- 0026_accounting.sql
-- ======================================================================
-- 0026: โมดูลบัญชี (บัญชีคู่ double-entry เชื่อมกับโมดูลสต็อก)
--   หลักการ
--   - ทุกเหตุการณ์ลงสมุดรายวัน (journal_entries + journal_lines) อัตโนมัติ เดบิต = เครดิต ทุกรายการ
--     ตรวจตอน commit ด้วย constraint trigger (deferred) · รายการที่ลงแล้วแก้/ลบไม่ได้ ต้องกลับรายการ (reversal)
--   - สต็อกแบบ perpetual: ซื้อเข้า = สินทรัพย์ · ตัดตามสูตร = ต้นทุนขาย · นับ/ของเสีย/ผลิต = ส่วนต่างสต็อก
--     มูลค่าสต็อกต่อวัตถุดิบ = round(คงเหลือ x ต้นทุนต่อหน่วย, 2) ทุกครั้งที่มูลค่าเปลี่ยน ลงบัญชีด้วยผลต่างนั้น
--     บัญชีสต็อกจึงเท่ากับมูลค่าในโมดูลสต็อกเสมอ (acct_stock_reconcile ตรวจซ้ำ ไม่เท่า = แจ้งเตือน)
--   - ต้นทุนขายจริง = ต้นทุนตามสูตร (5010) + ส่วนต่างสต็อก (5020) = ต้นงวด + รับเข้า - ปลายงวด
--   - ปิดวันแล้ว: ห้ามลงรายการใหม่ในวันนั้น · รายการอัตโนมัติที่เกิดหลังปิดวันเข้าวันถัดไป
--   - ไม่ลงย้อนหลังให้ออเดอร์นำเข้า (import_batch) และข้อมูลทดลอง (is_demo) · ยอดสต็อกเดิมลงเป็นยอดยกมา
--   หมายเหตุ: ระบบนี้ไม่ใช่เครื่องมือยื่นภาษีอย่างเป็นทางการ ควรให้นักบัญชีตรวจ

-- ===== 1) ผังบัญชี =====
create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  code text not null check (code ~ '^[0-9]{4}$'),
  name text not null check (char_length(trim(name)) between 1 and 80),
  type text not null check (type in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  -- กลุ่มสำหรับรายงาน: เงินสด/ธนาคาร (โหมดง่าย) ยอดขาย/ส่วนลด ต้นทุนอาหาร/ค่าแรง/ค่าใช้จ่ายดำเนินงาน (Food/Prime Cost)
  grp text not null check (grp in ('cash', 'bank', 'stock', 'claim', 'vat_in', 'other_asset',
                                   'ap', 'vat_out', 'other_liability', 'equity',
                                   'sales', 'discount', 'other_income',
                                   'food_cost', 'labor', 'opex')),
  system_key text,                                -- บัญชีที่ระบบใช้ลงอัตโนมัติ (ลบ/เปลี่ยนกลุ่มไม่ได้)
  is_active boolean not null default true,
  legacy_category expense_category,               -- หมวดรายจ่ายแบบเดิม (0001) ที่ตรงกับบัญชีนี้
  created_at timestamptz not null default now(),
  unique (restaurant_id, code),
  unique (restaurant_id, system_key),
  check (
    (type = 'asset' and grp in ('cash', 'bank', 'stock', 'claim', 'vat_in', 'other_asset'))
    or (type = 'liability' and grp in ('ap', 'vat_out', 'other_liability'))
    or (type = 'equity' and grp = 'equity')
    or (type = 'revenue' and grp in ('sales', 'discount', 'other_income'))
    or (type = 'expense' and grp in ('food_cost', 'labor', 'opex'))
  )
);

create or replace function acct_seed_accounts(p_restaurant_id uuid)
returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into accounts (restaurant_id, code, name, type, grp, system_key, legacy_category)
  select p_restaurant_id, a.code, a.name, a.type, a.grp, a.key, a.legacy::expense_category
  from (values
    ('1010', 'เงินสด',                       'asset',     'cash',         'cash',            null),
    ('1020', 'ธนาคาร / QR พร้อมเพย์',          'asset',     'bank',         'bank',            null),
    ('1130', 'สต็อกวัตถุดิบ',                  'asset',     'stock',        'stock',           null),
    ('1140', 'ลูกหนี้ผู้ขาย (ของขาด รอทวง)',     'asset',     'claim',        'claim',           null),
    ('1150', 'ภาษีซื้อ',                       'asset',     'vat_in',       'vat_in',          null),
    ('2010', 'เจ้าหนี้การค้า',                  'liability', 'ap',           'ap',              null),
    ('2030', 'ภาษีขาย',                        'liability', 'vat_out',      'vat_out',         null),
    ('3010', 'ทุนเจ้าของ',                     'equity',    'equity',       'equity',          null),
    ('4010', 'รายได้ขายอาหาร',                 'revenue',   'sales',        'rev_food',        null),
    ('4020', 'รายได้เครื่องดื่ม',                'revenue',   'sales',        'rev_drink',       null),
    ('4110', 'ส่วนลดโปรโมชัน',                 'revenue',   'discount',     'disc_promo',      null),
    ('4120', 'ส่วนลดจากแต้มสมาชิก',             'revenue',   'discount',     'disc_points',     null),
    ('5010', 'ต้นทุนขาย (ตามสูตร)',             'expense',   'food_cost',    'cogs',            null),
    ('5020', 'ส่วนต่างสต็อก',                  'expense',   'food_cost',    'variance',        null),
    ('5030', 'วัตถุดิบนอกสต็อก',                'expense',   'food_cost',    'cogs_direct',     'ingredients'),
    ('5040', 'ส่วนต่างรับสินค้า',                'expense',   'food_cost',    'recv_variance',   null),
    ('5110', 'ค่าแรง',                         'expense',   'labor',        'labor',           'labor'),
    ('5210', 'ค่าเช่า',                        'expense',   'opex',         'rent',            'rent'),
    ('5220', 'ค่าน้ำไฟ',                       'expense',   'opex',         'utilities',       'utilities'),
    ('5230', 'ค่าการตลาด',                     'expense',   'opex',         'marketing',       null),
    ('5240', 'ค่า GP เดลิเวอรี่',               'expense',   'opex',         'delivery_gp',     null),
    ('5250', 'ค่าแพ็กเกจจิ้ง',                  'expense',   'opex',         'packaging',       null),
    ('5260', 'เงินสดขาด/เกิน',                 'expense',   'opex',         'cash_over_short', null),
    ('5290', 'ค่าใช้จ่ายอื่น',                   'expense',   'opex',         'other_exp',       'other')
  ) as a(code, name, type, grp, key, legacy)
  on conflict do nothing;
$$;
revoke execute on function acct_seed_accounts(uuid) from public, anon, authenticated;

select acct_seed_accounts(id) from restaurants;

create or replace function restaurants_seed_accounts()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform acct_seed_accounts(new.id);
  return new;
end;
$$;
drop trigger if exists restaurants_seed_accounts on restaurants;
create trigger restaurants_seed_accounts after insert on restaurants
  for each row execute function restaurants_seed_accounts();

-- บัญชีระบบ: เปลี่ยนรหัส/กลุ่ม/ปิดใช้งานไม่ได้ (แก้ชื่อได้) · บัญชีที่มีรายการแล้วลบไม่ได้ (foreign key)
create or replace function accounts_guard()
returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if old.system_key is not null and exists (select 1 from restaurants where id = old.restaurant_id) then
      raise exception 'system_account';
    end if;
    return old;
  end if;
  if old.system_key is not null and (new.code <> old.code or new.type <> old.type or new.grp <> old.grp
                                     or new.system_key is distinct from old.system_key or not new.is_active) then
    raise exception 'system_account';
  end if;
  if new.restaurant_id <> old.restaurant_id then
    raise exception 'invalid_request';
  end if;
  return new;
end;
$$;
drop trigger if exists accounts_guard on accounts;
create trigger accounts_guard before update or delete on accounts
  for each row execute function accounts_guard();

alter table accounts enable row level security;
drop policy if exists accounts_read on accounts;
create policy accounts_read on accounts for select
  using (has_role(restaurant_id, array['owner', 'manager', 'accountant']));
-- ร้านเพิ่มหมวดเองได้ (เจ้าของ + พนักงานบัญชี) · บัญชีระบบสร้างโดยระบบเท่านั้น
drop policy if exists accounts_write on accounts;
create policy accounts_write on accounts for all
  using (has_role(restaurant_id, array['owner', 'accountant']))
  with check (has_role(restaurant_id, array['owner', 'accountant']));  -- system_key ไม่อยู่ในสิทธิ์คอลัมน์ ผู้ใช้ตั้งเองไม่ได้
revoke insert, update, delete on accounts from anon, authenticated;
grant insert (restaurant_id, code, name, type, grp, is_active) on accounts to authenticated;
grant update (name, is_active) on accounts to authenticated;
grant delete on accounts to authenticated;

create or replace function acct_account(p_restaurant_id uuid, p_key text)
returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v uuid;
begin
  select id into v from accounts where restaurant_id = p_restaurant_id and system_key = p_key;
  if v is null then
    raise exception 'account_missing: %', p_key;
  end if;
  return v;
end;
$$;
revoke execute on function acct_account(uuid, text) from public, anon, authenticated;

-- ===== 2) สมุดรายวัน =====
create table if not exists journal_entries (
  id uuid primary key default gen_random_uuid(),
  entry_no bigint generated always as identity,
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  entry_date date not null,
  source_type text not null check (source_type in (
    'bill', 'stock_receipt', 'recipe_deduct', 'count_adjust', 'expense', 'reversal', 'day_close',
    'waste', 'production', 'stock_revalue', 'supplier_claim', 'supplier_payment', 'opening')),
  source_id uuid,
  memo text check (char_length(memo) <= 300),
  reverses_entry_id uuid references journal_entries(id),
  reason text check (char_length(reason) <= 300),
  created_by uuid,                                 -- ไม่ผูก FK: ลบผู้ใช้แล้วรายการยังต้องอยู่ครบ (แก้รายการไม่ได้)
  created_at timestamptz not null default now(),
  created_txid bigint not null default txid_current()
);
create index if not exists journal_entries_restaurant_date_idx on journal_entries (restaurant_id, entry_date);
create index if not exists journal_entries_source_idx on journal_entries (restaurant_id, source_type, source_id);
create unique index if not exists journal_entries_reverses_key on journal_entries (reverses_entry_id) where reverses_entry_id is not null;

create table if not exists journal_lines (
  id bigint generated always as identity primary key,
  entry_id uuid not null references journal_entries(id) on delete cascade,
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  account_id uuid not null references accounts(id),
  debit numeric(14,2) not null default 0 check (debit >= 0),
  credit numeric(14,2) not null default 0 check (credit >= 0),
  ingredient_id uuid,                              -- รายละเอียดสต็อก (ไม่ผูก FK: ลบวัตถุดิบแล้วประวัติยังอยู่)
  memo text check (char_length(memo) <= 200),
  check ((debit > 0) <> (credit > 0))              -- 1 บรรทัด = เดบิตหรือเครดิตอย่างใดอย่างหนึ่ง
);
create index if not exists journal_lines_entry_idx on journal_lines (entry_id);
create index if not exists journal_lines_account_idx on journal_lines (restaurant_id, account_id);

-- ลงแล้วแก้/ลบไม่ได้ (ยกเว้นลบทั้งร้าน) · เพิ่มบรรทัดได้เฉพาะรายการที่สร้างในธุรกรรมเดียวกัน
create or replace function journal_immutable()
returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from journal_entries where id = new.entry_id and created_txid = txid_current()) then
      raise exception 'journal_immutable';
    end if;
    if new.restaurant_id <> (select restaurant_id from journal_entries where id = new.entry_id) then
      raise exception 'invalid_request';
    end if;
    if not exists (select 1 from accounts where id = new.account_id and restaurant_id = new.restaurant_id) then
      raise exception 'invalid_account';
    end if;
    return new;
  end if;
  if exists (select 1 from restaurants where id = old.restaurant_id) then
    raise exception 'journal_immutable';
  end if;
  return old;
end;
$$;
drop trigger if exists journal_lines_immutable on journal_lines;
create trigger journal_lines_immutable before insert or update or delete on journal_lines
  for each row execute function journal_immutable();
drop trigger if exists journal_entries_immutable on journal_entries;
create trigger journal_entries_immutable before update or delete on journal_entries
  for each row execute function journal_immutable();

-- เดบิต = เครดิต ต่อรายการ (ตรวจตอน commit ให้ฟังก์ชันเพิ่มบรรทัดทีละบรรทัดได้)
-- ตรวจทั้งตอนสร้างรายการ (ต้องมีอย่างน้อย 2 บรรทัด) และทุกบรรทัดที่เพิ่ม
create or replace function journal_check_balanced()
returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_entry uuid := case when tg_table_name = 'journal_entries' then new.id::text else to_jsonb(new)->>'entry_id' end;
  v_dr numeric;
  v_cr numeric;
  v_n int;
begin
  if not exists (select 1 from journal_entries where id = v_entry) then
    return null;
  end if;
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*) into v_dr, v_cr, v_n
  from journal_lines where entry_id = v_entry;
  if v_n < 2 or v_dr <> v_cr then
    raise exception 'journal_unbalanced: entry % debit % credit % lines %', v_entry, v_dr, v_cr, v_n;
  end if;
  return null;
end;
$$;
drop trigger if exists journal_entries_balanced on journal_entries;
create constraint trigger journal_entries_balanced after insert on journal_entries
  deferrable initially deferred
  for each row execute function journal_check_balanced();
drop trigger if exists journal_lines_balanced on journal_lines;
create constraint trigger journal_lines_balanced after insert on journal_lines
  deferrable initially deferred
  for each row execute function journal_check_balanced();

alter table journal_entries enable row level security;
alter table journal_lines enable row level security;
drop policy if exists journal_entries_read on journal_entries;
create policy journal_entries_read on journal_entries for select
  using (has_role(restaurant_id, array['owner', 'manager', 'accountant']));
drop policy if exists journal_lines_read on journal_lines;
create policy journal_lines_read on journal_lines for select
  using (has_role(restaurant_id, array['owner', 'manager', 'accountant']));
revoke insert, update, delete on journal_entries, journal_lines from anon, authenticated;

-- ===== 3) ตั้งค่าบัญชีของร้าน =====
alter table shop_settings add column if not exists accounting_mode text not null default 'standard'
  check (accounting_mode in ('simple', 'standard', 'pro'));
alter table shop_settings add column if not exists business_type text not null default 'individual'
  check (business_type in ('individual', 'company'));
alter table shop_settings add column if not exists vat_registered boolean not null default false;
alter table shop_settings add column if not exists vat_rate numeric(5,2) not null default 7
  check (vat_rate >= 0 and vat_rate <= 30);
alter table shop_settings add column if not exists receipt_payment_default text not null default 'cash'
  check (receipt_payment_default in ('cash', 'bank', 'credit'));       -- ใบรับของจ่ายด้วยอะไร (credit = ค้างเจ้าหนี้)
alter table shop_settings add column if not exists food_cost_target_min numeric(5,2) not null default 28;
alter table shop_settings add column if not exists food_cost_target_max numeric(5,2) not null default 35;
alter table shop_settings add column if not exists prime_cost_target_min numeric(5,2) not null default 60;
alter table shop_settings add column if not exists prime_cost_target_max numeric(5,2) not null default 65;
alter table shop_settings add column if not exists accounting_onboarded_at timestamptz;
alter table shop_settings drop constraint if exists shop_settings_cost_targets_check;
alter table shop_settings add constraint shop_settings_cost_targets_check check (
  food_cost_target_min between 0 and 100 and food_cost_target_max between food_cost_target_min and 100
  and prime_cost_target_min between 0 and 100 and prime_cost_target_max between prime_cost_target_min and 100);

-- รายได้แยกตามหมวดเมนู (ว่าง = รายได้ขายอาหาร)
alter table menu_categories add column if not exists revenue_account_id uuid references accounts(id) on delete set null;
update menu_categories c set revenue_account_id = a.id
from accounts a
where a.restaurant_id = c.restaurant_id and a.system_key = 'rev_drink' and c.revenue_account_id is null
  and c.name ~* '(เครื่องดื่ม|drink|beverage|กาแฟ|coffee)';

create or replace function menu_categories_check_revenue_account()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- หมวดใหม่ชื่อแนวเครื่องดื่ม: ผูกรายได้เครื่องดื่มให้ (เปลี่ยนได้ที่หน้าตั้งค่าบัญชี)
  if tg_op = 'INSERT' and new.revenue_account_id is null and new.name ~* '(เครื่องดื่ม|drink|beverage|กาแฟ|coffee)' then
    select id into new.revenue_account_id from accounts where restaurant_id = new.restaurant_id and system_key = 'rev_drink';
  end if;
  if new.revenue_account_id is not null and not exists (
    select 1 from accounts where id = new.revenue_account_id and restaurant_id = new.restaurant_id and grp = 'sales'
  ) then
    raise exception 'invalid_account';
  end if;
  return new;
end;
$$;
drop trigger if exists menu_categories_revenue_account on menu_categories;
create trigger menu_categories_revenue_account before insert or update of revenue_account_id on menu_categories
  for each row execute function menu_categories_check_revenue_account();

-- ===== 4) วันที่ลงบัญชี + ปิดวัน =====
create table if not exists day_closes (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  close_date date not null,
  system_cash numeric(14,2) not null,              -- ยอดเงินสดตามบัญชี ณ สิ้นวัน
  counted_cash numeric(14,2) not null check (counted_cash >= 0),
  difference numeric(14,2) not null,               -- นับจริง - ระบบ (+ เกิน / - ขาด)
  summary jsonb not null default '{}',
  note text check (char_length(note) <= 300),
  confirmed_by uuid references app_users(id) on delete set null,
  confirmed_by_name text,
  created_at timestamptz not null default now(),
  unique (restaurant_id, close_date)
);
alter table day_closes enable row level security;
drop policy if exists day_closes_read on day_closes;
create policy day_closes_read on day_closes for select
  using (has_role(restaurant_id, array['owner', 'manager', 'accountant']));
revoke insert, update, delete on day_closes from anon, authenticated;

create or replace function acct_today(p_restaurant_id uuid)
returns date
language sql stable security definer set search_path = public, pg_temp as $$
  select (now() at time zone coalesce((select timezone from restaurants where id = p_restaurant_id), 'Asia/Bangkok'))::date;
$$;

-- วันที่ยังไม่ปิดวันแรกที่ >= p_date (รายการอัตโนมัติหลังปิดวันเข้าวันถัดไป)
create or replace function acct_open_date(p_restaurant_id uuid, p_date date)
returns date
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v date := p_date;
begin
  while exists (select 1 from day_closes where restaurant_id = p_restaurant_id and close_date = v) loop
    v := v + 1;
  end loop;
  return v;
end;
$$;

create or replace function journal_entries_check_date()
returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if exists (select 1 from day_closes where restaurant_id = new.restaurant_id and close_date = new.entry_date) then
    raise exception 'day_closed: %', new.entry_date;
  end if;
  return new;
end;
$$;
drop trigger if exists journal_entries_check_date on journal_entries;
create trigger journal_entries_check_date before insert on journal_entries
  for each row execute function journal_entries_check_date();

-- ===== 5) ตัวช่วยลงรายการ (ใช้ภายใน) =====
create or replace function acct_new_entry(
  p_restaurant_id uuid, p_source_type text, p_source_id uuid, p_date date, p_memo text,
  p_reverses uuid default null, p_reason text default null
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v uuid;
begin
  insert into journal_entries (restaurant_id, entry_date, source_type, source_id, memo, reverses_entry_id, reason, created_by)
  values (p_restaurant_id, p_date, p_source_type, p_source_id, left(p_memo, 300), p_reverses, left(p_reason, 300),
          (select id from app_users where id = auth.uid()))
  returning id into v;
  return v;
end;
$$;

-- รายการของเอกสารเดียวกันในธุรกรรมเดียวกัน ใช้รายการเดิม (เช่น ตัดสต็อก 5 วัตถุดิบของออเดอร์เดียว = 1 รายการ)
create or replace function acct_tx_entry(p_restaurant_id uuid, p_source_type text, p_source_id uuid, p_memo text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v uuid;
begin
  select id into v from journal_entries
  where restaurant_id = p_restaurant_id and source_type = p_source_type
    and source_id is not distinct from p_source_id and created_txid = txid_current() and reverses_entry_id is null
  limit 1;
  if v is null then
    v := acct_new_entry(p_restaurant_id, p_source_type, p_source_id,
                        acct_open_date(p_restaurant_id, acct_today(p_restaurant_id)), p_memo);
  end if;
  return v;
end;
$$;

-- จำนวนบวก = เดบิต · ลบ = เครดิต · 0 = ไม่ลง
create or replace function acct_line_id(p_entry uuid, p_account uuid, p_amount numeric, p_ingredient uuid default null, p_memo text default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_amt numeric := round(coalesce(p_amount, 0), 2);
begin
  if v_amt = 0 then
    return;
  end if;
  insert into journal_lines (entry_id, restaurant_id, account_id, debit, credit, ingredient_id, memo)
  select p_entry, e.restaurant_id, p_account, greatest(v_amt, 0), greatest(-v_amt, 0), p_ingredient, left(p_memo, 200)
  from journal_entries e where e.id = p_entry;
end;
$$;

create or replace function acct_line(p_entry uuid, p_key text, p_amount numeric, p_ingredient uuid default null, p_memo text default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform acct_line_id(p_entry, acct_account((select restaurant_id from journal_entries where id = p_entry), p_key),
                       p_amount, p_ingredient, p_memo);
end;
$$;

-- กลับรายการ: สลับเดบิต/เครดิตทุกบรรทัด ลงวันที่เปิดอยู่วันแรก (วันเดิมอาจปิดไปแล้ว)
create or replace function acct_reverse_internal(p_entry uuid, p_reason text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e journal_entries;
  v uuid;
begin
  select * into e from journal_entries where id = p_entry;
  if e.id is null then
    raise exception 'not_found';
  end if;
  if exists (select 1 from journal_entries where reverses_entry_id = p_entry) then
    raise exception 'already_reversed';
  end if;
  v := acct_new_entry(e.restaurant_id, 'reversal', e.source_id, acct_open_date(e.restaurant_id, acct_today(e.restaurant_id)),
                      'กลับรายการ #' || e.entry_no || coalesce(' · ' || e.memo, ''), p_entry, p_reason);
  insert into journal_lines (entry_id, restaurant_id, account_id, debit, credit, ingredient_id, memo)
  select v, restaurant_id, account_id, credit, debit, ingredient_id, memo
  from journal_lines where entry_id = p_entry order by id;
  return v;
end;
$$;

revoke execute on function acct_today(uuid) from public, anon;
grant execute on function acct_today(uuid) to authenticated;
revoke execute on function acct_open_date(uuid, date) from public, anon;
grant execute on function acct_open_date(uuid, date) to authenticated;
revoke execute on function acct_new_entry(uuid, text, uuid, date, text, uuid, text) from public, anon, authenticated;
revoke execute on function acct_tx_entry(uuid, text, uuid, text) from public, anon, authenticated;
revoke execute on function acct_line_id(uuid, uuid, numeric, uuid, text) from public, anon, authenticated;
revoke execute on function acct_line(uuid, text, numeric, uuid, text) from public, anon, authenticated;
revoke execute on function acct_reverse_internal(uuid, text) from public, anon, authenticated;

-- ===== 6) สต็อก: ลงผลต่างมูลค่าทุกครั้งที่ยอด/ต้นทุนต่อหน่วยเปลี่ยน =====
-- บริบท (ตั้งชั่วคราวในธุรกรรม): plato.stock_ctx = 'ประเภทเอกสาร|รหัสเอกสาร|บัญชีคู่' จาก stock_movements
--                                plato.receipt_ctx = รหัสใบรับของที่กำลังบันทึก (ต้นทุนเฉลี่ยเปลี่ยนก่อนสต็อกเข้า)
create or replace function apply_stock_movement()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.created_by := auth.uid();
  perform set_config('plato.stock_ctx',
    case
      when new.reason = 'sale' then 'recipe_deduct|' || coalesce(new.order_id::text, '') || '|cogs'
      when new.reason = 'purchase' and new.receipt_id is not null then 'stock_receipt|' || new.receipt_id || '|'
      when new.reason = 'purchase' then 'stock_receipt||@payment'
      when new.reason = 'waste' then 'waste|' || new.id || '|variance'
      when new.reason = 'adjustment' then 'count_adjust|' || coalesce(new.count_id, new.id) || '|variance'
      when new.reason = 'production' then 'production|' || coalesce(new.batch_id, new.id) || '|variance'
      else 'stock_revalue|' || new.id || '|variance'
    end, true);
  update ingredients
     set quantity_on_hand = quantity_on_hand + new.change
   where id = new.ingredient_id
     and restaurant_id = new.restaurant_id
  returning quantity_on_hand into new.balance_after;
  if not found then
    raise exception 'invalid_ingredient';
  end if;
  perform set_config('plato.stock_ctx', '', true);
  return new;
end;
$$;

create or replace function acct_payment_key(p_restaurant_id uuid, p_method text)
returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case coalesce(p_method, (select receipt_payment_default from shop_settings where restaurant_id = p_restaurant_id), 'cash')
    when 'bank' then 'bank' when 'credit' then 'ap' else 'cash' end;
$$;
revoke execute on function acct_payment_key(uuid, text) from public, anon, authenticated;

create or replace function acct_ingredient_value()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old numeric := 0;
  v_new numeric := 0;
  v_delta numeric;
  v_rid uuid := coalesce(new.restaurant_id, old.restaurant_id);
  v_ing uuid := coalesce(new.id, old.id);
  v_name text := coalesce(new.name, old.name);
  v_ctx text := nullif(current_setting('plato.stock_ctx', true), '');
  v_receipt text := nullif(current_setting('plato.receipt_ctx', true), '');
  v_src text;
  v_doc uuid;
  v_contra text;
  v_entry uuid;
begin
  if tg_op <> 'INSERT' then
    v_old := round(old.quantity_on_hand * old.cost_per_unit, 2);
  end if;
  if tg_op <> 'DELETE' then
    v_new := round(new.quantity_on_hand * new.cost_per_unit, 2);
  end if;
  v_delta := v_new - v_old;
  if v_delta = 0 or not exists (select 1 from restaurants where id = v_rid) then
    return null;
  end if;

  if v_ctx is not null then
    v_src := split_part(v_ctx, '|', 1);
    v_doc := nullif(split_part(v_ctx, '|', 2), '')::uuid;
    v_contra := nullif(split_part(v_ctx, '|', 3), '');
    if v_contra = '@payment' then
      v_contra := acct_payment_key(v_rid, null);
    end if;
  elsif v_receipt is not null then
    v_src := 'stock_receipt'; v_doc := v_receipt::uuid; v_contra := null;   -- ต้นทุนเฉลี่ยใหม่ตอนรับของ
  elsif tg_op = 'INSERT' then
    v_src := 'opening'; v_doc := v_ing; v_contra := 'equity';               -- วัตถุดิบใหม่พร้อมยอดยกมา
  else
    v_src := 'stock_revalue'; v_doc := v_ing; v_contra := 'variance';       -- แก้ต้นทุนต่อหน่วย / ลบวัตถุดิบ
  end if;

  v_entry := acct_tx_entry(v_rid, v_src, v_doc, case v_src
    when 'recipe_deduct' then 'ตัดสต็อกตามสูตร'
    when 'stock_receipt' then 'รับวัตถุดิบเข้า'
    when 'waste' then 'ของเสีย'
    when 'count_adjust' then 'ปรับยอดจากการตรวจนับ'
    when 'production' then 'ผลิตของเตรียม'
    when 'opening' then 'ยอดยกมาวัตถุดิบ'
    else 'ปรับมูลค่าสต็อก' end);
  perform acct_line(v_entry, 'stock', v_delta, v_ing, v_name);
  if v_contra is not null then
    perform acct_line(v_entry, v_contra, -v_delta, v_ing, v_name);
  end if;
  return null;
end;
$$;
drop trigger if exists ingredients_accounting on ingredients;
create trigger ingredients_accounting
  after insert or update of quantity_on_hand, cost_per_unit or delete on ingredients
  for each row execute function acct_ingredient_value();

-- ใบรับของ: จำว่ากำลังบันทึกใบไหน แล้วปิดรายการเมื่อฟังก์ชันใส่ยอดรวม (ขั้นสุดท้ายของ submit_stock_receipt)
alter table stock_receipts add column if not exists payment_method text check (payment_method in ('cash', 'bank', 'credit'));

create or replace function stock_receipts_accounting()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_entry uuid;
  v_stock numeric;
  v_pay numeric;
  v_claim numeric;
begin
  if tg_op = 'INSERT' then
    perform set_config('plato.receipt_ctx', new.id::text, true);
    if new.payment_method is null then
      update stock_receipts
         set payment_method = coalesce((select receipt_payment_default from shop_settings where restaurant_id = new.restaurant_id), 'cash')
       where id = new.id;
    end if;
    return null;
  end if;

  -- ยอดรวมถูกใส่ครั้งแรก: Dr สต็อก (ผลต่างมูลค่าที่ลงไปแล้ว) + Dr ลูกหนี้ผู้ขาย (ของขาด) / Cr เงินสด/ธนาคาร/เจ้าหนี้ (ตามบิล)
  if old.item_count = 0 and new.item_count > 0 then
    v_entry := acct_tx_entry(new.restaurant_id, 'stock_receipt', new.id, 'รับวัตถุดิบเข้า');
    select coalesce(sum(jl.debit - jl.credit), 0) into v_stock
    from journal_lines jl join accounts a on a.id = jl.account_id
    where jl.entry_id = v_entry and a.system_key = 'stock';
    v_pay := coalesce(new.invoice_total, new.total_cost, 0);
    v_claim := coalesce(new.claim_total, 0);
    perform acct_line(v_entry, acct_payment_key(new.restaurant_id, new.payment_method), -v_pay, null,
                      'ตามบิล' || coalesce(' ' || new.supplier, '') || coalesce(' #' || new.invoice_no, ''));
    perform acct_line(v_entry, 'claim', v_claim, null, 'ของขาด/ตีกลับ รอทวง');
    -- ส่วนที่เหลือ: ขาด/เกินในเกณฑ์ที่ยอมรับ + เศษสตางค์ของต้นทุนเฉลี่ย
    perform acct_line(v_entry, 'recv_variance', v_pay - v_claim - v_stock, null, 'ส่วนต่างรับสินค้า');
    perform set_config('plato.receipt_ctx', '', true);
  end if;
  return null;
end;
$$;
drop trigger if exists stock_receipts_accounting on stock_receipts;
create trigger stock_receipts_accounting after insert or update on stock_receipts
  for each row execute function stock_receipts_accounting();

-- ติดตามของขาด: pending -> credited (ได้ลดหนี้: ล้างกับเจ้าหนี้) / accepted (ยอมรับ: เป็นส่วนต่างรับสินค้า)
create or replace function stock_receipt_lines_claim_accounting()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rid uuid;
  v_entry uuid;
  v_amt numeric := new.claim_value;
begin
  if new.claim_status is not distinct from old.claim_status or coalesce(v_amt, 0) = 0 then
    return null;
  end if;
  select restaurant_id into v_rid from stock_receipts where id = new.receipt_id;
  v_entry := acct_new_entry(v_rid, 'supplier_claim', new.receipt_id, acct_open_date(v_rid, acct_today(v_rid)),
                            'ของขาดจากผู้ขาย: ' || old.claim_status || ' -> ' || new.claim_status);
  -- ย้อนผลของสถานะเดิม
  if old.claim_status = 'credited' then
    perform acct_line(v_entry, 'claim', v_amt, new.ingredient_id, new.ingredient_name);
    perform acct_line(v_entry, 'ap', -v_amt, new.ingredient_id, new.ingredient_name);
  elsif old.claim_status = 'accepted' then
    perform acct_line(v_entry, 'claim', v_amt, new.ingredient_id, new.ingredient_name);
    perform acct_line(v_entry, 'recv_variance', -v_amt, new.ingredient_id, new.ingredient_name);
  end if;
  -- ลงผลของสถานะใหม่
  if new.claim_status = 'credited' then
    perform acct_line(v_entry, 'ap', v_amt, new.ingredient_id, 'ได้ลดหนี้ ' || new.ingredient_name);
    perform acct_line(v_entry, 'claim', -v_amt, new.ingredient_id, 'ได้ลดหนี้ ' || new.ingredient_name);
  elsif new.claim_status = 'accepted' then
    perform acct_line(v_entry, 'recv_variance', v_amt, new.ingredient_id, 'ยอมรับของขาด ' || new.ingredient_name);
    perform acct_line(v_entry, 'claim', -v_amt, new.ingredient_id, 'ยอมรับของขาด ' || new.ingredient_name);
  end if;
  return null;
end;
$$;
drop trigger if exists stock_receipt_lines_claim_accounting on stock_receipt_lines;
create trigger stock_receipt_lines_claim_accounting after update of claim_status on stock_receipt_lines
  for each row execute function stock_receipt_lines_claim_accounting();

-- ===== 7) บิล: จ่ายแล้วลงรายได้ · ยกเลิกหลังจ่าย = กลับรายการ · ยกเลิกหลังตัดสต็อก = ย้ายต้นทุนไปส่วนต่างสต็อก =====
create or replace function acct_post_bill(p orders)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_vat_on boolean;
  v_rate numeric;
  v_f numeric := 1;
  v_gross numeric;
  v_points numeric := coalesce(p.points_discount, 0);
  v_promo numeric;
  v_net_total numeric;
  v_rev_target numeric;
  v_rev_sum numeric := 0;
  v_entry uuid;
  r record;
  v_first uuid;
  v_first_amt numeric;
  v_amt numeric;
  v_n int := 0;
begin
  select coalesce(sum(quantity * unit_price), 0) into v_gross from order_items where order_id = p.id;
  if v_gross = 0 and coalesce(p.total, 0) = 0 then
    return null;
  end if;
  v_promo := greatest(v_gross - p.total - v_points, 0);

  select vat_registered, vat_rate into v_vat_on, v_rate from shop_settings where restaurant_id = p.restaurant_id;
  if coalesce(v_vat_on, false) and coalesce(v_rate, 0) > 0 then
    v_f := 100 / (100 + v_rate);                       -- ราคาขายรวม VAT แล้ว
  end if;
  v_net_total := round(p.total * v_f, 2);
  v_promo := round(v_promo * v_f, 2);
  v_points := round(v_points * v_f, 2);
  v_rev_target := v_net_total + v_promo + v_points;

  v_entry := acct_new_entry(p.restaurant_id, 'bill', p.id,
                            acct_open_date(p.restaurant_id, (coalesce(p.paid_at, now()) at time zone
                              coalesce((select timezone from restaurants where id = p.restaurant_id), 'Asia/Bangkok'))::date),
                            'ขาย ' || coalesce(p.customer_label, (select label from dining_tables where id = p.table_id), 'บิล'));
  perform acct_line(v_entry, case when coalesce(p.payment_method, 'cash') = 'cash' then 'cash' else 'bank' end, p.total);
  perform acct_line(v_entry, 'disc_promo', v_promo);
  perform acct_line(v_entry, 'disc_points', v_points);
  perform acct_line(v_entry, 'vat_out', -(p.total - v_net_total));

  -- รายได้แยกตามบัญชีของหมวดเมนู · เศษสตางค์ลงบรรทัดที่ยอดมากที่สุด
  for r in
    select coalesce(c.revenue_account_id, acct_account(p.restaurant_id, 'rev_food')) as acc, sum(oi.quantity * oi.unit_price) as amt
    from order_items oi
    join menu_items m on m.id = oi.menu_item_id
    left join menu_categories c on c.id = m.category_id
    where oi.order_id = p.id
    group by 1
    order by 2 desc, 1
  loop
    v_n := v_n + 1;
    v_amt := case when v_gross = 0 then 0 else round(r.amt * v_f, 2) end;
    if v_n = 1 then
      v_first := r.acc; v_first_amt := v_amt;
    else
      perform acct_line_id(v_entry, r.acc, -v_amt);
    end if;
    v_rev_sum := v_rev_sum + v_amt;
  end loop;
  if v_n = 0 then
    v_first := acct_account(p.restaurant_id, 'rev_food'); v_first_amt := 0;
  end if;
  perform acct_line_id(v_entry, v_first, -(v_first_amt + v_rev_target - v_rev_sum));
  return v_entry;
end;
$$;
revoke execute on function acct_post_bill(orders) from public, anon, authenticated;

create or replace function orders_accounting()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bill uuid;
  v_deduct uuid;
  v_cost numeric;
  v_entry uuid;
begin
  if new.import_batch is not null or new.is_demo then
    return null;
  end if;

  if new.status = 'paid' and old.status <> 'paid' then
    perform acct_post_bill(new);
  end if;

  if new.status = 'cancelled' and old.status <> 'cancelled' then
    -- ยกเลิกบิลที่จ่ายแล้ว: กลับรายการรายได้ทั้งบิล
    if old.status = 'paid' then
      select id into v_bill from journal_entries
      where restaurant_id = new.restaurant_id and source_type = 'bill' and source_id = new.id
        and not exists (select 1 from journal_entries x where x.reverses_entry_id = journal_entries.id)
      limit 1;
      if v_bill is not null then
        perform acct_reverse_internal(v_bill, coalesce(new.cancel_reason, 'ยกเลิกบิล'));
      end if;
    end if;
    -- ต้นทุน: ของถูกทำไปแล้ว สต็อกไม่คืน -> ย้ายจากต้นทุนขายไปส่วนต่างสต็อก (ไม่ใช่ต้นทุนของการขาย)
    select e.id, coalesce(sum(jl.debit - jl.credit), 0) into v_deduct, v_cost
    from journal_entries e
    join journal_lines jl on jl.entry_id = e.id
    join accounts a on a.id = jl.account_id and a.system_key = 'cogs'
    where e.restaurant_id = new.restaurant_id and e.source_type = 'recipe_deduct' and e.source_id = new.id
      and not exists (select 1 from journal_entries x where x.reverses_entry_id = e.id)
    group by e.id
    limit 1;
    if v_deduct is not null and v_cost <> 0 then
      v_entry := acct_new_entry(new.restaurant_id, 'reversal', new.id, acct_open_date(new.restaurant_id, acct_today(new.restaurant_id)),
                                'ยกเลิกออเดอร์: ย้ายต้นทุนขายเป็นส่วนต่างสต็อก', v_deduct, coalesce(new.cancel_reason, 'ยกเลิกออเดอร์'));
      perform acct_line(v_entry, 'variance', v_cost);
      perform acct_line(v_entry, 'cogs', -v_cost);
    end if;
  end if;
  return null;
end;
$$;
drop trigger if exists orders_accounting on orders;
create trigger orders_accounting after update of status on orders
  for each row when (old.status is distinct from new.status)
  execute function orders_accounting();

-- ออเดอร์ที่ลงบัญชีแล้วลบไม่ได้ (รายได้/ต้นทุนจะหายจากสมุดรายวัน) ใช้ยกเลิกแทน
create or replace function orders_keep_posted()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from journal_entries
             where restaurant_id = old.restaurant_id and source_id = old.id and source_type in ('bill', 'recipe_deduct'))
     and exists (select 1 from restaurants where id = old.restaurant_id) then
    raise exception 'order_posted_use_cancel';
  end if;
  return old;
end;
$$;
drop trigger if exists orders_keep_posted on orders;
create trigger orders_keep_posted before delete on orders
  for each row execute function orders_keep_posted();

-- ===== 8) รายจ่าย =====
alter table expenses add column if not exists account_id uuid references accounts(id);
alter table expenses add column if not exists payment_method text not null default 'cash'
  check (payment_method in ('cash', 'bank', 'credit'));
alter table expenses add column if not exists vat_amount numeric(12,2) not null default 0 check (vat_amount >= 0);
alter table expenses add column if not exists source text not null default 'manual'
  check (source in ('manual', 'stock_receipt', 'legacy'));
alter table expenses add column if not exists created_by uuid references app_users(id) on delete set null;
alter table expenses add column if not exists created_at timestamptz not null default now();
alter table expenses add column if not exists voided_at timestamptz;
alter table expenses add column if not exists voided_by uuid references app_users(id) on delete set null;
alter table expenses add column if not exists void_reason text check (char_length(void_reason) <= 300);
alter table expenses drop constraint if exists expenses_vat_check;
alter table expenses add constraint expenses_vat_check check (vat_amount <= amount);

-- รายจ่ายก่อนมีโมดูลบัญชี: ไม่ลงย้อนหลัง (ยอดเดิมดูได้จากรายงานแบบเดิม) · รายจ่ายจากใบรับของ: สต็อกลงบัญชีแทน
update expenses e set source = case when exists (select 1 from stock_receipts r where r.expense_id = e.id) then 'stock_receipt' else 'legacy' end
where source = 'manual';
update expenses e set account_id = a.id
from accounts a
where e.account_id is null and a.restaurant_id = e.restaurant_id and a.legacy_category = e.category;

-- ช่องที่ผู้ใช้กรอกเองได้ (source / void / created_by ระบบเป็นคนตั้ง)
revoke insert, update on expenses from authenticated;
grant insert (restaurant_id, category, amount, spent_on, note, receipt_url, account_id, payment_method, vat_amount) on expenses to authenticated;
grant update (note, receipt_url) on expenses to authenticated;

create or replace function expenses_before_insert()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a accounts;
begin
  new.created_by := (select id from app_users where id = auth.uid());
  new.voided_at := null; new.voided_by := null; new.void_reason := null;
  -- อยู่ระหว่างบันทึกใบรับของ: รายจ่ายนี้คือบิลวัตถุดิบ (สต็อกลงบัญชีให้แล้ว)
  if nullif(current_setting('plato.receipt_ctx', true), '') is not null and new.category = 'ingredients' then
    new.source := 'stock_receipt';
  else
    new.source := 'manual';
  end if;
  if new.account_id is null then
    select * into a from accounts where restaurant_id = new.restaurant_id and legacy_category = new.category and is_active
    order by system_key nulls last limit 1;
  else
    select * into a from accounts where id = new.account_id and restaurant_id = new.restaurant_id;
  end if;
  if a.id is null or a.type <> 'expense' or not a.is_active
     or (new.source = 'manual' and a.system_key in ('cogs', 'variance', 'recv_variance', 'cash_over_short')) then
    raise exception 'invalid_expense_account';
  end if;
  new.account_id := a.id;
  new.category := coalesce(a.legacy_category, 'other');
  return new;
end;
$$;
drop trigger if exists expenses_before_insert on expenses;
create trigger expenses_before_insert before insert on expenses
  for each row execute function expenses_before_insert();

create or replace function expenses_after_insert()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_entry uuid;
begin
  if new.source <> 'manual' then
    return null;
  end if;
  v_entry := acct_new_entry(new.restaurant_id, 'expense', new.id, new.spent_on,
                            coalesce(new.note, (select name from accounts where id = new.account_id)));
  perform acct_line_id(v_entry, new.account_id, new.amount - new.vat_amount);
  perform acct_line(v_entry, 'vat_in', new.vat_amount);
  perform acct_line(v_entry, acct_payment_key(new.restaurant_id, new.payment_method), -new.amount);
  return null;
end;
$$;
drop trigger if exists expenses_after_insert on expenses;
create trigger expenses_after_insert after insert on expenses
  for each row execute function expenses_after_insert();

-- ลงบัญชีแล้วแก้ยอด/หมวด/วันที่ไม่ได้ ลบไม่ได้ → ใช้ "ยกเลิกรายจ่าย" (กลับรายการ)
create or replace function expenses_guard()
returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if old.source <> 'manual' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if exists (select 1 from restaurants where id = old.restaurant_id) then
      raise exception 'expense_posted_use_void';
    end if;
    return old;
  end if;
  if new.amount <> old.amount or new.category <> old.category or new.spent_on <> old.spent_on
     or new.account_id is distinct from old.account_id or new.payment_method <> old.payment_method
     or new.vat_amount <> old.vat_amount or new.source <> old.source or new.restaurant_id <> old.restaurant_id then
    raise exception 'expense_posted_use_void';
  end if;
  return new;
end;
$$;
drop trigger if exists expenses_guard on expenses;
create trigger expenses_guard before update or delete on expenses
  for each row execute function expenses_guard();

create or replace function acct_void_expense(p_expense_id uuid, p_reason text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  x expenses;
  v_entry uuid;
  v uuid;
begin
  select * into x from expenses where id = p_expense_id for update;
  if x.id is null or not has_role(x.restaurant_id, array['owner', 'accountant']) then
    raise exception 'forbidden';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'reason_required';
  end if;
  if x.source <> 'manual' then
    raise exception 'not_posted';
  end if;
  if x.voided_at is not null then
    raise exception 'already_reversed';
  end if;
  select id into v_entry from journal_entries
  where restaurant_id = x.restaurant_id and source_type = 'expense' and source_id = x.id and reverses_entry_id is null;
  v := acct_reverse_internal(v_entry, trim(p_reason));
  update expenses set voided_at = now(), voided_by = (select id from app_users where id = auth.uid()),
                      void_reason = left(trim(p_reason), 300)
   where id = x.id;
  return v;
end;
$$;
revoke execute on function acct_void_expense(uuid, text) from public, anon;
grant execute on function acct_void_expense(uuid, text) to authenticated;

-- รูปใบเสร็จ: bucket 'expense-receipts' (ไม่สาธารณะ) ไฟล์อยู่ใต้โฟลเดอร์ <restaurant_id>/
create or replace function can_access_expense_receipt(p_name text, p_write boolean)
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return has_role(split_part(p_name, '/', 1)::uuid,
                  case when p_write then array['owner', 'accountant'] else array['owner', 'manager', 'accountant'] end);
exception when invalid_text_representation then
  return false;
end;
$$;
revoke execute on function can_access_expense_receipt(text, boolean) from public, anon;
grant execute on function can_access_expense_receipt(text, boolean) to authenticated;

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    execute $q$
      insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('expense-receipts', 'expense-receipts', false, 10485760, array['image/*', 'application/pdf'])
      on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types
    $q$;
    execute 'drop policy if exists expense_receipts_select on storage.objects';
    execute 'drop policy if exists expense_receipts_insert on storage.objects';
    execute $q$
      create policy expense_receipts_select on storage.objects for select to authenticated
      using (bucket_id = 'expense-receipts' and public.can_access_expense_receipt(name, false))
    $q$;
    execute $q$
      create policy expense_receipts_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'expense-receipts' and public.can_access_expense_receipt(name, true))
    $q$;
  end if;
end;
$$;

-- ===== 9) จ่ายเจ้าหนี้ (ใบรับของแบบเครดิต) =====
create or replace function acct_pay_supplier(
  p_restaurant_id uuid, p_amount numeric, p_payment_method text, p_supplier text default null,
  p_date date default null, p_note text default null
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v uuid;
begin
  if not has_role(p_restaurant_id, array['owner', 'accountant']) then
    raise exception 'forbidden';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100000000 then
    raise exception 'invalid_amount';
  end if;
  if coalesce(p_payment_method, '') not in ('cash', 'bank') then
    raise exception 'invalid_payment_method';
  end if;
  v := acct_new_entry(p_restaurant_id, 'supplier_payment', null, coalesce(p_date, acct_today(p_restaurant_id)),
                      'จ่ายเจ้าหนี้' || coalesce(' ' || nullif(trim(p_supplier), ''), '') || coalesce(' · ' || nullif(trim(p_note), ''), ''));
  perform acct_line(v, 'ap', p_amount);
  perform acct_line(v, p_payment_method, -p_amount);
  return v;
end;
$$;
revoke execute on function acct_pay_supplier(uuid, numeric, text, text, date, text) from public, anon;
grant execute on function acct_pay_supplier(uuid, numeric, text, text, date, text) to authenticated;

-- ===== 10) ยอดยกมา (เงินสด/ธนาคาร) =====
create or replace function acct_set_opening(p_restaurant_id uuid, p_cash numeric, p_bank numeric, p_date date default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v uuid;
begin
  if not has_role(p_restaurant_id, array['owner']) then
    raise exception 'forbidden';
  end if;
  if coalesce(p_cash, 0) < 0 or coalesce(p_bank, 0) < 0 or coalesce(p_cash, 0) + coalesce(p_bank, 0) = 0 then
    raise exception 'invalid_amount';
  end if;
  v := acct_new_entry(p_restaurant_id, 'opening', null, coalesce(p_date, acct_today(p_restaurant_id)), 'ยอดยกมา เงินสด/ธนาคาร');
  perform acct_line(v, 'cash', p_cash);
  perform acct_line(v, 'bank', p_bank);
  perform acct_line(v, 'equity', -(coalesce(p_cash, 0) + coalesce(p_bank, 0)));
  return v;
end;
$$;
revoke execute on function acct_set_opening(uuid, numeric, numeric, date) from public, anon;
grant execute on function acct_set_opening(uuid, numeric, numeric, date) to authenticated;

-- ===== 11) กลับรายการเอง (เจ้าของ) · บิล = ยกเลิกบิล · รายจ่าย = ยกเลิกรายจ่าย · สต็อก = ตรวจนับใหม่ =====
create or replace function acct_reverse_entry(p_entry_id uuid, p_reason text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e journal_entries;
begin
  select * into e from journal_entries where id = p_entry_id;
  if e.id is null or not has_role(e.restaurant_id, array['owner']) then
    raise exception 'forbidden';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'reason_required';
  end if;
  if e.source_type not in ('supplier_payment', 'opening', 'day_close') or (e.source_type = 'opening' and e.source_id is not null) then
    raise exception 'reverse_not_allowed: %', e.source_type;
  end if;
  return acct_reverse_internal(p_entry_id, trim(p_reason));
end;
$$;
revoke execute on function acct_reverse_entry(uuid, text) from public, anon;
grant execute on function acct_reverse_entry(uuid, text) to authenticated;

-- ===== 12) กระทบยอดสต็อก: โมดูลสต็อก vs บัญชีสต็อก =====
create or replace function acct_stock_reconcile_data(p_restaurant_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with m as (
    select coalesce(sum(round(quantity_on_hand * cost_per_unit, 2)), 0) as v from ingredients where restaurant_id = p_restaurant_id
  ), g as (
    select coalesce(sum(jl.debit - jl.credit), 0) as v
    from journal_lines jl join accounts a on a.id = jl.account_id and a.system_key = 'stock'
    where jl.restaurant_id = p_restaurant_id
  )
  select jsonb_build_object('stock_value', m.v, 'ledger_value', g.v, 'difference', g.v - m.v, 'ok', g.v = m.v)
  from m, g;
$$;
revoke execute on function acct_stock_reconcile_data(uuid) from public, anon, authenticated;

create or replace function acct_stock_reconcile(p_restaurant_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'accountant', 'stock']) then
    raise exception 'forbidden';
  end if;
  return acct_stock_reconcile_data(p_restaurant_id);
end;
$$;
revoke execute on function acct_stock_reconcile(uuid) from public, anon;
grant execute on function acct_stock_reconcile(uuid) to authenticated;

-- ===== 13) สรุปตามช่วงวันที่ (ข้อมูลดิบ · สูตร % คิดที่ frontend/src/lib/accounting.ts) =====
create or replace function acct_summary_data(p_restaurant_id uuid, p_from date, p_to date)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with l as (
    select a.grp, a.system_key, a.code, a.name, a.id as account_id, e.source_type, e.entry_date, jl.debit, jl.credit
    from journal_lines jl
    join journal_entries e on e.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where jl.restaurant_id = p_restaurant_id and e.entry_date <= p_to
  ), r as (select * from l where entry_date >= p_from)
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'sales', (select coalesce(sum(credit - debit), 0) from r where grp = 'sales'),
    'sales_by_account', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'amount', amt) order by code)
                                  from (select code, name, sum(credit - debit) as amt from r where grp = 'sales' group by code, name) x), '[]'),
    'discounts', (select coalesce(sum(debit - credit), 0) from r where grp = 'discount'),
    'other_income', (select coalesce(sum(credit - debit), 0) from r where grp = 'other_income'),
    'cogs_recipe', (select coalesce(sum(debit - credit), 0) from r where system_key = 'cogs'),
    'stock_variance', (select coalesce(sum(debit - credit), 0) from r where system_key = 'variance'),
    'food_cost', (select coalesce(sum(debit - credit), 0) from r where grp = 'food_cost'),
    'labor', (select coalesce(sum(debit - credit), 0) from r where grp = 'labor'),
    'opex', (select coalesce(sum(debit - credit), 0) from r where grp = 'opex'),
    'expenses_by_account', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'grp', grp, 'amount', amt) order by code)
                                     from (select code, name, grp, sum(debit - credit) as amt from r
                                           where grp in ('food_cost', 'labor', 'opex') group by code, name, grp) x where amt <> 0), '[]'),
    'cash_open', (select coalesce(sum(debit - credit), 0) from l where grp in ('cash', 'bank') and entry_date < p_from),
    'cash_close', (select coalesce(sum(debit - credit), 0) from l where grp in ('cash', 'bank')),
    'cash_in', (select coalesce(sum(debit), 0) from r where grp in ('cash', 'bank') and source_type <> 'opening'),
    'cash_out', (select coalesce(sum(credit), 0) from r where grp in ('cash', 'bank') and source_type <> 'opening'),
    'cash_drawer', (select coalesce(sum(debit - credit), 0) from l where grp = 'cash'),
    'cash_by_source', coalesce((select jsonb_agg(jsonb_build_object('source_type', source_type, 'in', i, 'out', o) order by source_type)
                                from (select source_type, sum(debit) as i, sum(credit) as o from r
                                      where grp in ('cash', 'bank') and source_type <> 'opening' group by source_type) x), '[]'),
    'stock_open', (select coalesce(sum(debit - credit), 0) from l where grp = 'stock' and entry_date < p_from),
    'stock_close', (select coalesce(sum(debit - credit), 0) from l where grp = 'stock'),
    'stock_in', (select coalesce(sum(debit - credit), 0) from r where grp = 'stock' and source_type in ('stock_receipt', 'opening')),
    'vat_output', (select coalesce(sum(credit - debit), 0) from r where grp = 'vat_out'),
    'vat_input', (select coalesce(sum(debit - credit), 0) from r where grp = 'vat_in'),
    'bills', (select count(*) from journal_entries e where e.restaurant_id = p_restaurant_id and e.source_type = 'bill'
                and e.entry_date between p_from and p_to),
    'cancelled_bills', (select count(*) from journal_entries e join journal_entries o on o.id = e.reverses_entry_id and o.source_type = 'bill'
                          where e.restaurant_id = p_restaurant_id and e.entry_date between p_from and p_to)
  );
$$;
revoke execute on function acct_summary_data(uuid, date, date) from public, anon, authenticated;

create or replace function acct_summary(p_restaurant_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'accountant']) then
    raise exception 'forbidden';
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 3660 then
    raise exception 'invalid_range';
  end if;
  return acct_summary_data(p_restaurant_id, p_from, p_to);
end;
$$;
revoke execute on function acct_summary(uuid, date, date) from public, anon;
grant execute on function acct_summary(uuid, date, date) to authenticated;

-- แดชบอร์ด: วันนี้ / 7 วัน / 30 วัน / เดือนนี้ / เดือนก่อน / ตั้งแต่ต้นปี + กระทบยอดสต็อก + ตั้งค่า
create or replace function acct_dashboard(p_restaurant_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  t date;
  m date;
  s shop_settings;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'accountant']) then
    raise exception 'forbidden';
  end if;
  t := acct_today(p_restaurant_id);
  m := date_trunc('month', t)::date;
  select * into s from shop_settings where restaurant_id = p_restaurant_id;
  return jsonb_build_object(
    'today', t,
    'periods', jsonb_build_object(
      'today', acct_summary_data(p_restaurant_id, t, t),
      'd7', acct_summary_data(p_restaurant_id, t - 6, t),
      'd30', acct_summary_data(p_restaurant_id, t - 29, t),
      'month', acct_summary_data(p_restaurant_id, m, t),
      'prev_month', acct_summary_data(p_restaurant_id, (m - interval '1 month')::date, m - 1),
      'ytd', acct_summary_data(p_restaurant_id, date_trunc('year', t)::date, t)
    ),
    'reconcile', acct_stock_reconcile_data(p_restaurant_id),
    'last_close', (select max(close_date) from day_closes where restaurant_id = p_restaurant_id),
    'unclosed_days', (select count(distinct entry_date) from journal_entries e
                       where e.restaurant_id = p_restaurant_id and e.entry_date < t
                         and e.entry_date > coalesce((select max(close_date) from day_closes where restaurant_id = p_restaurant_id), t - 31)
                         and not exists (select 1 from day_closes d where d.restaurant_id = p_restaurant_id and d.close_date = e.entry_date)),
    'settings', jsonb_build_object(
      'accounting_mode', coalesce(s.accounting_mode, 'standard'),
      'business_type', coalesce(s.business_type, 'individual'),
      'vat_registered', coalesce(s.vat_registered, false),
      'vat_rate', coalesce(s.vat_rate, 7),
      'receipt_payment_default', coalesce(s.receipt_payment_default, 'cash'),
      'food_cost_target_min', coalesce(s.food_cost_target_min, 28),
      'food_cost_target_max', coalesce(s.food_cost_target_max, 35),
      'prime_cost_target_min', coalesce(s.prime_cost_target_min, 60),
      'prime_cost_target_max', coalesce(s.prime_cost_target_max, 65),
      'onboarded', s.accounting_onboarded_at is not null
    )
  );
end;
$$;
revoke execute on function acct_dashboard(uuid) from public, anon;
grant execute on function acct_dashboard(uuid) to authenticated;

-- กำไรขั้นต้นต่อเมนู (ราคาขายก่อนส่วนลดท้ายบิล · ต้นทุนตามสูตรปัจจุบัน)
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
    select m.id, coalesce(sum(r.quantity_used * 100 / i.yield_pct * i.cost_per_unit), 0) as unit_cost, count(r.ingredient_id) > 0 as has_recipe
    from menu_items m
    left join recipes r on r.menu_item_id = m.id
    left join ingredients i on i.id = r.ingredient_id
    where m.restaurant_id = p_restaurant_id
    group by m.id
  ), s as (
    select m.id, m.name,
           sum(case when m.sold_by_weight then coalesce(oi.weight_g, 0) / 1000 else oi.quantity end) as qty,
           sum(oi.quantity * oi.unit_price) as rev,
           sum(case
                 when m.sold_by_weight and wi.id is not null
                   then coalesce(oi.weight_g, 0) * coalesce(grams_to_unit(wi.unit), 0) * wi.cost_per_unit + c.unit_cost * oi.quantity
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
revoke execute on function acct_menu_profit(uuid, date, date) from public, anon;
grant execute on function acct_menu_profit(uuid, date, date) to authenticated;

-- ===== 14) โหมดมืออาชีพ: งบทดลอง (ใช้ทำงบกำไรขาดทุน/งบดุล) · สมุดรายวัน · บัญชีแยกประเภท =====
create or replace function acct_trial_balance(p_restaurant_id uuid, p_from date, p_to date)
returns table (account_id uuid, code text, name text, type text, grp text, opening numeric, debit numeric, credit numeric, closing numeric)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'accountant']) then
    raise exception 'forbidden';
  end if;
  return query
  select a.id, a.code, a.name, a.type, a.grp,
         coalesce(sum(jl.debit - jl.credit) filter (where e.entry_date < p_from), 0),
         coalesce(sum(jl.debit) filter (where e.entry_date between p_from and p_to), 0),
         coalesce(sum(jl.credit) filter (where e.entry_date between p_from and p_to), 0),
         coalesce(sum(jl.debit - jl.credit) filter (where e.entry_date <= p_to), 0)
  from accounts a
  left join journal_lines jl on jl.account_id = a.id
  left join journal_entries e on e.id = jl.entry_id
  where a.restaurant_id = p_restaurant_id
  group by a.id
  order by a.code;
end;
$$;
revoke execute on function acct_trial_balance(uuid, date, date) from public, anon;
grant execute on function acct_trial_balance(uuid, date, date) to authenticated;

create or replace function acct_journal_rows(p_restaurant_id uuid, p_from date, p_to date, p_account_id uuid default null, p_limit int default 5000)
returns table (
  entry_id uuid, entry_no bigint, entry_date date, source_type text, source_id uuid, memo text, reason text,
  reverses_entry_id uuid, created_at timestamptz, created_by_name text,
  line_id bigint, account_code text, account_name text, debit numeric, credit numeric, line_memo text
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'accountant']) then
    raise exception 'forbidden';
  end if;
  return query
  select e.id, e.entry_no, e.entry_date, e.source_type, e.source_id, e.memo, e.reason, e.reverses_entry_id, e.created_at,
         coalesce(u.display_name, u.email), jl.id, a.code, a.name, jl.debit, jl.credit, jl.memo
  from journal_entries e
  join journal_lines jl on jl.entry_id = e.id
  join accounts a on a.id = jl.account_id
  left join app_users u on u.id = e.created_by
  where e.restaurant_id = p_restaurant_id and e.entry_date between p_from and p_to
    and (p_account_id is null or jl.account_id = p_account_id)
  order by e.entry_date, e.entry_no, jl.id
  limit least(greatest(coalesce(p_limit, 5000), 1), 50000);
end;
$$;
revoke execute on function acct_journal_rows(uuid, date, date, uuid, int) from public, anon;
grant execute on function acct_journal_rows(uuid, date, date, uuid, int) to authenticated;

-- ===== 15) ปิดวัน =====
create or replace function acct_day_summary(p_restaurant_id uuid, p_date date)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  d day_closes;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'accountant']) then
    raise exception 'forbidden';
  end if;
  select * into d from day_closes where restaurant_id = p_restaurant_id and close_date = p_date;
  return acct_summary_data(p_restaurant_id, p_date, p_date) || jsonb_build_object(
    'restaurant', (select name from restaurants where id = p_restaurant_id),
    'date', p_date,
    'system_cash', (select coalesce(sum(jl.debit - jl.credit), 0)
                    from journal_lines jl join journal_entries e on e.id = jl.entry_id
                    join accounts a on a.id = jl.account_id and a.grp = 'cash'
                    where jl.restaurant_id = p_restaurant_id and e.entry_date <= p_date
                      and not (e.source_type = 'day_close' and e.entry_date = p_date)),
    'closed', d.id is not null,
    'close', case when d.id is null then null else jsonb_build_object(
      'counted_cash', d.counted_cash, 'difference', d.difference, 'note', d.note,
      'confirmed_by_name', d.confirmed_by_name, 'created_at', d.created_at) end
  );
end;
$$;
revoke execute on function acct_day_summary(uuid, date) from public, anon;
grant execute on function acct_day_summary(uuid, date) to authenticated;

-- นับเงินสดในลิ้นชักแล้วยืนยัน: ส่วนต่างลงบัญชีเงินสดขาด/เกิน แล้วล็อกวันนั้น (เพิ่มรายการไม่ได้อีก แก้ได้เฉพาะกลับรายการ)
create or replace function acct_close_day(p_restaurant_id uuid, p_date date, p_counted_cash numeric, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_system numeric;
  v_diff numeric;
  v_entry uuid;
  v_summary jsonb;
  v_id uuid;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager']) then
    raise exception 'forbidden';
  end if;
  if p_date is null or p_date > acct_today(p_restaurant_id) then
    raise exception 'invalid_date';
  end if;
  if p_counted_cash is null or p_counted_cash < 0 or p_counted_cash > 100000000 then
    raise exception 'invalid_amount';
  end if;
  perform 1 from restaurants where id = p_restaurant_id for update;     -- กันปิดวันซ้ำพร้อมกัน 2 เครื่อง
  if exists (select 1 from day_closes where restaurant_id = p_restaurant_id and close_date = p_date) then
    raise exception 'already_closed';
  end if;

  select coalesce(sum(jl.debit - jl.credit), 0) into v_system
  from journal_lines jl join journal_entries e on e.id = jl.entry_id
  join accounts a on a.id = jl.account_id and a.grp = 'cash'
  where jl.restaurant_id = p_restaurant_id and e.entry_date <= p_date;
  v_diff := round(p_counted_cash, 2) - v_system;

  if v_diff <> 0 then
    v_entry := acct_new_entry(p_restaurant_id, 'day_close', null, p_date,
                              case when v_diff > 0 then 'ปิดวัน: เงินสดเกิน' else 'ปิดวัน: เงินสดขาด' end);
    perform acct_line(v_entry, 'cash', v_diff);
    perform acct_line(v_entry, 'cash_over_short', -v_diff);
  end if;

  v_summary := acct_summary_data(p_restaurant_id, p_date, p_date);
  insert into day_closes (restaurant_id, close_date, system_cash, counted_cash, difference, summary, note, confirmed_by, confirmed_by_name)
  values (p_restaurant_id, p_date, v_system, round(p_counted_cash, 2), v_diff, v_summary, nullif(left(trim(p_note), 300), ''),
          (select id from app_users where id = auth.uid()),
          (select coalesce(display_name, email) from app_users where id = auth.uid()))
  returning id into v_id;

  return v_summary || jsonb_build_object(
    'id', v_id, 'restaurant', (select name from restaurants where id = p_restaurant_id), 'date', p_date,
    'system_cash', v_system, 'counted_cash', round(p_counted_cash, 2), 'difference', v_diff, 'closed', true);
end;
$$;
revoke execute on function acct_close_day(uuid, date, numeric, text) from public, anon;
grant execute on function acct_close_day(uuid, date, numeric, text) to authenticated;

-- ===== 16) ยอดยกมาของสต็อกที่มีอยู่ก่อนเปิดใช้โมดูลบัญชี (บัญชีสต็อก = มูลค่าในโมดูลสต็อกตั้งแต่วันแรก) =====
do $$
declare
  r record;
  v uuid;
begin
  for r in
    select i.restaurant_id, sum(round(i.quantity_on_hand * i.cost_per_unit, 2)) as v
    from ingredients i
    group by i.restaurant_id
    having sum(round(i.quantity_on_hand * i.cost_per_unit, 2)) <> 0
  loop
    if not exists (select 1 from journal_entries where restaurant_id = r.restaurant_id) then
      v := acct_new_entry(r.restaurant_id, 'opening', null, acct_today(r.restaurant_id), 'ยอดยกมา สต็อกวัตถุดิบ (เปิดใช้โมดูลบัญชี)');
      perform acct_line(v, 'stock', r.v);
      perform acct_line(v, 'equity', -r.v);
    end if;
  end loop;
end;
$$;


-- ======================================================================
-- 0027_stock_ledger.sql
-- ======================================================================
-- 0027: สต็อกแบบ ledger + ล็อต (โมดูลสต็อกวัตถุดิบ ตอนที่ 1/4)
--   หลักการ
--   - ยอดคงเหลือ = ผลรวมของ stock_movements เสมอ · ingredients.quantity_on_hand เป็นแค่ยอดสะสมที่ trigger ดูแล แก้ตรงไม่ได้
--   - stock_movements เพิ่มได้อย่างเดียว (append-only) ผิดให้สร้างรายการกลับ (reverses_id)
--   - สต็อกมี 3 แหล่ง: receive (นำเข้า) · recipe_deduct / recipe_return (ตัด/คืนตามสูตร) · count_adjust (นับสุดท้าย)
--     ไม่มีการบันทึกของเสียแยก ของหาย/เสียทั้งหมดไปโผล่เป็นส่วนต่างตอนนับ (Actual vs Theoretical)
--   - ทุกการรับเข้าสร้างล็อต (stock_lots) · หยิบของแบบ FEFO (หมดอายุก่อนออกก่อน) · คิดต้นทุนแบบ FIFO (รับก่อนคิดก่อน)
--     ล็อตเดียวมี 2 ยอด: qty_remaining (ของจริงบนชั้น ตัดแบบ FEFO) และ fifo_remaining (ชั้นต้นทุน ตัดแบบ FIFO)
--     ทั้งสองรวมกันทุกล็อตเท่ากับยอดคงเหลือเสมอ · stock_movement_lots จำว่ารายการไหนใช้ล็อตไหน (คืนได้ตรงล็อต)
--   - หน่วยฐาน (recipe_unit) มีแค่ g / ml / pcs · สต็อก สูตร ล็อต นับ เก็บเป็นหน่วยฐานทั้งหมด
--     หน่วยซื้อ (purchase_unit x conversion_factor) และหน่วยที่ครัวพูด (display_unit x display_factor) ใช้ตอนกรอก/แสดง
--   - บัญชี (0026) ยังใช้ quantity_on_hand x cost_per_unit · cost_per_unit = ต้นทุนเฉลี่ยของชั้น FIFO ที่เหลือ
--     จึงเท่ากับมูลค่าสต็อกแบบ FIFO และกระทบยอดกับบัญชีได้เหมือนเดิม

-- ===== 1) แปลงหน่วยเดิมเป็นหน่วยฐาน =====
create or replace function stock_unit_base(p_unit text, out base text, out factor numeric)
language sql immutable set search_path = public, pg_temp as $$
  select case
           when u in ('g', 'gram', 'grams', 'กรัม', 'kg', 'kgs', 'kilogram', 'กก', 'กก.', 'กิโลกรัม', 'กิโล') then 'g'
           when u in ('ml', 'มล', 'มล.', 'มิลลิลิตร', 'l', 'lt', 'liter', 'litre', 'ลิตร') then 'ml'
           else 'pcs'
         end,
         case
           when u in ('kg', 'kgs', 'kilogram', 'กก', 'กก.', 'กิโลกรัม', 'กิโล', 'l', 'lt', 'liter', 'litre', 'ลิตร') then 1000
           else 1
         end::numeric
  from (select lower(trim(coalesce(p_unit, ''))) as u) x;
$$;

-- ต้นทุนต่อกรัมต้องการทศนิยมมากขึ้น (เช่น 123.45 บาท/kg = 0.12345 บาท/g)
drop view if exists menu_item_costs;   -- สร้างใหม่ใน 0028 (อ่านต้นทุนจากสูตรแบบใหม่)
-- trigger บัญชีผูกกับคอลัมน์ที่เปลี่ยนชนิด: ถอดออกก่อน แล้วสร้างคืนหลังแปลงหน่วย (มูลค่าไม่เปลี่ยน ไม่ต้องลงบัญชี)
drop trigger if exists ingredients_accounting on ingredients;
-- นโยบายเดิมที่ให้ครัวบันทึกของเสียเอง (อ้างคอลัมน์ change) ไม่มีแล้ว: ระบบใหม่เขียน ledger ผ่านฟังก์ชันเท่านั้น (0030)
drop policy if exists stock_movements_insert on stock_movements;
alter table ingredients alter column cost_per_unit type numeric(16,7);
alter table stock_count_lines alter column unit_cost type numeric(16,7);
alter table stock_receipt_lines alter column unit_cost type numeric(16,7);
alter table stock_receipt_lines alter column prev_unit_cost type numeric(16,7);
alter table ingredients alter column quantity_on_hand type numeric(14,3);
alter table stock_movements alter column change type numeric(14,3);
alter table stock_movements alter column balance_after type numeric(14,3);

-- ===== 2) คอลัมน์ใหม่ของวัตถุดิบ =====
alter table ingredients add column if not exists recipe_unit text;                       -- g | ml | pcs (หน่วยฐาน)
alter table ingredients add column if not exists purchase_unit text check (char_length(purchase_unit) <= 30);   -- เช่น kg, ลัง
alter table ingredients add column if not exists conversion_factor numeric(14,4) not null default 1
  check (conversion_factor > 0);                                                        -- 1 หน่วยซื้อ = ? หน่วยฐาน
alter table ingredients add column if not exists display_unit text check (char_length(display_unit) <= 30);     -- หน่วยที่ครัวพูด เช่น ถุง ฟอง
alter table ingredients add column if not exists display_factor numeric(14,4) not null default 1
  check (display_factor > 0);                                                           -- 1 หน่วยครัว = ? หน่วยฐาน
alter table ingredients add column if not exists trim_yield_pct numeric(5,2) not null default 100
  check (trim_yield_pct > 0 and trim_yield_pct <= 100);                                 -- เหลือหลังตัดแต่ง/แกะ/ล้าง
alter table ingredients add column if not exists cook_yield_pct numeric(5,2) not null default 100
  check (cook_yield_pct > 0 and cook_yield_pct <= 400);                                 -- หลังปรุง (ข้าวหุงสุก > 100)
alter table ingredients add column if not exists abc_class text not null default 'C' check (abc_class in ('A', 'B', 'C'));
alter table ingredients add column if not exists storage_location text check (char_length(storage_location) <= 40);  -- เช่น ตู้แช่ 1
alter table ingredients add column if not exists shelf_order int not null default 0;    -- ลำดับบนชั้น (เรียงใบนับ shelf-to-sheet)
alter table ingredients add column if not exists par_level numeric(14,3) check (par_level >= 0);   -- ว่าง = คำนวณให้
alter table ingredients add column if not exists safety_stock numeric(14,3) not null default 0 check (safety_stock >= 0);
alter table ingredients add column if not exists last_unit_cost numeric(16,7) check (last_unit_cost >= 0);  -- ราคาซื้อล่าสุด/หน่วยฐาน (คิดต้นทุนสูตร)
alter table ingredients add column if not exists is_active boolean not null default true;

-- yield รวมแบบเดิม = trim x cook (ฟังก์ชันเก่ายังอ่าน yield_pct ได้)
alter table ingredients drop constraint if exists ingredients_yield_pct_check;
alter table ingredients add constraint ingredients_yield_pct_check check (yield_pct > 0 and yield_pct <= 400);
update ingredients set trim_yield_pct = yield_pct where yield_pct <= 100;

-- ===== 3) เปลี่ยนวัตถุดิบเดิมเป็นหน่วยฐาน (kg -> g, ลิตร -> ml) =====
-- ปรับทุกตัวเลขที่เป็นหน่วยของวัตถุดิบนั้นด้วยตัวคูณเดียวกัน: มูลค่า (จำนวน x ต้นทุน) ไม่เปลี่ยน บัญชีจึงไม่ต้องลงรายการ
create temp table stock_redenom on commit drop as
select i.id, i.unit as old_unit, b.base, b.factor
from ingredients i cross join lateral stock_unit_base(i.unit) b;

update ingredients i
   set recipe_unit = r.base,
       unit = case when r.base = 'pcs' then i.unit else r.base end,
       quantity_on_hand = i.quantity_on_hand * r.factor,
       reorder_level = i.reorder_level * r.factor,
       cost_per_unit = i.cost_per_unit / r.factor,
       last_unit_cost = i.cost_per_unit / r.factor,
       batch_output_qty = i.batch_output_qty * r.factor,
       purchase_unit = i.unit,
       conversion_factor = r.factor,
       display_unit = case when r.factor <> 1 or r.base = 'pcs' then i.unit end,
       display_factor = r.factor
  from stock_redenom r where r.id = i.id;

update stock_movements m set change = m.change * r.factor, balance_after = m.balance_after * r.factor
  from stock_redenom r where r.id = m.ingredient_id and r.factor <> 1;
update recipes x set quantity_used = x.quantity_used * r.factor
  from stock_redenom r where r.id = x.ingredient_id and r.factor <> 1;
update prep_components x set quantity = x.quantity * r.factor
  from stock_redenom r where r.id = x.ingredient_id and r.factor <> 1;
update prep_batches x set output_qty = x.output_qty * r.factor
  from stock_redenom r where r.id = x.prep_id and r.factor <> 1;
update ingredient_units x set factor = x.factor * r.factor
  from stock_redenom r where r.id = x.ingredient_id and r.factor <> 1;
update stock_count_lines x
   set system_qty = x.system_qty * r.factor, counted_qty = x.counted_qty * r.factor, diff = x.diff * r.factor,
       unit_cost = x.unit_cost / r.factor, unit = r.base
  from stock_redenom r where r.id = x.ingredient_id and r.factor <> 1;
update stock_receipt_lines x
   set quantity = x.quantity * r.factor, unit_cost = x.unit_cost / r.factor, invoice_qty = x.invoice_qty * r.factor,
       gross_qty = x.gross_qty * r.factor, prev_unit_cost = x.prev_unit_cost / r.factor, unit = r.base
  from stock_redenom r where r.id = x.ingredient_id and r.factor <> 1;

create trigger ingredients_accounting
  after insert or update of quantity_on_hand, cost_per_unit or delete on ingredients
  for each row execute function acct_ingredient_value();

update ingredients set yield_pct = round(trim_yield_pct * cook_yield_pct / 100, 2);
alter table ingredients alter column recipe_unit set not null;
-- ไม่มีค่าเริ่มต้น: ผู้เรียกที่ไม่ส่ง recipe_unit (แบบเดิม ส่งแค่ unit เช่น kg) ให้ trigger แปลงหน่วยให้ (ingredients_before_write)
alter table ingredients add constraint ingredients_recipe_unit_check check (recipe_unit in ('g', 'ml', 'pcs'));

-- ===== 4) ผู้ขาย =====
create table if not exists suppliers (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 100),
  phone text check (char_length(phone) <= 30),
  lead_time_days int not null default 1 check (lead_time_days between 0 and 60),   -- สั่งแล้วกี่วันได้ของ
  delivery_days int[] not null default '{0,1,2,3,4,5,6}'                           -- วันที่มาส่ง 0=อาทิตย์ .. 6=เสาร์
    check (cardinality(delivery_days) between 1 and 7 and delivery_days <@ '{0,1,2,3,4,5,6}'),
  note text check (char_length(note) <= 200),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists suppliers_restaurant_name_key on suppliers (restaurant_id, lower(trim(name)));

alter table ingredients add column if not exists supplier_id uuid references suppliers(id) on delete set null;
alter table stock_receipts add column if not exists supplier_id uuid references suppliers(id) on delete set null;

-- ชื่อผู้ขายเดิมในใบรับของ -> แถวผู้ขาย
insert into suppliers (restaurant_id, name)
select distinct restaurant_id, trim(supplier) from stock_receipts where nullif(trim(supplier), '') is not null
on conflict do nothing;
update stock_receipts r set supplier_id = s.id
  from suppliers s where s.restaurant_id = r.restaurant_id and lower(trim(s.name)) = lower(trim(r.supplier));

-- ===== 5) ล็อต =====
create table if not exists stock_lots (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  ingredient_id uuid not null references ingredients(id) on delete cascade,
  receipt_id uuid references stock_receipts(id) on delete set null,
  source text not null check (source in ('receive', 'count', 'opening', 'return')),
  qty numeric(14,3) not null check (qty > 0),                                     -- ที่รับเข้า (หน่วยฐาน)
  qty_remaining numeric(14,3) not null check (qty_remaining >= 0 and qty_remaining <= qty),    -- ของจริง (FEFO)
  fifo_remaining numeric(14,3) not null check (fifo_remaining >= 0 and fifo_remaining <= qty), -- ชั้นต้นทุน (FIFO)
  raw_unit_cost numeric(16,7) not null check (raw_unit_cost >= 0),                -- ราคาซื้อต่อหน่วยฐาน (ก่อนหัก yield)
  unit_cost numeric(16,7) not null check (unit_cost >= 0),                        -- หลังหัก yield = ราคา / (trim x cook)
  expiry_date date,
  received_at timestamptz not null default now()
);
create index if not exists stock_lots_fefo_idx on stock_lots (ingredient_id, expiry_date nulls last, received_at) where qty_remaining > 0;
create index if not exists stock_lots_fifo_idx on stock_lots (ingredient_id, received_at) where fifo_remaining > 0;
create index if not exists stock_lots_expiry_idx on stock_lots (restaurant_id, expiry_date) where qty_remaining > 0;

-- ===== 6) ledger =====
alter table stock_movements add column if not exists type text;
alter table stock_movements add column if not exists qty numeric(14,3) generated always as (change) stored;  -- ชื่อตามสเปก
alter table stock_movements add column if not exists cost numeric(14,2);           -- มูลค่าตามต้นทุน FIFO (เครื่องหมายเดียวกับจำนวน)
alter table stock_movements add column if not exists unit_cost numeric(16,7);      -- ต้นทุนต่อหน่วยฐานของรายการนี้
alter table stock_movements add column if not exists expiry_date date;             -- วันหมดอายุของล็อตที่รับเข้า
alter table stock_movements add column if not exists ref_id uuid;                  -- เอกสารต้นทาง (ออเดอร์ ใบรับ ใบนับ)
alter table stock_movements add column if not exists reverses_id uuid references stock_movements(id);
create unique index if not exists stock_movements_reverses_key on stock_movements (reverses_id) where reverses_id is not null;
create index if not exists stock_movements_ingredient_type_idx on stock_movements (ingredient_id, type, created_at);
create index if not exists stock_movements_order_idx on stock_movements (order_id) where order_id is not null;

-- ประวัติเดิม: ของเสีย / ผลิตของเตรียม ไม่มีในระบบใหม่ เก็บไว้เป็น legacy (สร้างใหม่ไม่ได้)
update stock_movements set
  type = case reason::text
           when 'purchase' then 'receive'
           when 'adjustment' then 'count_adjust'
           when 'sale' then case when change < 0 then 'recipe_deduct' else 'recipe_return' end
           else 'legacy'
         end,
  ref_id = coalesce(order_id, receipt_id, count_id, batch_id),
  cost = round(change * (select cost_per_unit from ingredients i where i.id = ingredient_id), 2);

-- ยอดตั้งต้นที่ไม่เคยผ่าน ledger (เช่น สร้างวัตถุดิบพร้อมยอด) -> 1 รายการยกมา ให้ ผลรวม ledger = คงเหลือ
alter table stock_movements disable trigger stock_movements_apply;
insert into stock_movements (restaurant_id, ingredient_id, change, reason, type, note, balance_after, cost)
select i.restaurant_id, i.id, i.quantity_on_hand - coalesce(s.total, 0), 'adjustment', 'legacy',
       'ยอดยกมา (ปรับประวัติให้ตรงคงเหลือ ก่อนเปิดใช้ ledger)', i.quantity_on_hand,
       round((i.quantity_on_hand - coalesce(s.total, 0)) * i.cost_per_unit, 2)
from ingredients i
left join (select ingredient_id, sum(change) as total from stock_movements group by ingredient_id) s on s.ingredient_id = i.id
where i.quantity_on_hand <> coalesce(s.total, 0);
alter table stock_movements enable trigger stock_movements_apply;

alter table stock_movements alter column type set not null;
alter table stock_movements add constraint stock_movements_type_check
  check (type in ('receive', 'recipe_deduct', 'recipe_return', 'count_adjust', 'legacy'));

-- ล็อตตั้งต้น: ยอดที่มีอยู่ ณ วันเปิดใช้ ที่ต้นทุนเดิม
insert into stock_lots (restaurant_id, ingredient_id, source, qty, qty_remaining, fifo_remaining, raw_unit_cost, unit_cost)
select restaurant_id, id, 'opening', quantity_on_hand, quantity_on_hand, quantity_on_hand, cost_per_unit,
       round(cost_per_unit * 10000 / (trim_yield_pct * cook_yield_pct), 7)
from ingredients where quantity_on_hand > 0;

-- รายการไหนใช้/เติมล็อตไหน (basis: fefo = ของจริง, fifo = ชั้นต้นทุน) · qty มีเครื่องหมายเดียวกับรายการ
create table if not exists stock_movement_lots (
  movement_id uuid not null references stock_movements(id) on delete cascade deferrable initially deferred,
  lot_id uuid not null references stock_lots(id) on delete cascade,
  basis text not null check (basis in ('fefo', 'fifo')),
  qty numeric(14,3) not null check (qty <> 0),
  unit_cost numeric(16,7) not null,
  primary key (movement_id, lot_id, basis)
);
create index if not exists stock_movement_lots_lot_idx on stock_movement_lots (lot_id);

-- บัญชี: รายการคืนสต็อกจากออเดอร์ที่ยกเลิก
alter table journal_entries drop constraint if exists journal_entries_source_type_check;
alter table journal_entries add constraint journal_entries_source_type_check check (source_type in (
  'bill', 'stock_receipt', 'recipe_deduct', 'recipe_return', 'count_adjust', 'expense', 'reversal', 'day_close',
  'waste', 'production', 'stock_revalue', 'supplier_claim', 'supplier_payment', 'opening'));

-- ===== 7) ตัด/เติมล็อต (ใช้ภายในเท่านั้น) =====
-- ตัดออก: ของจริงแบบ FEFO และต้นทุนแบบ FIFO · คืนมูลค่า FIFO (บวก)
create or replace function stock_take_lots(p_movement uuid, p_ingredient uuid, p_qty numeric)
returns numeric
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_need numeric;
  v_take numeric;
  v_cost numeric := 0;
  l stock_lots;
begin
  v_need := p_qty;
  for l in select * from stock_lots where ingredient_id = p_ingredient and qty_remaining > 0
           order by expiry_date nulls last, received_at, id for update
  loop
    exit when v_need <= 0;
    v_take := least(v_need, l.qty_remaining);
    update stock_lots set qty_remaining = qty_remaining - v_take where id = l.id;
    insert into stock_movement_lots values (p_movement, l.id, 'fefo', -v_take, l.raw_unit_cost);
    v_need := v_need - v_take;
  end loop;
  if v_need > 0 then
    raise exception 'lots_out_of_sync';
  end if;

  v_need := p_qty;
  for l in select * from stock_lots where ingredient_id = p_ingredient and fifo_remaining > 0
           order by received_at, id for update
  loop
    exit when v_need <= 0;
    v_take := least(v_need, l.fifo_remaining);
    update stock_lots set fifo_remaining = fifo_remaining - v_take where id = l.id;
    insert into stock_movement_lots values (p_movement, l.id, 'fifo', -v_take, l.raw_unit_cost);
    v_cost := v_cost + v_take * l.raw_unit_cost;
    v_need := v_need - v_take;
  end loop;
  if v_need > 0 then
    raise exception 'lots_out_of_sync';
  end if;
  return v_cost;
end;
$$;

-- เติมเข้า: สร้างล็อตใหม่ · คืนมูลค่า (บวก)
create or replace function stock_add_lot(
  p_movement uuid, p_ing ingredients, p_qty numeric, p_unit_cost numeric, p_source text,
  p_receipt uuid default null, p_expiry date default null
)
returns numeric
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_lot uuid;
begin
  insert into stock_lots (restaurant_id, ingredient_id, receipt_id, source, qty, qty_remaining, fifo_remaining,
                          raw_unit_cost, unit_cost, expiry_date)
  values (p_ing.restaurant_id, p_ing.id, p_receipt, p_source, p_qty, p_qty, p_qty, p_unit_cost,
          round(p_unit_cost * 10000 / (p_ing.trim_yield_pct * p_ing.cook_yield_pct), 7), p_expiry)
  returning id into v_lot;
  insert into stock_movement_lots values (p_movement, v_lot, 'fefo', p_qty, p_unit_cost), (p_movement, v_lot, 'fifo', p_qty, p_unit_cost);
  return p_qty * p_unit_cost;
end;
$$;

-- กลับรายการ: ย้อนผลต่อล็อตของรายการต้นทางทีละบรรทัด · คืน (มูลค่าที่ย้อนแล้ว, จำนวนที่ย้อนแล้ว)
create or replace function stock_undo_lots(p_movement uuid, p_original uuid, out cost numeric, out qty numeric)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
begin
  cost := 0;
  qty := 0;
  for r in select ml.*, l.qty_remaining, l.fifo_remaining
           from stock_movement_lots ml join stock_lots l on l.id = ml.lot_id
           where ml.movement_id = p_original order by ml.basis, ml.lot_id
           for update of l
  loop
    -- รายการต้นทางเติมล็อต (รับเข้า) แต่ของในล็อตถูกใช้ไปแล้ว: ย้อนไม่ได้
    if r.qty > 0 and ((r.basis = 'fefo' and r.qty_remaining < r.qty) or (r.basis = 'fifo' and r.fifo_remaining < r.qty)) then
      raise exception 'lot_already_used';
    end if;
    if r.basis = 'fefo' then
      update stock_lots set qty_remaining = qty_remaining - r.qty where id = r.lot_id;
      qty := qty - r.qty;
    else
      update stock_lots set fifo_remaining = fifo_remaining - r.qty where id = r.lot_id;
      cost := cost - r.qty * r.unit_cost;
    end if;
    insert into stock_movement_lots values (p_movement, r.lot_id, r.basis, -r.qty, r.unit_cost);
  end loop;
end;
$$;

revoke execute on function stock_take_lots(uuid, uuid, numeric) from public, anon, authenticated;
revoke execute on function stock_add_lot(uuid, ingredients, numeric, numeric, text, uuid, date) from public, anon, authenticated;
revoke execute on function stock_undo_lots(uuid, uuid) from public, anon, authenticated;

-- ===== 8) trigger หลักของ ledger =====
-- ก่อนบันทึก: ตรวจกฎ -> ตัด/เติมล็อต -> คิดต้นทุน FIFO -> ปรับยอดคงเหลือ + ต้นทุนเฉลี่ยของชั้น FIFO ในคำสั่งเดียว
-- (บัญชี 0026 ลงรายการจากผลต่างมูลค่า ตามบริบท plato.stock_ctx)
create or replace function apply_stock_movement()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ing ingredients;
  v_rev stock_movements;
  v_cost numeric;
  v_done record;
  v_unit numeric;
  v_val numeric;
  v_q numeric;
  v_ctx text;
begin
  new.created_by := auth.uid();
  -- ผู้เรียกแบบเดิมส่งแค่ reason: แปลงเป็นประเภทใหม่ (ของเสีย/ผลิตไม่มีแล้ว)
  if new.type is null then
    new.type := case new.reason::text
                  when 'purchase' then 'receive'
                  when 'adjustment' then 'count_adjust'
                  when 'sale' then case when new.change < 0 then 'recipe_deduct' else 'recipe_return' end
                end;
  end if;
  if new.type is null or new.type = 'legacy' then
    raise exception 'movement_type_not_allowed';
  end if;
  new.reason := (case new.type when 'receive' then 'purchase' when 'count_adjust' then 'adjustment' else 'sale' end)::stock_reason;
  new.waste_type := null;
  new.batch_id := null;
  new.change := round(new.change, 3);
  new.ref_id := coalesce(new.ref_id, new.order_id, new.receipt_id, new.count_id);
  if new.change is null or new.change = 0 then
    raise exception 'invalid_quantity';
  end if;
  if (new.type = 'recipe_deduct' and new.change > 0)
     or (new.type = 'recipe_return' and (new.change < 0 or new.reverses_id is null))
     or (new.type = 'receive' and new.change < 0 and new.reverses_id is null) then
    raise exception 'invalid_quantity';
  end if;

  select * into v_ing from ingredients where id = new.ingredient_id and restaurant_id = new.restaurant_id for update;
  if v_ing.id is null then
    raise exception 'invalid_ingredient';
  end if;
  if new.reverses_id is not null then
    -- รายการกลับ: ต้องตรงข้ามกับต้นทางพอดี และกลับได้ครั้งเดียว (unique index)
    select * into v_rev from stock_movements where id = new.reverses_id;
    if v_rev.id is null or v_rev.ingredient_id <> new.ingredient_id or v_rev.change <> -new.change
       or v_rev.type = 'legacy' or v_rev.reverses_id is not null
       or new.type <> (case v_rev.type when 'recipe_deduct' then 'recipe_return' else v_rev.type end) then
      raise exception 'invalid_reversal';
    end if;
    v_done := stock_undo_lots(new.id, v_rev.id);
    v_cost := v_done.cost;
    -- ประวัติก่อนมีล็อต: ส่วนที่ไม่รู้ล็อต ตัด/เติมตามปกติ
    if abs(v_done.qty) < abs(new.change) then
      if new.change > 0 then
        v_cost := v_cost + stock_add_lot(new.id, v_ing, new.change - v_done.qty,
                                         coalesce(abs(v_rev.cost / nullif(v_rev.change, 0)), v_ing.cost_per_unit), 'return');
      else
        v_cost := v_cost - stock_take_lots(new.id, new.ingredient_id, -(new.change - v_done.qty));
      end if;
    end if;
  elsif new.change < 0 then
    if v_ing.quantity_on_hand + new.change < 0 then
      raise exception 'insufficient_stock: %', v_ing.name;   -- สต็อกติดลบไม่ได้
    end if;
    v_cost := -stock_take_lots(new.id, new.ingredient_id, -new.change);
  else
    if new.type = 'receive' then
      v_unit := new.unit_cost;
    else
      -- นับเจอเกิน: คิดต้นทุนตามล็อตล่าสุด (ยังไม่เคยมีล็อต = ต้นทุนที่ตั้งไว้)
      select raw_unit_cost into v_unit from stock_lots where ingredient_id = new.ingredient_id order by received_at desc, id limit 1;
      v_unit := coalesce(new.unit_cost, v_unit, v_ing.last_unit_cost, v_ing.cost_per_unit, 0);
    end if;
    if v_unit is null or v_unit < 0 then
      raise exception 'invalid_cost';
    end if;
    v_cost := stock_add_lot(new.id, v_ing, new.change, v_unit,
                            case new.type when 'receive' then 'receive' else 'count' end, new.receipt_id, new.expiry_date);
  end if;

  new.cost := round(v_cost, 2);
  new.unit_cost := round(abs(v_cost / new.change), 7);

  v_ctx := case new.type
    when 'receive' then
      case when new.receipt_id is null then 'stock_receipt||@payment'
           when new.reverses_id is not null then 'stock_receipt|' || new.receipt_id || '|claim'
           else 'stock_receipt|' || new.receipt_id || '|' end
    when 'recipe_deduct' then 'recipe_deduct|' || coalesce(new.order_id::text, '') || '|cogs'
    when 'recipe_return' then 'recipe_return|' || coalesce(new.order_id::text, '') || '|cogs'
    else
      -- ยอดแรกของวัตถุดิบ (สร้างพร้อมยอดยกมา/นับครั้งแรก) = ยอดยกมา ไม่ใช่ส่วนต่าง
      case when new.change > 0 and new.reverses_id is null
                and not exists (select 1 from stock_movements where ingredient_id = new.ingredient_id)
           then 'opening|' || new.ingredient_id || '|equity'
           else 'count_adjust|' || coalesce(new.count_id, new.id) || '|variance' end
  end;

  select sum(fifo_remaining * raw_unit_cost), sum(fifo_remaining) into v_val, v_q
  from stock_lots where ingredient_id = new.ingredient_id and fifo_remaining > 0;

  perform set_config('plato.stock_ctx', v_ctx, true);
  perform set_config('plato.ledger', 'on', true);
  update ingredients
     set quantity_on_hand = quantity_on_hand + new.change,
         cost_per_unit = case when v_q > 0 then round(v_val / v_q, 7) else cost_per_unit end
   where id = new.ingredient_id
  returning quantity_on_hand into new.balance_after;
  perform set_config('plato.ledger', '', true);
  perform set_config('plato.stock_ctx', '', true);
  return new;
end;
$$;

drop trigger if exists stock_movements_apply on stock_movements;
create trigger stock_movements_apply before insert on stock_movements
  for each row execute function apply_stock_movement();

-- append-only: แก้/ลบไม่ได้ (ยกเว้นลบทั้งร้าน/วัตถุดิบ และ FK ที่ตั้งเป็น null เมื่อเอกสารต้นทางถูกลบ)
create or replace function stock_movements_guard()
returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from restaurants where id = old.restaurant_id)
       and exists (select 1 from ingredients where id = old.ingredient_id) then
      raise exception 'stock_ledger_append_only';
    end if;
    return old;
  end if;
  if (new.restaurant_id, new.ingredient_id, new.change, new.type, new.cost, new.unit_cost, new.balance_after,
      new.created_at, new.created_by, new.reverses_id, new.note)
     is distinct from
     (old.restaurant_id, old.ingredient_id, old.change, old.type, old.cost, old.unit_cost, old.balance_after,
      old.created_at, old.created_by, old.reverses_id, old.note) then
    raise exception 'stock_ledger_append_only';
  end if;
  return new;
end;
$$;
drop trigger if exists stock_movements_guard on stock_movements;
create trigger stock_movements_guard before update or delete on stock_movements
  for each row execute function stock_movements_guard();

-- ===== 9) วัตถุดิบ: หน่วย yield ยอดยกมา และห้ามแก้ยอด/ต้นทุนตรงๆ =====
create or replace function ingredients_before_write()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b record;
begin
  if tg_op = 'INSERT' then
    -- ผู้เรียกแบบเดิมส่งแค่ unit (เช่น kg): แปลงเป็นหน่วยฐาน ตัวเลขทุกช่องคูณตามกัน
    if new.recipe_unit is null then
      select * into b from stock_unit_base(new.unit);
      new.recipe_unit := b.base;
      if b.factor <> 1 then
        new.purchase_unit := coalesce(new.purchase_unit, new.unit);
        new.conversion_factor := b.factor;
        new.display_unit := coalesce(new.display_unit, new.unit);
        new.display_factor := b.factor;
        new.quantity_on_hand := new.quantity_on_hand * b.factor;
        new.reorder_level := new.reorder_level * b.factor;
        new.batch_output_qty := new.batch_output_qty * b.factor;
        new.cost_per_unit := new.cost_per_unit / b.factor;
      end if;
    end if;
    new.purchase_unit := coalesce(nullif(trim(new.purchase_unit), ''), case when new.recipe_unit = 'pcs' then new.unit else new.recipe_unit end);
    new.last_unit_cost := coalesce(new.last_unit_cost, new.cost_per_unit);
    -- ยอดเริ่มต้นไม่เขียนลงยอดตรงๆ: เก็บไว้แล้วบันทึกเป็นรายการยกมาหลังสร้างแถว (ingredients_after_insert)
    if new.quantity_on_hand > 0 then
      perform set_config('plato.open_' || replace(new.id::text, '-', ''), new.quantity_on_hand::text, true);
    end if;
    new.quantity_on_hand := 0;
  else
    if (new.quantity_on_hand, new.cost_per_unit, new.last_unit_cost)
       is distinct from (old.quantity_on_hand, old.cost_per_unit, old.last_unit_cost)
       and coalesce(current_setting('plato.ledger', true), '') <> 'on' then
      raise exception 'stock_balance_is_ledger';   -- ยอด/ต้นทุนมาจาก ledger และใบรับของเท่านั้น
    end if;
    if new.recipe_unit <> old.recipe_unit
       and exists (select 1 from stock_movements where ingredient_id = old.id) then
      raise exception 'recipe_unit_locked';
    end if;
    -- ผู้เรียกแบบเดิมแก้ yield_pct: ถือเป็น trim yield
    if new.yield_pct is distinct from old.yield_pct
       and (new.trim_yield_pct, new.cook_yield_pct) is not distinct from (old.trim_yield_pct, old.cook_yield_pct) then
      if new.yield_pct is null or new.yield_pct <= 0 or new.yield_pct > 100 then
        raise exception 'invalid_yield';
      end if;
      new.trim_yield_pct := new.yield_pct;
      new.cook_yield_pct := 100;
    end if;
  end if;

  if tg_op = 'INSERT' and new.trim_yield_pct = 100 and new.cook_yield_pct = 100 and coalesce(new.yield_pct, 100) <> 100 then
    if new.yield_pct <= 0 or new.yield_pct > 100 then
      raise exception 'invalid_yield';
    end if;
    new.trim_yield_pct := new.yield_pct;
  end if;
  new.yield_pct := round(new.trim_yield_pct * new.cook_yield_pct / 100, 2);
  -- หน่วยแสดงผล: g/ml ใช้ชื่อหน่วยฐาน · pcs ใช้ชื่อที่ร้านตั้ง (ฟอง ขวด ตัว)
  if new.recipe_unit in ('g', 'ml') then
    new.unit := new.recipe_unit;
  elsif new.unit is null or (stock_unit_base(new.unit)).base <> 'pcs' then
    new.unit := 'pcs';
  end if;
  return new;
end;
$$;
drop trigger if exists ingredients_before_write on ingredients;
create trigger ingredients_before_write before insert or update on ingredients
  for each row execute function ingredients_before_write();

create or replace function ingredients_after_insert()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_key text := 'plato.open_' || replace(new.id::text, '-', '');
  v_qty numeric := nullif(current_setting(v_key, true), '')::numeric;
begin
  if v_qty > 0 then
    perform set_config(v_key, '', true);
    insert into stock_movements (restaurant_id, ingredient_id, change, type, unit_cost, note)
    values (new.restaurant_id, new.id, v_qty, 'count_adjust', new.cost_per_unit, 'ยอดยกมา');
  end if;
  return null;
end;
$$;
drop trigger if exists ingredients_after_insert on ingredients;
create trigger ingredients_after_insert after insert on ingredients
  for each row execute function ingredients_after_insert();

-- วัตถุดิบที่มีประวัติลบไม่ได้ (ประวัติ ledger จะหาย) ใช้ปิดใช้งาน (is_active) แทน
create or replace function ingredients_before_delete()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from restaurants where id = old.restaurant_id)
     and exists (select 1 from stock_movements where ingredient_id = old.id) then
    raise exception 'ingredient_has_history';
  end if;
  return old;
end;
$$;
drop trigger if exists ingredients_before_delete on ingredients;
create trigger ingredients_before_delete before delete on ingredients
  for each row execute function ingredients_before_delete();

-- ===== 10) คำอธิบายรายการบัญชี: เพิ่ม "คืนสต็อก" (เหมือน 0026 ทุกอย่าง ยกเว้นข้อความ) =====
create or replace function acct_ingredient_value()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old numeric := 0;
  v_new numeric := 0;
  v_delta numeric;
  v_rid uuid := coalesce(new.restaurant_id, old.restaurant_id);
  v_ing uuid := coalesce(new.id, old.id);
  v_name text := coalesce(new.name, old.name);
  v_ctx text := nullif(current_setting('plato.stock_ctx', true), '');
  v_receipt text := nullif(current_setting('plato.receipt_ctx', true), '');
  v_src text;
  v_doc uuid;
  v_contra text;
  v_entry uuid;
begin
  if tg_op <> 'INSERT' then
    v_old := round(old.quantity_on_hand * old.cost_per_unit, 2);
  end if;
  if tg_op <> 'DELETE' then
    v_new := round(new.quantity_on_hand * new.cost_per_unit, 2);
  end if;
  v_delta := v_new - v_old;
  if v_delta = 0 or not exists (select 1 from restaurants where id = v_rid) then
    return null;
  end if;

  if v_ctx is not null then
    v_src := split_part(v_ctx, '|', 1);
    v_doc := nullif(split_part(v_ctx, '|', 2), '')::uuid;
    v_contra := nullif(split_part(v_ctx, '|', 3), '');
    if v_contra = '@payment' then
      v_contra := acct_payment_key(v_rid, null);
    end if;
  elsif v_receipt is not null then
    v_src := 'stock_receipt'; v_doc := v_receipt::uuid; v_contra := null;
  elsif tg_op = 'INSERT' then
    v_src := 'opening'; v_doc := v_ing; v_contra := 'equity';
  else
    v_src := 'stock_revalue'; v_doc := v_ing; v_contra := 'variance';
  end if;

  v_entry := acct_tx_entry(v_rid, v_src, v_doc, case v_src
    when 'recipe_deduct' then 'ตัดสต็อกตามสูตร'
    when 'recipe_return' then 'คืนสต็อกจากออเดอร์ที่ยกเลิก'
    when 'stock_receipt' then 'รับวัตถุดิบเข้า'
    when 'waste' then 'ของเสีย'
    when 'count_adjust' then 'ปรับยอดจากการตรวจนับ'
    when 'production' then 'ผลิตของเตรียม'
    when 'opening' then 'ยอดยกมาวัตถุดิบ'
    else 'ปรับมูลค่าสต็อก' end);
  perform acct_line(v_entry, 'stock', v_delta, v_ing, v_name);
  if v_contra is not null then
    perform acct_line(v_entry, v_contra, -v_delta, v_ing, v_name);
  end if;
  return null;
end;
$$;


-- ======================================================================
-- 0028_stock_recipes.sql
-- ======================================================================
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


-- ======================================================================
-- 0029_stock_operations.sql
-- ======================================================================
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


-- ======================================================================
-- 0030_stock_rls.sql
-- ======================================================================
-- 0030: สิทธิ์ของโมดูลสต็อกวัตถุดิบ (ตอนที่ 4/4)
--   - แยกข้อมูลรายร้าน: ทุก policy ตรวจ has_role(restaurant_id, ...) ของร้านนั้น
--   - จัดการสต็อกได้เฉพาะ เจ้าของ (owner) · ผู้จัดการ (manager) · พนักงานสต็อก (stock = stock_staff ในสเปก)
--   - พนักงานบัญชีอ่านอย่างเดียว (มูลค่าสต็อก/ต้นทุนใช้ในงบการเงิน) · หน้าร้าน/ครัวไม่เห็นข้อมูลสต็อก
--     ครัวยังตัดสต็อกได้ตามปกติผ่านการกด "เริ่มทำ" (trigger security definer)
--   - ledger ล็อต ใบรับ ใบนับ yield test: อ่านได้ · เขียนผ่านฟังก์ชันเท่านั้น (ตรวจกฎครบในธุรกรรมเดียว)

create or replace function stock_can_read(rid uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select has_role(rid, array['owner', 'manager', 'stock', 'accountant']);
$$;
create or replace function stock_can_write(rid uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select has_role(rid, array['owner', 'manager', 'stock']);
$$;
revoke execute on function stock_can_read(uuid) from public, anon;
revoke execute on function stock_can_write(uuid) from public, anon;
grant execute on function stock_can_read(uuid) to authenticated;
grant execute on function stock_can_write(uuid) to authenticated;

-- ===== วัตถุดิบ =====
drop policy if exists ingredients_read on ingredients;
drop policy if exists ingredients_write on ingredients;
drop policy if exists ingredients_manager_read on ingredients;
create policy ingredients_read on ingredients for select using (stock_can_read(restaurant_id));
create policy ingredients_insert on ingredients for insert with check (stock_can_write(restaurant_id));
create policy ingredients_update on ingredients for update using (stock_can_write(restaurant_id)) with check (stock_can_write(restaurant_id));
create policy ingredients_delete on ingredients for delete using (stock_can_write(restaurant_id));

-- ยอด/ต้นทุนแก้ตรงไม่ได้ (ledger + trigger ตรวจซ้ำ) · แก้ได้เฉพาะข้อมูลตั้งค่า
revoke update on ingredients from anon, authenticated;
grant update (name, unit, reorder_level, yield_pct, variance_threshold_pct, category, count_weekly,
              recipe_unit, purchase_unit, conversion_factor, display_unit, display_factor,
              trim_yield_pct, cook_yield_pct, abc_class, storage_location, shelf_order,
              par_level, safety_stock, supplier_id, is_active) on ingredients to authenticated;
revoke insert on ingredients from anon, authenticated;
grant insert (restaurant_id, name, unit, quantity_on_hand, reorder_level, cost_per_unit, yield_pct, variance_threshold_pct,
              category, count_weekly, recipe_unit, purchase_unit, conversion_factor, display_unit, display_factor,
              trim_yield_pct, cook_yield_pct, abc_class, storage_location, shelf_order, par_level, safety_stock,
              supplier_id, is_active) on ingredients to authenticated;

-- ===== ผู้ขาย =====
alter table suppliers enable row level security;
create policy suppliers_read on suppliers for select using (stock_can_read(restaurant_id));
create policy suppliers_write on suppliers for all using (stock_can_write(restaurant_id)) with check (stock_can_write(restaurant_id));

-- ผู้ขายของวัตถุดิบต้องอยู่ร้านเดียวกัน
create or replace function ingredients_check_supplier()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.supplier_id is not null
     and not exists (select 1 from suppliers where id = new.supplier_id and restaurant_id = new.restaurant_id) then
    raise exception 'invalid_supplier';
  end if;
  return new;
end;
$$;
drop trigger if exists ingredients_check_supplier on ingredients;
create trigger ingredients_check_supplier before insert or update of supplier_id on ingredients
  for each row execute function ingredients_check_supplier();

-- ===== ledger และล็อต: อ่านอย่างเดียว =====
drop policy if exists stock_movements_read on stock_movements;
drop policy if exists stock_movements_insert on stock_movements;
create policy stock_movements_read on stock_movements for select using (stock_can_read(restaurant_id));
revoke insert, update, delete on stock_movements from anon, authenticated;

alter table stock_lots enable row level security;
create policy stock_lots_read on stock_lots for select using (stock_can_read(restaurant_id));
revoke insert, update, delete on stock_lots from anon, authenticated;

alter table stock_movement_lots enable row level security;
create policy stock_movement_lots_read on stock_movement_lots for select
  using (exists (select 1 from stock_movements m where m.id = movement_id and stock_can_read(m.restaurant_id)));
revoke insert, update, delete on stock_movement_lots from anon, authenticated;

-- ===== สูตร =====
alter table recipes enable row level security;
create policy recipes_read on recipes for select using (stock_can_read(restaurant_id));
create policy recipes_write on recipes for all using (stock_can_write(restaurant_id)) with check (stock_can_write(restaurant_id));
revoke update (cost_per_output, cost_updated_at) on recipes from anon, authenticated;
revoke update on recipes from anon, authenticated;
grant update (name, menu_item_id, output_qty, output_unit, note) on recipes to authenticated;

alter table recipe_lines enable row level security;
create policy recipe_lines_read on recipe_lines for select
  using (exists (select 1 from recipes r where r.id = recipe_id and stock_can_read(r.restaurant_id)));
create policy recipe_lines_write on recipe_lines for all
  using (exists (select 1 from recipes r where r.id = recipe_id and stock_can_write(r.restaurant_id)))
  with check (exists (select 1 from recipes r where r.id = recipe_id and stock_can_write(r.restaurant_id)));

-- สูตรเดิม/ของเตรียมเดิม: อ่านย้อนหลังได้
drop policy if exists recipes_read on legacy_menu_recipes;
drop policy if exists recipes_manager_read on legacy_menu_recipes;
create policy legacy_menu_recipes_read on legacy_menu_recipes for select
  using (exists (select 1 from menu_items m where m.id = menu_item_id and stock_can_read(m.restaurant_id)));
drop policy if exists prep_components_read on prep_components;
create policy prep_components_read on prep_components for select
  using (exists (select 1 from ingredients p where p.id = prep_id and stock_can_read(p.restaurant_id)));
drop policy if exists prep_batches_read on prep_batches;
create policy prep_batches_read on prep_batches for select using (stock_can_read(restaurant_id));

-- ===== ใบรับของ ใบนับ yield test: อ่านได้ เขียนผ่านฟังก์ชัน =====
drop policy if exists stock_receipts_read on stock_receipts;
create policy stock_receipts_read on stock_receipts for select using (stock_can_read(restaurant_id));
drop policy if exists stock_receipt_lines_read on stock_receipt_lines;
create policy stock_receipt_lines_read on stock_receipt_lines for select
  using (exists (select 1 from stock_receipts r where r.id = receipt_id and stock_can_read(r.restaurant_id)));

drop policy if exists stock_counts_read on stock_counts;
create policy stock_counts_read on stock_counts for select using (stock_can_read(restaurant_id));
drop policy if exists stock_count_lines_read on stock_count_lines;
create policy stock_count_lines_read on stock_count_lines for select
  using (exists (select 1 from stock_counts c where c.id = count_id and stock_can_read(c.restaurant_id)));

alter table yield_tests enable row level security;
create policy yield_tests_read on yield_tests for select using (stock_can_read(restaurant_id));
revoke insert, update, delete on yield_tests from anon, authenticated;

-- ===== หน่วยนับ =====
drop policy if exists units_read on units;
drop policy if exists units_write on units;
create policy units_read on units for select using (stock_can_read(restaurant_id));
create policy units_write on units for all using (stock_can_write(restaurant_id)) with check (stock_can_write(restaurant_id));

drop policy if exists ingredient_units_read on ingredient_units;
drop policy if exists ingredient_units_write on ingredient_units;
create policy ingredient_units_read on ingredient_units for select
  using (exists (select 1 from ingredients i where i.id = ingredient_id and stock_can_read(i.restaurant_id)));
-- หน่วยแปลงต้องไม่ซ้ำกับหน่วยหลัก (เหมือน 0024)
create policy ingredient_units_write on ingredient_units for all
  using (exists (select 1 from ingredients i where i.id = ingredient_id and stock_can_write(i.restaurant_id)))
  with check (exists (select 1 from ingredients i where i.id = ingredient_id and stock_can_write(i.restaurant_id)
                      and lower(trim(i.unit)) <> lower(trim(unit_name))));

-- ===== ผู้จัดการทำงานสต็อกได้ครบ: ทวงของขาด และรายงานผู้ขาย (เหมือน 0025 ยกเว้นเพิ่ม manager) =====
create or replace function set_receipt_claim(p_receipt_id uuid, p_ingredient_id uuid, p_status text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rid uuid;
  v_expense uuid;
  v_invoice numeric;
begin
  select restaurant_id, expense_id, invoice_total into v_rid, v_expense, v_invoice from stock_receipts where id = p_receipt_id;
  if v_rid is null or not has_role(v_rid, array['owner', 'manager', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;
  if p_status not in ('pending', 'credited', 'accepted') then
    raise exception 'invalid_status';
  end if;
  update stock_receipt_lines set claim_status = p_status
   where receipt_id = p_receipt_id and ingredient_id = p_ingredient_id and claim_value > 0;
  if not found then
    raise exception 'not_found';
  end if;
  update stock_receipts
     set claim_total = (select coalesce(sum(claim_value), 0) from stock_receipt_lines where receipt_id = p_receipt_id and claim_status = 'pending')
   where id = p_receipt_id;
  if v_expense is not null then
    update expenses
       set amount = v_invoice - (select coalesce(sum(claim_value), 0) from stock_receipt_lines where receipt_id = p_receipt_id and claim_status = 'credited')
     where id = v_expense;
  end if;
end;
$$;
revoke execute on function set_receipt_claim(uuid, uuid, text) from public, anon;
grant execute on function set_receipt_claim(uuid, uuid, text) to authenticated;

create or replace function supplier_receiving_report(p_restaurant_id uuid, p_from date, p_to date)
returns table (
  supplier text,
  receipts bigint,
  lines bigint,
  invoice_value numeric,
  received_value numeric,
  claim_pending numeric,
  claim_credited numeric,
  claim_accepted numeric,
  gap_pct numeric,
  short_lines bigint,
  rejected_lines bigint,
  glaze_pct numeric,
  glaze_over_lines bigint,
  price_up_lines bigint
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_glaze numeric;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;
  select coalesce((select glaze_max_pct from shop_settings where restaurant_id = p_restaurant_id), 12) into v_glaze;

  return query
  select coalesce(r.supplier, 'ไม่ระบุผู้ขาย'),
         count(distinct r.id),
         count(*),
         round(sum(rl.invoice_qty * rl.unit_cost), 2),
         round(sum(rl.quantity * rl.unit_cost), 2),
         coalesce(sum(rl.claim_value) filter (where rl.claim_status = 'pending'), 0),
         coalesce(sum(rl.claim_value) filter (where rl.claim_status = 'credited'), 0),
         coalesce(sum(rl.claim_value) filter (where rl.claim_status = 'accepted'), 0),
         case when sum(rl.invoice_qty * rl.unit_cost) > 0
              then round(sum(rl.claim_value) / sum(rl.invoice_qty * rl.unit_cost) * 100, 2) end,
         count(*) filter (where rl.status = 'short'),
         count(*) filter (where rl.status = 'rejected'),
         case when sum(rl.gross_qty) filter (where rl.gross_qty > 0) > 0
              then round(sum(rl.gross_qty - rl.quantity) filter (where rl.gross_qty > 0)
                         / sum(rl.gross_qty) filter (where rl.gross_qty > 0) * 100, 2) end,
         count(*) filter (where rl.gross_qty > 0 and (rl.gross_qty - rl.quantity) / rl.gross_qty * 100 > v_glaze),
         count(*) filter (where rl.prev_unit_cost > 0 and rl.unit_cost > rl.prev_unit_cost * 1.1)
  from stock_receipts r
  join stock_receipt_lines rl on rl.receipt_id = r.id
  where r.restaurant_id = p_restaurant_id and r.received_on between p_from and p_to
  group by coalesce(r.supplier, 'ไม่ระบุผู้ขาย')
  order by 9 desc nulls last, 1;
end;
$$;
revoke execute on function supplier_receiving_report(uuid, date, date) from public, anon;
grant execute on function supplier_receiving_report(uuid, date, date) to authenticated;

