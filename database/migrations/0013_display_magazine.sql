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
