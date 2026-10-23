-- 0018: รายงานสรุปรายวัน (ส่ง LINE ได้) + ข้อมูลสำหรับแนะนำโปร (AI)
--   - daily_report(ร้าน, วันที่): ยอดขาย ส่วนลด เมนูขายดี ช่วงพีค ของเสีย รายจ่าย แต้มสมาชิก
--   - daily_report_targets(): ร้านที่ตั้งผู้รับ LINE ไว้ (ให้ backend ส่งอัตโนมัติทุกสิ้นวัน)
--   - promo_insights(ร้าน, จำนวนวัน): ยอดตามชั่วโมง + ยอดขาย/กำไรต่อเมนู ใช้คิดโปรที่ควรทำ

-- ===== 1) รายงานรายวัน =====
-- ใช้ภายใน (ไม่ตรวจสิทธิ์) · เรียกตรงได้เฉพาะ service role
create or replace function daily_report_data(p_restaurant_id uuid, p_date date)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_tz text;
  v_from timestamptz;
  v_to timestamptz;
  v_prev_from timestamptz;
begin
  select timezone into v_tz from restaurants where id = p_restaurant_id;
  if v_tz is null then
    return null;
  end if;
  v_from := p_date::timestamp at time zone v_tz;
  v_to := (p_date + 1)::timestamp at time zone v_tz;
  v_prev_from := (p_date - 7)::timestamp at time zone v_tz;  -- วันเดียวกันของสัปดาห์ก่อน

  return jsonb_build_object(
    'restaurant', (select name from restaurants where id = p_restaurant_id),
    'date', p_date,
    'orders', (select count(*) from orders where restaurant_id = p_restaurant_id and status = 'paid'
                and created_at >= v_from and created_at < v_to),
    'revenue', (select coalesce(sum(total), 0) from orders where restaurant_id = p_restaurant_id and status = 'paid'
                and created_at >= v_from and created_at < v_to),
    'discount', (select coalesce(sum(discount_total), 0) from orders where restaurant_id = p_restaurant_id and status = 'paid'
                and created_at >= v_from and created_at < v_to),
    'revenue_last_week', (select coalesce(sum(total), 0) from orders where restaurant_id = p_restaurant_id and status = 'paid'
                and created_at >= v_prev_from and created_at < v_prev_from + interval '1 day'),
    'cancelled', (select count(*) from orders where restaurant_id = p_restaurant_id and status = 'cancelled'
                and created_at >= v_from and created_at < v_to),
    'payments', coalesce((
      select jsonb_object_agg(coalesce(payment_method, 'unknown'), amount)
      from (select payment_method, sum(total) as amount from orders
            where restaurant_id = p_restaurant_id and status = 'paid' and created_at >= v_from and created_at < v_to
            group by payment_method) x
    ), '{}'::jsonb),
    'top_items', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'quantity', qty, 'amount', amount) order by qty desc, name)
      from (
        select m.name, sum(oi.quantity) as qty, sum(oi.quantity * oi.unit_price) as amount
        from order_items oi
        join orders o on o.id = oi.order_id
        join menu_items m on m.id = oi.menu_item_id
        where o.restaurant_id = p_restaurant_id and o.status = 'paid' and o.created_at >= v_from and o.created_at < v_to
        group by m.name
        order by qty desc, m.name
        limit 5
      ) t
    ), '[]'::jsonb),
    'peak_hour', (
      select extract(hour from created_at at time zone v_tz)::int
      from orders
      where restaurant_id = p_restaurant_id and status <> 'cancelled' and created_at >= v_from and created_at < v_to
      group by 1 order by count(*) desc, 1 limit 1
    ),
    'waste', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'quantity', qty, 'unit', unit, 'cost', cost) order by cost desc, name)
      from (
        select i.name, i.unit, sum(-sm.change) as qty, round(sum(-sm.change * i.cost_per_unit), 2) as cost
        from stock_movements sm join ingredients i on i.id = sm.ingredient_id
        where sm.restaurant_id = p_restaurant_id and sm.reason = 'waste'
          and sm.created_at >= v_from and sm.created_at < v_to
        group by i.name, i.unit
      ) w
    ), '[]'::jsonb),
    'expenses', (select coalesce(sum(amount), 0) from expenses where restaurant_id = p_restaurant_id and spent_on = p_date),
    'new_members', (select count(*) from members where restaurant_id = p_restaurant_id and created_at >= v_from and created_at < v_to),
    'points_earned', (select coalesce(sum(change), 0) from point_ledger where restaurant_id = p_restaurant_id and reason = 'earn'
                      and created_at >= v_from and created_at < v_to),
    'points_redeemed', (select coalesce(-sum(change), 0) from point_ledger where restaurant_id = p_restaurant_id and reason = 'redeem'
                      and created_at >= v_from and created_at < v_to)
  );
