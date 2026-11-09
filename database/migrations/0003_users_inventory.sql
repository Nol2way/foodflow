-- Plato — migration 0003: ผู้ใช้ (app_users) หลายบทบาท · ประวัติ/นับ/รับสต็อก · ขายตามน้ำหนัก · หน่วย
-- รวมจาก migration เดิม 0019–0025 (7 ไฟล์) ต่อกันตามลำดับเดิม เนื้อหาไม่เปลี่ยน
-- ไฟล์เดิมเก็บไว้ที่ migrations/archive/ (เลขในคอมเมนต์ด้านล่าง เช่น "0017" หมายถึงไฟล์เดิมเหล่านั้น)

-- ========================================================================
-- เดิม: 0019_stock_history.sql
-- ========================================================================

-- 0019: ประวัติสต็อก
--   - stock_movements เก็บเพิ่ม: ใครทำ (created_by) คงเหลือหลังรายการ (balance_after) ออเดอร์ที่ตัด (order_id) หมายเหตุ (note)
--   - stock_history(ร้าน, ช่วงเวลา, ตัวกรอง): รายการพร้อมชื่อวัตถุดิบ อีเมลคนทำ และโต๊ะของออเดอร์

-- ===== 1) คอลัมน์ใหม่ (รายการเก่าเป็นค่าว่าง) =====
alter table stock_movements add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table stock_movements add column if not exists balance_after numeric(12,3);
alter table stock_movements add column if not exists order_id uuid references orders(id) on delete set null;
alter table stock_movements add column if not exists note text check (char_length(note) <= 200);

create index if not exists stock_movements_restaurant_created_idx on stock_movements (restaurant_id, created_at desc);

drop trigger if exists stock_movements_apply on stock_movements;
create trigger stock_movements_apply before insert on stock_movements
  for each row execute function apply_stock_movement();

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

-- ========================================================================
-- เดิม: 0020_multi_roles.sql
-- ========================================================================

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

-- ========================================================================
-- เดิม: 0021_app_users.sql
-- ========================================================================

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

-- ========================================================================
-- เดิม: 0022_stock_counts.sql
-- ========================================================================

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

-- ========================================================================
-- เดิม: 0023_seafood_inventory.sql
-- ========================================================================

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

-- ========================================================================
-- เดิม: 0024_units.sql
-- ========================================================================

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

-- ========================================================================
-- เดิม: 0025_receiving_check.sql
-- ========================================================================

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
