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
