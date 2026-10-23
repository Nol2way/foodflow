-- FoodFlow — migration 0004: ตัดสต็อกตามสูตรอาหาร · ต้นทุนต่อเมนู · วิเคราะห์ช่วงพีค/ออฟพีค
-- รันหลัง 0003_roles.sql

-- ===== 1) คอลัมน์ที่เพิ่ม =====
alter table restaurants add column if not exists timezone text not null default 'Asia/Bangkok';
alter table orders add column if not exists stock_deducted_at timestamptz;  -- กันตัดสต็อกซ้ำ
alter table orders add column if not exists is_demo boolean not null default false;  -- ข้อมูลทดลอง ลบได้: delete from orders where is_demo

-- ออเดอร์เก่าที่เลยขั้น "รับออเดอร์" ไปแล้ว ถือว่าไม่ต้องตัดสต็อกย้อนหลัง
update orders set stock_deducted_at = coalesce(started_at, created_at)
 where status <> 'received' and stock_deducted_at is null;

-- ===== 2) สูตรอาหาร: วัตถุดิบต้องเป็นของร้านเดียวกับเมนู =====
drop policy if exists recipes_write on recipes;
create policy recipes_write on recipes for all
  using (exists (
    select 1 from menu_items m
    where m.id = menu_item_id and has_role(m.restaurant_id, array['owner', 'stock'])
  ))
  with check (exists (
    select 1 from menu_items m
    join ingredients i on i.restaurant_id = m.restaurant_id
    where m.id = menu_item_id
      and i.id = ingredient_id
      and has_role(m.restaurant_id, array['owner', 'stock'])
  ));

-- ===== 3) ตัดสต็อกอัตโนมัติ =====
-- ตัดเมื่อออเดอร์เริ่มทำ (preparing) เป็นครั้งแรก ตามสูตร x จำนวนที่สั่ง
-- ถ้าสต็อกในระบบน้อยกว่าที่ต้องใช้ จะตัดเท่าที่มี (ไม่ขวางครัว เพราะอาหารถูกทำไปแล้วจริง)
-- เมนูที่ยังไม่มีสูตรจะไม่ตัดอะไร
create or replace function deduct_stock_for_order()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.stock_deducted_at is null
     and new.status in ('preparing', 'ready', 'served', 'paid') then
    insert into stock_movements (restaurant_id, ingredient_id, change, reason)
    select new.restaurant_id,
           r.ingredient_id,
           -least(sum(r.quantity_used * oi.quantity), i.quantity_on_hand),
           'sale'::stock_reason
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

drop trigger if exists orders_deduct_stock on orders;
create trigger orders_deduct_stock before update on orders
  for each row execute function deduct_stock_for_order();

-- ===== 4) ต้นทุนต่อเมนู (ใช้สิทธิ์ของผู้เรียก: เจ้าของ/บัญชีเห็นต้นทุนจริง) =====
create or replace view menu_item_costs with (security_invoker = true) as
select m.id as menu_item_id,
       m.restaurant_id,
       m.name,
       m.price,
       coalesce(sum(r.quantity_used * i.cost_per_unit), 0)::numeric(12,2) as unit_cost,
       count(r.ingredient_id) as ingredient_count
from menu_items m
left join recipes r on r.menu_item_id = m.id
left join ingredients i on i.id = r.ingredient_id
group by m.id;

grant select on menu_item_costs to authenticated;

-- ===== 5) วิเคราะห์ลูกค้า: เจ้าของและพนักงานบัญชีเท่านั้น =====
-- นับ "ความต้องการ" จากออเดอร์ที่ไม่ถูกยกเลิก ส่วนรายได้นับเฉพาะที่ชำระแล้ว
-- ไม่ใช้ข้อมูลส่วนบุคคลของลูกค้า (ลูกค้าไม่ต้องสมัครสมาชิก)

-- จำนวนออเดอร์แยกตาม วันในสัปดาห์ (0=อาทิตย์) x ชั่วโมง ตามเขตเวลาของร้าน
create or replace function analytics_hourly(p_restaurant_id uuid, p_days int default 28)
returns table (day_of_week int, hour_of_day int, order_count bigint, revenue_total numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  v_tz text;
begin
  if not has_role(p_restaurant_id, array['owner', 'accountant']) then
    raise exception 'forbidden';
  end if;
  select timezone into v_tz from restaurants where id = p_restaurant_id;

  return query
  select extract(dow from (o.created_at at time zone v_tz))::int,
         extract(hour from (o.created_at at time zone v_tz))::int,
         count(*)::bigint,
         coalesce(sum(o.total) filter (where o.status = 'paid'), 0)::numeric
  from orders o
  where o.restaurant_id = p_restaurant_id
    and o.status <> 'cancelled'
    and o.created_at >= now() - make_interval(days => least(greatest(p_days, 1), 120))
  group by 1, 2;
end;
$$;

create or replace function analytics_summary(p_restaurant_id uuid, p_days int default 28)
returns table (
  order_count bigint,
  revenue_total numeric,
  avg_bill numeric,
  avg_prep_minutes numeric,
  first_order_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'accountant']) then
    raise exception 'forbidden';
  end if;

  return query
  select count(*)::bigint,
         coalesce(sum(o.total) filter (where o.status = 'paid'), 0)::numeric,
         coalesce(avg(o.total) filter (where o.status = 'paid'), 0)::numeric,
         coalesce(avg(extract(epoch from (o.ready_at - o.started_at)) / 60)
                  filter (where o.ready_at is not null and o.started_at is not null), 0)::numeric,
         (select min(x.created_at) from orders x
           where x.restaurant_id = p_restaurant_id and x.status <> 'cancelled')
  from orders o
  where o.restaurant_id = p_restaurant_id
    and o.status <> 'cancelled'
    and o.created_at >= now() - make_interval(days => least(greatest(p_days, 1), 120));
end;
$$;

create or replace function analytics_top_items(p_restaurant_id uuid, p_days int default 28)
returns table (item_name text, quantity_sold bigint, revenue_total numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'accountant']) then
    raise exception 'forbidden';
  end if;

  return query
  select m.name,
         sum(oi.quantity)::bigint,
         sum(oi.quantity * oi.unit_price)::numeric
  from order_items oi
  join orders o on o.id = oi.order_id
  join menu_items m on m.id = oi.menu_item_id
  where o.restaurant_id = p_restaurant_id
    and o.status <> 'cancelled'
    and o.created_at >= now() - make_interval(days => least(greatest(p_days, 1), 120))
  group by m.id, m.name
  order by 2 desc
  limit 10;
end;
$$;

revoke execute on function analytics_hourly(uuid, int) from public;
revoke execute on function analytics_summary(uuid, int) from public;
revoke execute on function analytics_top_items(uuid, int) from public;
grant execute on function analytics_hourly(uuid, int) to authenticated;
grant execute on function analytics_summary(uuid, int) to authenticated;
grant execute on function analytics_top_items(uuid, int) to authenticated;
