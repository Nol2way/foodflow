-- FoodFlow — migration 0006: สรุปบัญชีคำนวณในฐานข้อมูล
-- รันหลัง 0005_import_and_hardening.sql
--
-- แก้ปัญหา: หน้าบัญชีเดิมดึงออเดอร์ทุกแถวมารวมยอดในเบราว์เซอร์ แต่ Supabase ส่งได้สูงสุด 1,000 แถวต่อครั้ง (max rows)
-- ร้านที่มีออเดอร์ชำระแล้วเกิน 1,000 รายการในช่วงที่เลือก ยอดรายรับ/กำไรจะต่ำกว่าจริงโดยไม่มีคำเตือน
-- และขอบเขต "วันนี้" ใช้เขตเวลาของเครื่องผู้ใช้ ไม่ใช่ของร้าน
-- ฟังก์ชันนี้รวมยอดในฐานข้อมูลตามเขตเวลาของร้าน (restaurants.timezone)

create or replace function accounting_summary(p_restaurant_id uuid, p_days int default 1)
returns table (
  from_date date,
  to_date date,
  revenue_total numeric,
  paid_orders bigint,
  expense_total numeric,
  expenses_by_category jsonb
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_tz text;
  v_to date;
  v_from date;
begin
  if not has_role(p_restaurant_id, array['owner', 'accountant']) then
    raise exception 'forbidden';
  end if;
  if p_days is null or p_days < 1 or p_days > 366 then
    raise exception 'invalid_days';
  end if;

  select timezone into v_tz from restaurants where id = p_restaurant_id;
  v_to := (now() at time zone v_tz)::date;
  v_from := v_to - (p_days - 1);

  return query
  select v_from,
         v_to,
         coalesce((select sum(o.total) from orders o
                   where o.restaurant_id = p_restaurant_id and o.status = 'paid'
                     and (o.paid_at at time zone v_tz)::date between v_from and v_to), 0)::numeric,
         (select count(*) from orders o
           where o.restaurant_id = p_restaurant_id and o.status = 'paid'
             and (o.paid_at at time zone v_tz)::date between v_from and v_to)::bigint,
         coalesce((select sum(e.amount) from expenses e
                   where e.restaurant_id = p_restaurant_id and e.spent_on between v_from and v_to), 0)::numeric,
         coalesce((select jsonb_object_agg(x.category, x.amount) from (
                     select e.category::text as category, sum(e.amount) as amount
                     from expenses e
                     where e.restaurant_id = p_restaurant_id and e.spent_on between v_from and v_to
                     group by e.category) x), '{}'::jsonb);
end;
$$;

revoke execute on function accounting_summary(uuid, int) from public, anon;
grant execute on function accounting_summary(uuid, int) to authenticated;
