-- FoodFlow — migration 0005: นำเข้ายอดขายย้อนหลัง (CSV) + เสริมความปลอดภัยฟังก์ชัน
-- รันหลัง 0004_stock_costs_analytics.sql

-- ===== 1) นำเข้ายอดขายย้อนหลัง =====
alter table orders add column if not exists import_batch uuid;  -- รหัสรอบการนำเข้า ใช้ย้อนลบได้
create index if not exists orders_import_batch_idx on orders (import_batch) where import_batch is not null;

-- p_rows: [{line, ref, at, item, qty, price}]
--   at   = เวลาท้องถิ่นของร้าน 'YYYY-MM-DD HH:MM[:SS]' (แปลงตาม restaurants.timezone)
--   ref  = เลขที่ออเดอร์/บิล (ไม่บังคับ) แถวที่ ref เดียวกันในวันเดียวกันรวมเป็น 1 ออเดอร์
--          ref เดียวกันคนละวันถือเป็นคนละออเดอร์ (POS หลายตัวรีเซ็ตเลขบิลทุกวัน)
--   item = ชื่อเมนู ต้องตรงกับในระบบ (ไม่สนตัวพิมพ์เล็ก/ใหญ่) ไม่เดาชื่อที่ไม่รู้จัก
--   price = ราคาต่อหน่วย (ไม่บังคับ ถ้าไม่ใส่ใช้ราคาเมนูปัจจุบัน)
-- ออเดอร์ที่นำเข้า: สถานะ paid, ไม่ตัดสต็อก (ถือว่าเกิดขึ้นแล้ว), ไม่มีเวลาครัว (ไม่กระทบค่าเฉลี่ยเวลาทำอาหาร)
-- เมนูที่ไม่รู้จัก: ถ้าไม่ระบุ p_skip_unknown จะไม่นำเข้าอะไรเลย (blocked) แล้วรายงานรายชื่อกลับ
create or replace function import_sales_history(
  p_restaurant_id uuid,
  p_rows jsonb,
  p_dry_run boolean default false,
  p_skip_unknown boolean default false
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tz text;
  v_batch uuid := gen_random_uuid();
  v_unknown jsonb;
  v_unknown_rows int;
  v_lines int;
  v_orders int;
  v_blocked boolean := false;
begin
  if not has_role(p_restaurant_id, array['owner']) then
    raise exception 'forbidden';
  end if;
  if jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) = 0
     or jsonb_array_length(p_rows) > 20000 then
    raise exception 'invalid_rows';
  end if;
  select timezone into v_tz from restaurants where id = p_restaurant_id;

  drop table if exists import_stage;
  drop table if exists import_orders;

  create temp table import_stage on commit drop as
  select (r->>'line')::int as line,
         coalesce(nullif(trim(r->>'ref'), ''), 'line-' || (r->>'line'))
           || '|' || ((r->>'at')::timestamp)::date as group_key,
         (r->>'at')::timestamp as at_local,
         trim(r->>'item') as item,
         (r->>'qty')::int as qty,
         m.id as menu_item_id,
         coalesce(nullif(r->>'price', '')::numeric, m.price) as unit_price
  from jsonb_array_elements(p_rows) r
  left join lateral (
    select mi.id, mi.price from menu_items mi
    where mi.restaurant_id = p_restaurant_id
      and lower(mi.name) = lower(trim(r->>'item'))
    order by mi.id
    limit 1
  ) m on true;

  if exists (
    select 1 from import_stage
    where qty < 1 or qty > 1000
       or unit_price < 0
       or at_local < timestamp '2000-01-01'
       or at_local > (now() at time zone v_tz) + interval '1 day'
  ) then
    raise exception 'invalid_row';
  end if;

  select coalesce(jsonb_agg(distinct item), '[]'::jsonb), count(*)
    into v_unknown, v_unknown_rows
    from import_stage where menu_item_id is null;

  select count(*) into v_lines from import_stage where menu_item_id is not null;

  create temp table import_orders on commit drop as
  select group_key,
         gen_random_uuid() as order_id,
         min(at_local) as at_local,
         sum(qty * unit_price) as total
  from import_stage
  where menu_item_id is not null
  group by group_key;

  select count(*) into v_orders from import_orders;

  if v_unknown_rows > 0 and not p_skip_unknown then
    v_blocked := true;
  end if;

  if not p_dry_run and not v_blocked and v_orders > 0 then
    insert into orders (id, restaurant_id, status, total, created_at, paid_at, stock_deducted_at, import_batch)
    select o.order_id, p_restaurant_id, 'paid'::order_status, o.total,
           o.at_local at time zone v_tz,
           o.at_local at time zone v_tz,
           o.at_local at time zone v_tz,
           v_batch
    from import_orders o;

    insert into order_items (order_id, menu_item_id, quantity, unit_price)
    select o.order_id, s.menu_item_id, s.qty, s.unit_price
    from import_stage s
    join import_orders o on o.group_key = s.group_key
    where s.menu_item_id is not null;
  end if;

  return jsonb_build_object(
    'batch_id', case when p_dry_run or v_blocked or v_orders = 0 then null else v_batch end,
    'dry_run', p_dry_run,
    'blocked', v_blocked,
    'orders', v_orders,
    'lines', v_lines,
    'skipped_lines', v_unknown_rows,
    'unknown_items', v_unknown
  );
