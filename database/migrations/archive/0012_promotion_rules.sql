-- FoodFlow — migration 0012: กฎวันที่ของโปร + จำกัดจำนวนครั้ง + ใช้หลายโปรพร้อมกัน + เลือกโปรตอนรับชำระ
-- รันหลัง 0011_item_served.sql (รันซ้ำได้)
--
-- 1) วันที่: ตั้งวันเริ่ม/วันสิ้นสุดย้อนหลังกว่าวันนี้ (เวลาร้าน) ไม่ได้ · วันสิ้นสุดต้องไม่ก่อนวันเริ่ม (มีตั้งแต่ 0009)
--    ตรวจเฉพาะตอนสร้าง หรือตอนแก้ค่าวันที่ (แก้ชื่อโปรเก่าที่เริ่มไปแล้วได้ตามปกติ)
-- 2) จำนวนครั้ง: max_uses (ว่าง = ไม่จำกัด) นับ 1 ครั้งต่อการใช้ 1 ครั้ง
--    (ตอนรับออเดอร์ = 1 ออเดอร์, ตอนรับชำระ = 1 บิลทั้งโต๊ะ) ออเดอร์ที่ถูกยกเลิกหมดแล้วคืนสิทธิ์ให้
-- 3) ใช้หลายโปรพร้อมกันได้ ถ้าเงื่อนไขไม่ทับกัน
--    - โปรรายเมนู: รวมกันได้ถ้าเมนูที่ร่วมโปรในบิลไม่ซ้ำกัน (เมนูเดียวลดได้โปรเดียว)
--    - โปรทั้งบิล: ใช้ได้ทีละ 1 โปร คิดจากยอดที่เหลือหลังหักโปรรายเมนูแล้ว
--    - ซื้อขั้นต่ำ: เทียบกับยอดก่อนลด
-- 4) หน้ารับชำระเลือกโปรให้ทั้งบิลได้ (counter_pay_bill) แทนที่โปรที่ใส่ไว้ตอนรับออเดอร์ของบิลนั้น
-- ส่วนลดของแต่ละโปรถูกกระจายลงแต่ละออเดอร์ (order_promotions) และรวมไว้ที่ orders.discount_total เหมือนเดิม

-- ===== 1) วันที่ =====
create or replace function enforce_promotion_dates()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  v_today date;
begin
  -- ระบบภายใน (service role / SQL Editor) ไม่ถูกบังคับ
  if auth.uid() is null then
    return new;
  end if;
  select (now() at time zone r.timezone)::date into v_today from restaurants r where r.id = new.restaurant_id;

  if new.starts_on is not null
     and (tg_op = 'INSERT' or new.starts_on is distinct from old.starts_on)
     and new.starts_on < v_today then
    raise exception 'promotion_start_in_past';
  end if;
  if new.ends_on is not null
     and (tg_op = 'INSERT' or new.ends_on is distinct from old.ends_on)
     and new.ends_on < v_today then
    raise exception 'promotion_end_in_past';
  end if;
  return new;
end;
$$;

drop trigger if exists promotions_enforce_dates on promotions;
create trigger promotions_enforce_dates
  before insert or update on promotions
  for each row execute function enforce_promotion_dates();

-- ===== 2) จำนวนครั้ง + การใช้โปรในออเดอร์ =====
alter table promotions add column if not exists max_uses int;
alter table promotions drop constraint if exists promotions_max_uses_check;
alter table promotions add constraint promotions_max_uses_check check (max_uses is null or max_uses between 1 and 1000000);

-- 1 แถว = ใช้โปร 1 ครั้ง (1 ออเดอร์ตอนรับออเดอร์ หรือ 1 บิลตอนรับชำระ)
create table if not exists promotion_uses (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references promotions(id),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  used_at timestamptz not null default now(),
  used_by uuid references auth.users(id) on delete set null
);
create index if not exists promotion_uses_promotion_idx on promotion_uses (promotion_id);

