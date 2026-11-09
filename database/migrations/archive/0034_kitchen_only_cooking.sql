-- Plato — migration 0034: ขั้นทำอาหารเป็นของครัวเท่านั้น
-- รันหลัง 0033_cancel_order_items.sql
--
-- เดิมพนักงานหน้าร้าน/เสิร์ฟ (staff) กด "เริ่มทำ" และ "ทำเสร็จ" บนจอครัวได้ ทำให้ครัวไม่รู้ว่าออเดอร์ถูกเลื่อนไปแล้ว
-- ตอนนี้แบ่งหน้าที่ชัดเจน
--   received  → preparing  (เริ่มทำ ตัดสต็อก)   : ครัว / เจ้าของ
--   preparing → ready      (ทำเสร็จ)            : ครัว / เจ้าของ
--   ติ๊กเสร็จรายเมนู (kitchen_set_item_done)    : ครัว / เจ้าของ
--   ready     → served     (เสิร์ฟแล้ว)          : หน้าร้าน / ครัว / เจ้าของ (เหมือนเดิม)
--   ยกเลิกออเดอร์ที่ครัวยังไม่เริ่ม               : หน้าร้าน / เจ้าของ (เหมือนเดิม)
-- พนักงานที่มีทั้งบทบาทหน้าร้านและครัว (0020) ยังทำได้ทุกขั้น

create or replace function enforce_order_status()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  v_owner boolean := has_role(old.restaurant_id, array['owner']);
  v_cook boolean := has_role(old.restaurant_id, array['owner', 'kitchen']);
  v_ok boolean;
begin
  -- ระบบภายใน (ไม่มีผู้ใช้ล็อกอิน เช่น service role / SQL Editor) ไม่ถูกบังคับ
  if auth.uid() is null then
    return new;
  end if;

  if new.status is distinct from old.status then
    if new.status::text in ('preparing', 'ready') and not v_cook then
      raise exception 'kitchen_only';
    end if;

    v_ok := case old.status::text
      when 'received'  then new.status::text in ('preparing', 'cancelled')
      when 'preparing' then new.status::text = 'ready' or (new.status::text = 'cancelled' and v_owner)
      when 'ready'     then new.status::text = 'served'
      when 'served'    then new.status::text = 'paid' or (new.status::text = 'cancelled' and v_owner)
      when 'paid'      then new.status::text = 'cancelled' and v_owner
      else false
    end;
    if not v_ok then
      raise exception 'invalid_status_change: % -> %', old.status, new.status;
    end if;

    if new.status = 'cancelled' then
      if old.status = 'paid' and coalesce(trim(new.cancel_reason), '') = '' then
        raise exception 'cancel_reason_required';
      end if;
      new.cancelled_at := now();
      new.cancelled_by := auth.uid();
      new.cancelled_from := old.status::text;
    end if;
  elsif new.cancel_reason is distinct from old.cancel_reason then
    raise exception 'cancel_reason_only_when_cancelling';
  end if;
  return new;
end;
$$;

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

  if v_rid is null or not has_role(v_rid, array['owner', 'kitchen']) then
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
