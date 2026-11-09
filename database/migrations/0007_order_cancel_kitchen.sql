-- Plato — migration 0007: ยกเลิกบางเมนูในออเดอร์ · ขั้นทำอาหารเป็นของครัวเท่านั้น
-- รวมจาก migration เดิม 0033–0034 (2 ไฟล์) ต่อกันตามลำดับเดิม เนื้อหาไม่เปลี่ยน
-- ไฟล์เดิมเก็บไว้ที่ migrations/archive/ (เลขในคอมเมนต์ด้านล่าง เช่น "0017" หมายถึงไฟล์เดิมเหล่านั้น)

-- ========================================================================
-- เดิม: 0033_cancel_order_items.sql
-- ========================================================================

-- Plato — migration 0033: เลือกยกเลิกเฉพาะบางเมนูในออเดอร์
-- รันหลัง 0032_etda_typecode.sql
--
-- เดิมหน้าร้านยกเลิกได้ทั้งออเดอร์เท่านั้น ตอนนี้เลือกได้ว่าจะยกเลิกเมนูไหน กี่จาน
--   - ทำได้เฉพาะออเดอร์ที่ครัวยังไม่เริ่ม (received) เหมือนการยกเลิกทั้งออเดอร์ (0008)
--     สต็อกยังไม่ถูกตัดและยังไม่ลงบัญชี จึงไม่ต้องคืนสต็อกหรือกลับรายการบัญชี
--   - ยกเลิกครบทุกเมนู = ยกเลิกทั้งออเดอร์ (status = cancelled ผ่าน trigger เดิมทุกตัว)
--   - ยกเลิกบางส่วน: ลบแถว/ลดจำนวนใน order_items แล้วคิดยอดใหม่ · โปรเดิมใช้ต่อถ้ายังเข้าเงื่อนไข ไม่เข้าแล้วถอดออก
--   - ทุกรายการที่ยกเลิกบันทึกลง order_item_cancellations (ใคร เมื่อไร เหตุผล ราคา) ตรวจย้อนหลังได้
-- ไม่มีตารางใดอ้างอิง order_items.id จึงลบแถวได้โดยรายงาน/สต็อก/บัญชีเดิมไม่ต้องแก้

create table if not exists order_item_cancellations (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  menu_item_id uuid references menu_items(id) on delete set null,
  item_name text,
  quantity int not null check (quantity > 0),
  unit_price numeric(10,2) not null,
  weight_g numeric(10,1),
  note text,
  reason text check (char_length(reason) <= 200),
  cancelled_by uuid references app_users(id) on delete set null,
  cancelled_at timestamptz not null default now()
);
create index if not exists order_item_cancellations_order_idx on order_item_cancellations (order_id);
create index if not exists order_item_cancellations_rest_idx on order_item_cancellations (restaurant_id, cancelled_at);

alter table order_item_cancellations enable row level security;
drop policy if exists order_item_cancellations_read on order_item_cancellations;
create policy order_item_cancellations_read on order_item_cancellations for select
  using (has_role(restaurant_id, array['owner', 'staff', 'accountant']));
revoke all on order_item_cancellations from anon;
revoke insert, update, delete on order_item_cancellations from authenticated;
grant select on order_item_cancellations to authenticated;

-- p_items: [{ "id": order_items.id, "quantity": จำนวนที่ยกเลิก }] · quantity ว่างหรือเกินจำนวนจริง = ยกเลิกทั้งบรรทัด
-- คืนค่า true เมื่อยกเลิกครบทุกเมนู (ออเดอร์ถูกยกเลิกทั้งใบ)
create or replace function cancel_order_items(p_order_id uuid, p_items jsonb, p_reason text default null)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order orders%rowtype;
  v_reason text := nullif(left(trim(coalesce(p_reason, '')), 200), '');
  v_item jsonb;
  v_row order_items%rowtype;
  v_qty int;
  v_promos uuid[];
  v_subtotal numeric(10,2);
begin
  select * into v_order from orders where id = p_order_id for update;
  if not found or not has_role(v_order.restaurant_id, array['owner', 'staff']) then
    raise exception 'forbidden';
  end if;
  if v_order.status <> 'received' then
    raise exception 'order_already_started';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'invalid_items';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_row from order_items
      where id = (v_item->>'id')::uuid and order_id = p_order_id for update;
    if not found then raise exception 'invalid_item'; end if;

    v_qty := coalesce((v_item->>'quantity')::int, v_row.quantity);
    if v_qty < 1 then raise exception 'invalid_quantity'; end if;
    v_qty := least(v_qty, v_row.quantity);

    insert into order_item_cancellations
      (restaurant_id, order_id, menu_item_id, item_name, quantity, unit_price, weight_g, note, reason, cancelled_by)
    values (v_order.restaurant_id, p_order_id, v_row.menu_item_id,
            (select name from menu_items where id = v_row.menu_item_id),
            v_qty, v_row.unit_price, v_row.weight_g, v_row.note, v_reason, auth.uid());

    if v_qty >= v_row.quantity then
      delete from order_items where id = v_row.id;
    else
      update order_items set quantity = quantity - v_qty where id = v_row.id;
    end if;
  end loop;

  -- ไม่เหลือเมนูแล้ว: ยกเลิกทั้งออเดอร์ (คืนสิทธิ์โปรผ่านการนับ order_promotions ของออเดอร์ที่ไม่ถูกยกเลิก)
  if not exists (select 1 from order_items where order_id = p_order_id) then
    update orders set status = 'cancelled', cancel_reason = coalesce(v_reason, 'ยกเลิกทุกเมนู') where id = p_order_id;
    return true;
  end if;

  select sum(quantity * unit_price) into v_subtotal from order_items where order_id = p_order_id;
  select coalesce(array_agg(distinct promotion_id), '{}') into v_promos from order_promotions where order_id = p_order_id;

  update orders set subtotal = v_subtotal, discount_total = 0, total = v_subtotal where id = p_order_id;
  if cardinality(v_promos) > 0 then
    begin
      perform apply_promotions(v_order.restaurant_id, array[p_order_id], v_promos);
    exception when others then
      -- โปรไม่เข้าเงื่อนไขแล้ว (เช่น ยอดต่ำกว่าขั้นต่ำ หรือเมนูร่วมโปรถูกยกเลิก): ถอดโปรของออเดอร์นี้
      delete from order_promotions where order_id = p_order_id;
      update orders set promotion_id = null, subtotal = v_subtotal, discount_total = 0, total = v_subtotal
       where id = p_order_id;
    end;
  end if;
  return false;
end;
$$;

revoke execute on function cancel_order_items(uuid, jsonb, text) from public, anon;
grant execute on function cancel_order_items(uuid, jsonb, text) to authenticated;

-- ========================================================================
-- เดิม: 0034_kitchen_only_cooking.sql
-- ========================================================================

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