-- ส่วนลดของแต่ละโปรในแต่ละออเดอร์ (ออเดอร์หนึ่งมีได้หลายโปร)
create table if not exists order_promotions (
  order_id uuid not null references orders(id) on delete cascade,
  promotion_id uuid not null references promotions(id),
  promotion_use_id uuid not null references promotion_uses(id),
  discount numeric(10,2) not null check (discount >= 0),
  primary key (order_id, promotion_id)
);
create index if not exists order_promotions_use_idx on order_promotions (promotion_use_id);

alter table promotion_uses enable row level security;
alter table order_promotions enable row level security;
drop policy if exists promotion_uses_read on promotion_uses;
create policy promotion_uses_read on promotion_uses for select using (is_staff_of(restaurant_id));
drop policy if exists order_promotions_read on order_promotions;
create policy order_promotions_read on order_promotions for select
  using (exists (select 1 from orders o where o.id = order_id and is_staff_of(o.restaurant_id)));
revoke all on promotion_uses, order_promotions from anon;
revoke insert, update, delete on promotion_uses, order_promotions from authenticated;

-- จำนวนครั้งที่ใช้ไปแล้ว (นับเฉพาะการใช้ที่ยังมีออเดอร์ไม่ถูกยกเลิก)
create or replace function promotion_uses_count(p_promotion_id uuid)
returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::int from promotion_uses u
  where u.promotion_id = p_promotion_id
    and exists (select 1 from order_promotions op join orders o on o.id = op.order_id
                where op.promotion_use_id = u.id and o.status <> 'cancelled');
$$;
revoke execute on function promotion_uses_count(uuid) from public, anon;
grant execute on function promotion_uses_count(uuid) to authenticated;

-- จำนวนครั้งที่ใช้ของทุกโปรในร้าน (หน้าจัดการโปร)
create or replace function promotion_usage(p_restaurant_id uuid)
returns table (promotion_id uuid, used int)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.id, promotion_uses_count(p.id)
  from promotions p
  where p.restaurant_id = p_restaurant_id and is_staff_of(p_restaurant_id);
$$;
revoke execute on function promotion_usage(uuid) from public, anon;
grant execute on function promotion_usage(uuid) to authenticated;

-- ใช้ได้ตอนนี้ = เงื่อนไขเดิม + ยังไม่ครบจำนวนครั้ง
create or replace function promotion_is_live(p promotions)
returns boolean
language sql stable set search_path = public, pg_temp as $$
  with t as (
    select (now() at time zone r.timezone) as local_now
    from restaurants r where r.id = p.restaurant_id
  )
  select p.is_active
     and (p.starts_on is null or t.local_now::date >= p.starts_on)
     and (p.ends_on is null or t.local_now::date <= p.ends_on)
     and (p.days_of_week is null or cardinality(p.days_of_week) = 0
          or extract(dow from t.local_now)::smallint = any (p.days_of_week))
     and (p.start_time is null or t.local_now::time >= p.start_time)
     and (p.end_time is null or t.local_now::time < p.end_time)
     and (p.max_uses is null or promotion_uses_count(p.id) < p.max_uses)
  from t;
$$;

-- ===== 3) คำนวณและบันทึกโปรของกลุ่มออเดอร์ (ใช้ภายใน ไม่เปิดให้เรียกตรง) =====
-- แทนที่โปรเดิมของออเดอร์เหล่านี้ทั้งหมด (คืนสิทธิ์โปรเดิม) แล้วใช้ชุดโปรใหม่ · คืนค่าส่วนลดรวม
create or replace function apply_promotions(p_restaurant_id uuid, p_order_ids uuid[], p_promotion_ids uuid[])
returns numeric
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ids uuid[];
  v_prev uuid[];
  v_pid uuid;
  v_promo promotions%rowtype;
  v_subtotal numeric(10,2);
  v_bill_count int := 0;
  v_elig numeric(10,2);
  v_disc numeric(10,2);
  v_last uuid;
  v_use uuid;
  p record;
