-- 0019: ประวัติสต็อก
--   - stock_movements เก็บเพิ่ม: ใครทำ (created_by) คงเหลือหลังรายการ (balance_after) ออเดอร์ที่ตัด (order_id) หมายเหตุ (note)
--   - stock_history(ร้าน, ช่วงเวลา, ตัวกรอง): รายการพร้อมชื่อวัตถุดิบ อีเมลคนทำ และโต๊ะของออเดอร์

-- ===== 1) คอลัมน์ใหม่ (รายการเก่าเป็นค่าว่าง) =====
alter table stock_movements add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table stock_movements add column if not exists balance_after numeric(12,3);
alter table stock_movements add column if not exists order_id uuid references orders(id) on delete set null;
alter table stock_movements add column if not exists note text check (char_length(note) <= 200);

create index if not exists stock_movements_restaurant_created_idx on stock_movements (restaurant_id, created_at desc);

-- ===== 2) ปรับยอดก่อนบันทึก เพื่อเก็บคงเหลือหลังรายการไว้ในแถวเดียวกัน =====
-- คนทำมาจาก auth.uid() เสมอ (ปลอมไม่ได้) · ตัดจากออเดอร์ = คนที่กดเปลี่ยนสถานะ
create or replace function apply_stock_movement()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.created_by := auth.uid();
  update ingredients
     set quantity_on_hand = quantity_on_hand + new.change
   where id = new.ingredient_id
     and restaurant_id = new.restaurant_id
  returning quantity_on_hand into new.balance_after;
  if not found then
    raise exception 'invalid_ingredient';
  end if;
  return new;
end;
$$;

drop trigger if exists stock_movements_apply on stock_movements;
create trigger stock_movements_apply before insert on stock_movements
  for each row execute function apply_stock_movement();

-- ===== 3) ตัดสต็อกจากออเดอร์: จำว่ามาจากออเดอร์ไหน =====
create or replace function deduct_stock_for_order()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.stock_deducted_at is null
     and new.status in ('preparing', 'ready', 'served', 'paid') then
    insert into stock_movements (restaurant_id, ingredient_id, change, reason, order_id)
    select new.restaurant_id,
           r.ingredient_id,
           -least(sum(r.quantity_used * oi.quantity), i.quantity_on_hand),
           'sale'::stock_reason,
           new.id
    from order_items oi
    join recipes r on r.menu_item_id = oi.menu_item_id
    join ingredients i on i.id = r.ingredient_id and i.restaurant_id = new.restaurant_id
    where oi.order_id = new.id
    group by r.ingredient_id, i.quantity_on_hand
    having least(sum(r.quantity_used * oi.quantity), i.quantity_on_hand) > 0;

    new.stock_deducted_at := now();
  end if;
  return new;
end;
$$;

-- ===== 4) ดึงประวัติ: สิทธิ์เดียวกับการอ่าน stock_movements (เจ้าของ สต็อก บัญชี) =====
create or replace function stock_history(
  p_restaurant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_ingredient_id uuid default null,
  p_reason stock_reason default null,
  p_limit int default 200
)
returns table (
  id uuid,
  created_at timestamptz,
  ingredient_id uuid,
  ingredient_name text,
  unit text,
  change numeric,
  reason stock_reason,
  balance_after numeric,
  cost numeric,
  note text,
  actor_email text,
  order_id uuid,
  order_label text
)
language plpgsql stable security definer set search_path = public, auth, pg_temp as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;

  return query
  select sm.id, sm.created_at, sm.ingredient_id, i.name, i.unit, sm.change, sm.reason, sm.balance_after,
         round(abs(sm.change) * i.cost_per_unit, 2),
         sm.note, u.email::text, sm.order_id,
         case
           when o.id is null then null
           when o.order_type = 'takeaway' then coalesce('กลับบ้าน · ' || o.customer_label, 'กลับบ้าน')
           else coalesce(t.label, 'ไม่ระบุโต๊ะ')
         end
  from stock_movements sm
  join ingredients i on i.id = sm.ingredient_id
  left join auth.users u on u.id = sm.created_by
  left join orders o on o.id = sm.order_id
  left join dining_tables t on t.id = o.table_id
  where sm.restaurant_id = p_restaurant_id
    and sm.created_at >= p_from and sm.created_at < p_to
    and (p_ingredient_id is null or sm.ingredient_id = p_ingredient_id)
    and (p_reason is null or sm.reason = p_reason)
  order by sm.created_at desc, sm.id
  limit least(greatest(p_limit, 1), 1000);
end;
$$;

revoke execute on function stock_history(uuid, timestamptz, timestamptz, uuid, stock_reason, int) from public, anon;
grant execute on function stock_history(uuid, timestamptz, timestamptz, uuid, stock_reason, int) to authenticated;
