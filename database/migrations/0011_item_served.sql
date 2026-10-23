-- FoodFlow — migration 0011: ติ๊กเสิร์ฟแล้วทีละเมนู
-- รันหลัง 0010_kitchen_item_done.sql
--
-- ในออเดอร์ที่ "พร้อมเสิร์ฟ" พนักงานแตะแต่ละเมนูเมื่อยกไปเสิร์ฟแล้ว (แตะอีกครั้ง = ยกเลิกเครื่องหมาย)
-- เป็นตัวช่วยเหมือน 0010 สถานะของทั้งออเดอร์ยังเปลี่ยนด้วยปุ่ม "เสิร์ฟแล้ว" ตามเดิม
-- order_items ยังแก้ตรงไม่ได้ (0007) ต้องผ่านฟังก์ชัน set_item_served เท่านั้น

alter table order_items add column if not exists served_at timestamptz;

create or replace function set_item_served(p_item_id uuid, p_served boolean)
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
  if v_status <> 'ready' then
    raise exception 'order_not_ready';
  end if;

  update order_items
  set served_at = case when p_served then coalesce(served_at, now()) end
  where id = p_item_id;
end;
$$;

revoke execute on function set_item_served(uuid, boolean) from public, anon;
grant execute on function set_item_served(uuid, boolean) to authenticated;