begin
  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(coalesce(p_promotion_ids, '{}')) x where x is not null;
  if cardinality(v_ids) > 10 then
    raise exception 'too_many_promotions';
  end if;

  -- โปรที่บิลนี้ได้ไปแล้วตอนรับออเดอร์ ยังใช้ต่อได้แม้หมดช่วงเวลา/ปิดไปแล้ว (ลูกค้าได้สิทธิ์ไปแล้ว)
  select coalesce(array_agg(distinct promotion_id), '{}') into v_prev from order_promotions where order_id = any (p_order_ids);

  -- ถอดโปรเดิม (คืนสิทธิ์) ก่อนตรวจว่าโปรที่เลือกยังใช้ได้
  delete from order_promotions where order_id = any (p_order_ids);
  update orders set promotion_id = null where id = any (p_order_ids);

  drop table if exists ap_orders;
  create temp table ap_orders on commit drop as
  select oi.order_id, sum(oi.quantity * oi.unit_price)::numeric(10,2) as subtotal
  from order_items oi where oi.order_id = any (p_order_ids) group by oi.order_id;
  select coalesce(sum(subtotal), 0) into v_subtotal from ap_orders;

  drop table if exists ap_lines;
  create temp table ap_lines on commit drop as
  select oi.order_id, oi.menu_item_id, (oi.quantity * oi.unit_price)::numeric(10,2) as amount, null::uuid as promo
  from order_items oi where oi.order_id = any (p_order_ids);

  drop table if exists ap_promos;
  create temp table ap_promos (promotion_id uuid, is_bill boolean, discount_type text, value numeric, eligible numeric(10,2), discount numeric(10,2)) on commit drop;
  drop table if exists ap_alloc;
  create temp table ap_alloc (order_id uuid, promotion_id uuid, base numeric(10,2), share numeric(10,2) not null default 0) on commit drop;

  -- ตรวจทุกโปร (ล็อกแถวโปร กันใช้ครั้งสุดท้ายพร้อมกันสองเครื่อง)
  for v_pid in select x from unnest(v_ids) x order by x loop
    select * into v_promo from promotions where id = v_pid and restaurant_id = p_restaurant_id for update;
    if not found or not (v_pid = any (v_prev) or promotion_is_live(v_promo)) then
      raise exception 'promotion_not_available';
    end if;
    if v_subtotal < v_promo.min_subtotal then
      raise exception 'promotion_min_subtotal: %', v_promo.min_subtotal;
    end if;

    if exists (select 1 from promotion_items pi where pi.promotion_id = v_pid) then
      -- โปรรายเมนู: เมนูในบิลที่ร่วมโปรนี้ต้องยังไม่ถูกโปรอื่นใช้
      if exists (select 1 from ap_lines l join promotion_items pi on pi.promotion_id = v_pid and pi.menu_item_id = l.menu_item_id
                 where l.promo is not null) then
        raise exception 'promotion_conflict';
      end if;
      update ap_lines l set promo = v_pid
       where exists (select 1 from promotion_items pi where pi.promotion_id = v_pid and pi.menu_item_id = l.menu_item_id);
      select coalesce(sum(amount), 0) into v_elig from ap_lines where promo = v_pid;
      if v_elig = 0 then
        raise exception 'promotion_no_eligible_items';
      end if;
      insert into ap_promos values (v_pid, false, v_promo.discount_type, v_promo.value, v_elig, null);
      insert into ap_alloc (order_id, promotion_id, base)
      select order_id, v_pid, sum(amount) from ap_lines where promo = v_pid group by order_id;
    else
      v_bill_count := v_bill_count + 1;
      if v_bill_count > 1 then
        raise exception 'promotion_conflict';
      end if;
      insert into ap_promos values (v_pid, true, v_promo.discount_type, v_promo.value, null, null);
    end if;
  end loop;

  -- คำนวณส่วนลด: รายเมนูก่อน แล้วโปรทั้งบิลจากยอดที่เหลือ · กระจายลงแต่ละออเดอร์ (ปัดลง เศษไปออเดอร์ฐานใหญ่สุด)
  for p in select * from ap_promos order by is_bill, promotion_id loop
    if p.is_bill then
      insert into ap_alloc (order_id, promotion_id, base)
      select o.order_id, p.promotion_id,
             o.subtotal - coalesce((select sum(a.share) from ap_alloc a where a.order_id = o.order_id), 0)
      from ap_orders o;
      select coalesce(sum(base), 0) into v_elig from ap_alloc where promotion_id = p.promotion_id;
      if v_elig <= 0 then
        raise exception 'promotion_no_eligible_items';
      end if;
    else
      v_elig := p.eligible;
    end if;

    v_disc := case p.discount_type
      when 'percent' then round(v_elig * p.value / 100, 2)
      else least(p.value, v_elig)
    end;
    update ap_promos set eligible = v_elig, discount = v_disc where promotion_id = p.promotion_id;

    select order_id into v_last from ap_alloc where promotion_id = p.promotion_id order by base desc, order_id limit 1;
    update ap_alloc set share = trunc(v_disc * base / v_elig, 2)
     where promotion_id = p.promotion_id and order_id <> v_last;
    update ap_alloc set share = least(base, v_disc - coalesce(
             (select sum(a.share) from ap_alloc a where a.promotion_id = p.promotion_id and a.order_id <> v_last), 0))
     where promotion_id = p.promotion_id and order_id = v_last;
  end loop;

  -- บันทึกการใช้ (1 ครั้งต่อโปร) และส่วนลดรายออเดอร์
  for p in select * from ap_promos loop
    insert into promotion_uses (promotion_id, restaurant_id, used_by)
    values (p.promotion_id, p_restaurant_id, auth.uid())
    returning id into v_use;
    insert into order_promotions (order_id, promotion_id, promotion_use_id, discount)
    select order_id, p.promotion_id, v_use, share from ap_alloc where promotion_id = p.promotion_id;
  end loop;

  update orders o
     set subtotal = x.subtotal,
         discount_total = coalesce(d.discount, 0),
         total = x.subtotal - coalesce(d.discount, 0),
         -- โปรหลักของออเดอร์ (ส่วนลดมากสุด) ไว้แสดงผลแบบเดิม
         promotion_id = (select op.promotion_id from order_promotions op where op.order_id = o.id
                         order by op.discount desc, op.promotion_id limit 1)
    from ap_orders x
    left join (select order_id, sum(share) as discount from ap_alloc group by order_id) d on d.order_id = x.order_id
   where o.id = x.order_id;

  return (select coalesce(sum(discount), 0) from ap_promos);
