-- FoodFlow — migration 0010: ครัวติ๊กเสร็จทีละเมนู
-- รันหลัง 0009_manager_promotions.sql
--
-- ในออเดอร์ที่ "กำลังทำ" ครัวแตะแต่ละเมนูเพื่อทำเครื่องหมายว่าเสร็จแล้ว (แตะอีกครั้ง = ยกเลิกเครื่องหมาย)
-- ใช้เป็นตัวช่วยของครัวเท่านั้น สถานะของทั้งออเดอร์ยังเปลี่ยนด้วยปุ่ม "ทำเสร็จ" ตามเดิม
-- order_items ยังแก้ตรงไม่ได้ (0007) ต้องผ่านฟังก์ชัน kitchen_set_item_done เท่านั้น

alter table order_items add column if not exists done_at timestamptz;

create or replace function kitchen_set_item_done(p_item_id uuid, p_done boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rid uuid;
  v_status order_status;
begin
  select o.restaurant_id, o.status into v_rid, v_status
  from order_items i join orders o on o.id = i.order_id
  where i.id = p_item_id;

  if v_rid is null or not has_role(v_rid, array['owner', 'staff', 'kitchen']) then
    raise exception 'forbidden';
  end if;
  if v_status <> 'preparing' then
    raise exception 'order_not_preparing';
  end if;

  update order_items
  set done_at = case when p_done then coalesce(done_at, now()) end
  where id = p_item_id;
end;
$$;

revoke execute on function kitchen_set_item_done(uuid, boolean) from public, anon;
grant execute on function kitchen_set_item_done(uuid, boolean) to authenticated;

-- เปิด Realtime ให้ order_items (ครัวหลายเครื่องเห็นเครื่องหมายเสร็จตรงกันทันที)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'order_items'
  ) then
    alter publication supabase_realtime add table order_items;
  end if;
end;
$$;
