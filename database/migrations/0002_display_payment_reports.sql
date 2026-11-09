-- Plato — migration 0002: จอแสดงผล iPad · ผู้จัดการ · ชำระเงินและสมาชิก · รายงาน
-- รวมจาก migration เดิม 0013–0018 (6 ไฟล์) ต่อกันตามลำดับเดิม เนื้อหาไม่เปลี่ยน
-- ไฟล์เดิมเก็บไว้ที่ migrations/archive/ (เลขในคอมเมนต์ด้านล่าง เช่น "0017" หมายถึงไฟล์เดิมเหล่านั้น)

-- ========================================================================
-- เดิม: 0013_display_magazine.sql
-- ========================================================================

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

-- ========================================================================
-- เดิม: 0014_display_media.sql
-- ========================================================================

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

revoke execute on function display_content(text) from public;
grant execute on function display_content(text) to anon, authenticated;

-- ========================================================================
-- เดิม: 0015_display_customize.sql
-- ========================================================================

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

-- ========================================================================
-- เดิม: 0016_manager_accounting.sql
-- ========================================================================

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

-- ========================================================================
-- เดิม: 0017_payment_loyalty.sql
-- ========================================================================

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

-- ========================================================================
-- เดิม: 0018_reports_insights.sql
-- ========================================================================

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