end;
$$;
revoke execute on function apply_promotions(uuid, uuid[], uuid[]) from public, anon, authenticated;

-- ===== รับออเดอร์ (เหมือน 0009 แต่รับได้หลายโปร) =====
drop function if exists staff_place_order(uuid, jsonb, uuid, text, text, text, uuid);
create or replace function staff_place_order(
  p_restaurant_id uuid,
  p_items jsonb,
  p_table_id uuid default null,
  p_order_type text default 'dine_in',
  p_customer_label text default null,
  p_note text default null,
  p_promotion_ids uuid[] default null
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order uuid;
  v_subtotal numeric(10,2) := 0;
  v_item jsonb;
  v_menu menu_items%rowtype;
  v_qty int;
begin
  if not has_role(p_restaurant_id, array['owner', 'staff']) then
    raise exception 'forbidden';
  end if;
  if p_order_type is null or p_order_type not in ('dine_in', 'takeaway') then
    raise exception 'invalid_order_type';
  end if;
  if p_order_type = 'dine_in' then
    if p_table_id is null
       or not exists (select 1 from dining_tables where id = p_table_id and restaurant_id = p_restaurant_id) then
      raise exception 'invalid_table';
    end if;
  else
    p_table_id := null;
  end if;
  if jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) = 0
     or jsonb_array_length(p_items) > 50 then
    raise exception 'invalid_items';
  end if;

  insert into orders (restaurant_id, table_id, order_type, customer_label, note, created_by)
  values (p_restaurant_id, p_table_id, p_order_type,
          nullif(left(trim(p_customer_label), 50), ''), nullif(left(trim(p_note), 200), ''), auth.uid())
  returning id into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::int;
    if v_qty is null or v_qty < 1 or v_qty > 50 then raise exception 'invalid_quantity'; end if;

    select * into v_menu from menu_items
      where id = (v_item->>'menu_item_id')::uuid and restaurant_id = p_restaurant_id;
    if not found then raise exception 'invalid_menu_item'; end if;
    if not v_menu.is_available then raise exception 'item_unavailable: %', v_menu.name; end if;

    insert into order_items (order_id, menu_item_id, quantity, unit_price, note)
    values (v_order, v_menu.id, v_qty, v_menu.price, nullif(left(trim(v_item->>'note'), 200), ''));

    v_subtotal := v_subtotal + v_menu.price * v_qty;
  end loop;

  update orders set subtotal = v_subtotal, discount_total = 0, total = v_subtotal where id = v_order;
  if coalesce(cardinality(p_promotion_ids), 0) > 0 then
    perform apply_promotions(p_restaurant_id, array[v_order], p_promotion_ids);
  end if;
  return v_order;
