-- 0016: ผู้จัดการดูบัญชีได้ (อ่านอย่างเดียว)
--   - เรียกสรุปบัญชี (accounting_summary) ได้
--   - เห็นรายการรายจ่าย แต่บันทึก/แก้/ลบรายจ่ายไม่ได้ (ยังเป็นสิทธิ์ของเจ้าของและพนักงานบัญชี)
--   - เห็นวัตถุดิบและสูตร (อ่านอย่างเดียว) เพื่อให้ตารางต้นทุนต่อเมนูในหน้าบัญชีคำนวณได้

drop policy if exists expenses_manager_read on expenses;
create policy expenses_manager_read on expenses for select
  using (has_role(restaurant_id, array['manager']));

drop policy if exists ingredients_manager_read on ingredients;
create policy ingredients_manager_read on ingredients for select
  using (has_role(restaurant_id, array['manager']));

drop policy if exists recipes_manager_read on recipes;
create policy recipes_manager_read on recipes for select
  using (exists (
    select 1 from menu_items m
    where m.id = menu_item_id and has_role(m.restaurant_id, array['manager'])
  ));

-- ===== สรุปบัญชี (แทนของ 0009: เพิ่ม manager) =====
create or replace function accounting_summary(p_restaurant_id uuid, p_days int default 1)
returns table (
  from_date date,
  to_date date,
  revenue_total numeric,
  paid_orders bigint,
  expense_total numeric,
  expenses_by_category jsonb,
  discount_total numeric
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_tz text;
  v_to date;
  v_from date;
begin
  if not has_role(p_restaurant_id, array['owner', 'accountant', 'manager']) then
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
                     group by e.category) x), '{}'::jsonb),
         coalesce((select sum(o.discount_total) from orders o
                   where o.restaurant_id = p_restaurant_id and o.status = 'paid'
                     and (o.paid_at at time zone v_tz)::date between v_from and v_to), 0)::numeric;
end;
$$;

revoke execute on function accounting_summary(uuid, int) from public, anon;
grant execute on function accounting_summary(uuid, int) to authenticated;