end;
$$;
revoke execute on function daily_report_data(uuid, date) from public, anon, authenticated;
grant execute on function daily_report_data(uuid, date) to service_role;

-- เรียกจากหน้าเว็บ: เจ้าของ ผู้จัดการ บัญชี
create or replace function daily_report(p_restaurant_id uuid, p_date date default null)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_date date := p_date;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'accountant']) then
    raise exception 'forbidden';
  end if;
  if v_date is null then
    select (now() at time zone timezone)::date into v_date from restaurants where id = p_restaurant_id;
  end if;
  return daily_report_data(p_restaurant_id, v_date);
end;
$$;
revoke execute on function daily_report(uuid, date) from public, anon;
grant execute on function daily_report(uuid, date) to authenticated;

-- ร้านที่ตั้งผู้รับ LINE + วันที่ปัจจุบันตามเวลาร้าน (backend ใช้ส่งรายงานอัตโนมัติ)
create or replace function daily_report_targets()
returns table (restaurant_id uuid, line_to text, local_date date, local_hour int)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.restaurant_id, s.line_to, (now() at time zone r.timezone)::date, extract(hour from now() at time zone r.timezone)::int
  from shop_settings s join restaurants r on r.id = s.restaurant_id
  where s.line_to is not null;
$$;
revoke execute on function daily_report_targets() from public, anon, authenticated;
grant execute on function daily_report_targets() to service_role;

-- ===== 2) ข้อมูลสำหรับแนะนำโปร =====
-- ไม่มีข้อมูลส่วนบุคคล: แค่ยอดตามชั่วโมงและยอด/ต้นทุนต่อเมนู
create or replace function promo_insights(p_restaurant_id uuid, p_days int default 28)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_tz text;
  v_days int := least(greatest(coalesce(p_days, 28), 7), 120);
  v_from timestamptz;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'accountant']) then
    raise exception 'forbidden';
  end if;
  select timezone into v_tz from restaurants where id = p_restaurant_id;
  v_from := now() - make_interval(days => v_days);

  return jsonb_build_object(
    'days', v_days,
    'hours', coalesce((
      select jsonb_agg(jsonb_build_object('hour', h, 'orders_per_day', round(n::numeric / v_days, 2), 'revenue', rev) order by h)
      from (
        select extract(hour from created_at at time zone v_tz)::int as h, count(*) as n,
               coalesce(sum(total) filter (where status = 'paid'), 0) as rev
        from orders
        where restaurant_id = p_restaurant_id and status <> 'cancelled' and created_at >= v_from
        group by 1
      ) x
    ), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'name', m.name, 'price', m.price, 'unit_cost', c.unit_cost,
               'has_recipe', c.ingredient_count > 0, 'quantity', coalesce(s.qty, 0), 'revenue', coalesce(s.amount, 0),
               'is_available', m.is_available)
             order by coalesce(s.qty, 0) desc, m.name)
      from menu_items m
      join menu_item_costs c on c.menu_item_id = m.id
      left join (
        select oi.menu_item_id, sum(oi.quantity) as qty, sum(oi.quantity * oi.unit_price) as amount
        from order_items oi join orders o on o.id = oi.order_id
        where o.restaurant_id = p_restaurant_id and o.status <> 'cancelled' and o.created_at >= v_from
        group by oi.menu_item_id
      ) s on s.menu_item_id = m.id
      where m.restaurant_id = p_restaurant_id
    ), '[]'::jsonb),
    'active_promotions', coalesce((
      select jsonb_agg(p.name order by p.name) from promotions p where p.restaurant_id = p_restaurant_id and p.is_active
    ), '[]'::jsonb)
  );
end;
$$;
revoke execute on function promo_insights(uuid, int) from public, anon;
grant execute on function promo_insights(uuid, int) to authenticated;
