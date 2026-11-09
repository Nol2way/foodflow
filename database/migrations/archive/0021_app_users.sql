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