end;
$$;

revoke execute on function import_sales_history(uuid, jsonb, boolean, boolean) from public, anon;
grant execute on function import_sales_history(uuid, jsonb, boolean, boolean) to authenticated;

-- ===== 2) จัดการพนักงาน (ใช้ผ่าน backend เท่านั้น) =====
-- หา user id จากอีเมล และรายชื่อพนักงานพร้อมอีเมล ต้องอ่าน auth.users จึงให้เฉพาะ service_role
-- backend ตรวจว่าผู้เรียกเป็นเจ้าของร้านก่อนเรียกเสมอ
create or replace function staff_find_user(p_email text)
returns uuid
language sql stable security definer set search_path = public, auth, pg_temp as $$
  select id from auth.users where lower(email) = lower(trim(p_email)) limit 1;
$$;

create or replace function staff_list(p_restaurant_id uuid)
returns table (user_id uuid, email text, role text)
language sql stable security definer set search_path = public, auth, pg_temp as $$
  select s.user_id, u.email::text, s.role
  from staff_members s join auth.users u on u.id = s.user_id
  where s.restaurant_id = p_restaurant_id
  order by s.role, u.email;
$$;

revoke execute on function staff_find_user(text) from public, anon, authenticated;
revoke execute on function staff_list(uuid) from public, anon, authenticated;
grant execute on function staff_find_user(text) to service_role;
grant execute on function staff_list(uuid) to service_role;

-- กันร้านไม่มีเจ้าของ: ลบหรือเปลี่ยนบทบาทเจ้าของคนสุดท้ายไม่ได้
-- (ยกเว้นกำลังลบทั้งร้าน ซึ่งแถวร้านถูกลบไปก่อนแล้วตอน cascade)
create or replace function keep_last_owner()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner' or new.restaurant_id <> old.restaurant_id)
     and exists (select 1 from restaurants where id = old.restaurant_id)
     and not exists (
       select 1 from staff_members
       where restaurant_id = old.restaurant_id and role = 'owner' and user_id <> old.user_id
     ) then
    raise exception 'last_owner';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists staff_keep_last_owner on staff_members;
create trigger staff_keep_last_owner
  before update or delete on staff_members
  for each row execute function keep_last_owner();

-- ===== 3) backend (service role) เรียกสร้างออเดอร์ได้ =====
grant execute on function place_order(uuid, jsonb) to service_role;

-- ===== 4) search_path ของฟังก์ชัน security definer ทั้งหมด =====
-- ระบุ pg_temp ไว้ท้ายสุด กันตารางชั่วคราวที่ผู้เรียกสร้างมาบังตารางจริงในฟังก์ชัน
alter function is_staff_of(uuid) set search_path = public, pg_temp;
alter function has_role(uuid, text[]) set search_path = public, pg_temp;
alter function get_table_info(uuid) set search_path = public, pg_temp;
alter function place_order(uuid, jsonb) set search_path = public, pg_temp;
alter function get_order_status(uuid) set search_path = public, pg_temp;
alter function apply_stock_movement() set search_path = public, pg_temp;
alter function deduct_stock_for_order() set search_path = public, pg_temp;
alter function set_menu_availability(uuid, boolean) set search_path = public, pg_temp;
alter function analytics_hourly(uuid, int) set search_path = public, pg_temp;
alter function analytics_summary(uuid, int) set search_path = public, pg_temp;
alter function analytics_top_items(uuid, int) set search_path = public, pg_temp;
