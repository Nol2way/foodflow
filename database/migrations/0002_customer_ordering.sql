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
