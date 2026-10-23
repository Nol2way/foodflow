-- FoodFlow — migration 0008: บังคับลำดับสถานะออเดอร์
-- รันหลัง 0007_staff_ordering.sql
--
-- ปัญหาเดิม: policy ตรวจแค่ "ใครแก้ได้" ไม่ตรวจ "เปลี่ยนจากอะไรไปอะไร"
--   - หน้าร้านเปลี่ยนบิลที่ชำระแล้ว (paid) เป็นยกเลิกได้ → รายรับหายจากบัญชีโดยไม่มีร่องรอย
--   - ครัวย้อนสถานะได้ (served → received) และข้ามขั้นได้ (received → paid)
--
-- ลำดับที่อนุญาต
--   received  → preparing | cancelled
--   preparing → ready     | cancelled (เจ้าของเท่านั้น: ของถูกตัดสต็อกไปแล้ว)
--   ready     → served
--   served    → paid      | cancelled (เจ้าของเท่านั้น)
--   paid      → cancelled (เจ้าของเท่านั้น = ยกเลิกบิล ต้องระบุเหตุผล)
--   cancelled → (สถานะสุดท้าย)
-- ทุกการยกเลิกบันทึกผู้ยกเลิก เวลา และสถานะก่อนยกเลิก

alter table orders add column if not exists cancel_reason text;
alter table orders drop constraint if exists orders_cancel_reason_check;
alter table orders add constraint orders_cancel_reason_check check (char_length(cancel_reason) <= 200);
alter table orders add column if not exists cancelled_at timestamptz;
alter table orders add column if not exists cancelled_by uuid references auth.users(id) on delete set null;
alter table orders add column if not exists cancelled_from text;  -- สถานะก่อนยกเลิก (เช่น paid = ยกเลิกบิลที่ชำระแล้ว)

-- พนักงานแก้ได้เฉพาะสถานะและเหตุผลการยกเลิก
grant update (status, cancel_reason) on orders to authenticated;

create or replace function enforce_order_status()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  v_owner boolean := has_role(old.restaurant_id, array['owner']);
  v_ok boolean;
begin
  -- ระบบภายใน (ไม่มีผู้ใช้ล็อกอิน เช่น service role / SQL Editor) ไม่ถูกบังคับ
  if auth.uid() is null then
    return new;
  end if;

  if new.status is distinct from old.status then
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

drop trigger if exists orders_enforce_status on orders;
create trigger orders_enforce_status
  before update on orders
  for each row execute function enforce_order_status();
