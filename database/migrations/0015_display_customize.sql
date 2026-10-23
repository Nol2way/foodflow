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