end;
$$;

revoke execute on function staff_place_order(uuid, jsonb, uuid, text, text, text, uuid[]) from public, anon;
grant execute on function staff_place_order(uuid, jsonb, uuid, text, text, text, uuid[]) to authenticated;

-- ===== 4) รับชำระทั้งบิล พร้อมเลือกโปร =====
-- p_order_ids = ออเดอร์ทั้งหมดในบิล (ต้องเสิร์ฟแล้วทุกใบ)
-- p_promotion_ids: ว่าง (null) = ใช้ส่วนลดเดิมจากตอนรับออเดอร์ · ระบุ = แทนที่ด้วยชุดนี้ทั้งบิล ({} = ไม่ใช้โปร)
drop function if exists counter_pay_bill(uuid, uuid[], uuid);
create or replace function counter_pay_bill(
  p_restaurant_id uuid,
  p_order_ids uuid[],
  p_promotion_ids uuid[] default null
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_count int;
begin
  if not has_role(p_restaurant_id, array['owner', 'staff']) then
    raise exception 'forbidden';
  end if;
  if p_order_ids is null or cardinality(p_order_ids) = 0 or cardinality(p_order_ids) > 50 then
    raise exception 'invalid_orders';
  end if;

  -- ล็อกออเดอร์ในบิล กันกดรับชำระซ้ำจากสองเครื่อง
  perform 1 from orders where id = any (p_order_ids) for update;
  select count(*) into v_count from orders
   where id = any (p_order_ids) and restaurant_id = p_restaurant_id and status = 'served';
  if v_count <> cardinality(p_order_ids) then
    raise exception 'bill_not_ready';
  end if;

  if p_promotion_ids is not null then
    perform apply_promotions(p_restaurant_id, p_order_ids, p_promotion_ids);
  end if;

  update orders set status = 'paid' where id = any (p_order_ids);

  return (
    select jsonb_build_object(
      'subtotal', coalesce(sum(coalesce(subtotal, total + discount_total)), 0),
      'discount', coalesce(sum(discount_total), 0),
      'total', coalesce(sum(total), 0)
    )
    from orders where id = any (p_order_ids)
  );
end;
$$;

revoke execute on function counter_pay_bill(uuid, uuid[], uuid[]) from public, anon;
grant execute on function counter_pay_bill(uuid, uuid[], uuid[]) to authenticated;
