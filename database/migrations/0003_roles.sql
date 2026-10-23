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
