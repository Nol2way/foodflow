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
