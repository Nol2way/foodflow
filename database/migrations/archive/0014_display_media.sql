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
