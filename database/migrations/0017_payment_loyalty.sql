-- 0017: รับชำระด้วย QR พร้อมเพย์ + ใบเสร็จ + สะสมแต้มสมาชิก
--   - shop_settings: พร้อมเพย์ ข้อความหัว/ท้ายใบเสร็จ กติกาแต้ม (ปิดแต้มได้ทั้งระบบด้วย loyalty_enabled)
--   - members + point_ledger: สมาชิกระบุด้วยเบอร์โทร แต้มเปลี่ยนผ่านฟังก์ชันเท่านั้น มีประวัติทุกครั้ง
--   - counter_pay_bill: เพิ่มวิธีชำระ สมาชิก และแลกแต้ม (คิดหลังหักโปรแล้ว)
--   - ยกเลิกบิลที่ชำระแล้ว: คืนแต้มที่แลกไป และหักแต้มที่ได้จากบิลนั้น

-- ===== 1) ตั้งค่าร้าน =====
create table if not exists shop_settings (
  restaurant_id uuid primary key references restaurants(id) on delete cascade,
  promptpay_id text check (promptpay_id ~ '^([0-9]{10}|[0-9]{13}|[0-9]{15})$'),  -- เบอร์มือถือ / เลขบัตร ปชช. หรือเลขผู้เสียภาษี / e-Wallet
  receipt_header text check (char_length(receipt_header) <= 300),  -- ที่อยู่ เบอร์โทร เลขผู้เสียภาษี
  receipt_footer text check (char_length(receipt_footer) <= 200),  -- เช่น ขอบคุณที่ใช้บริการ
  loyalty_enabled boolean not null default false,
  loyalty_baht_per_point int not null default 10 check (loyalty_baht_per_point between 1 and 10000),  -- จ่ายครบกี่บาทได้ 1 แต้ม
  loyalty_point_value numeric(10,2) not null default 1 check (loyalty_point_value > 0 and loyalty_point_value <= 1000),  -- 1 แต้มลดได้กี่บาท
  loyalty_min_redeem int not null default 10 check (loyalty_min_redeem between 1 and 100000),  -- แลกขั้นต่ำกี่แต้ม
  line_to text check (line_to ~ '^[UCR][0-9a-f]{32}$'),  -- ผู้รับรายงานรายวันทาง LINE (userId / groupId / roomId)
  updated_at timestamptz not null default now()
);
alter table shop_settings enable row level security;
drop policy if exists shop_settings_read on shop_settings;
create policy shop_settings_read on shop_settings for select using (is_staff_of(restaurant_id));
drop policy if exists shop_settings_write on shop_settings;
create policy shop_settings_write on shop_settings for all
  using (has_role(restaurant_id, array['owner']))
  with check (has_role(restaurant_id, array['owner']));

-- ===== 2) สมาชิกและแต้ม =====
create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  phone text not null check (phone ~ '^0[0-9]{8,9}$'),
  name text check (char_length(name) <= 60),
  points int not null default 0 check (points >= 0),
  created_at timestamptz not null default now(),
  unique (restaurant_id, phone)
);
create table if not exists point_ledger (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  change int not null,
  reason text not null check (reason in ('earn', 'redeem', 'reverse', 'adjust')),
  order_ids uuid[],
  note text check (char_length(note) <= 200),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists point_ledger_member_idx on point_ledger (member_id, created_at);

alter table members enable row level security;
alter table point_ledger enable row level security;
drop policy if exists members_read on members;
create policy members_read on members for select using (has_role(restaurant_id, array['owner', 'manager', 'staff']));
drop policy if exists members_insert on members;
create policy members_insert on members for insert
  with check (has_role(restaurant_id, array['owner', 'manager', 'staff']) and points = 0);
drop policy if exists members_update on members;
create policy members_update on members for update
  using (has_role(restaurant_id, array['owner', 'manager', 'staff']))
  with check (has_role(restaurant_id, array['owner', 'manager', 'staff']));
drop policy if exists members_delete on members;
create policy members_delete on members for delete using (has_role(restaurant_id, array['owner']));
-- แก้ได้แค่ชื่อ แต้มต้องเปลี่ยนผ่านการรับชำระ/ปรับแต้มเท่านั้น
revoke update on members from authenticated;
grant update (name) on members to authenticated;

drop policy if exists point_ledger_read on point_ledger;
create policy point_ledger_read on point_ledger for select using (has_role(restaurant_id, array['owner', 'manager', 'staff']));
revoke insert, update, delete on point_ledger from anon, authenticated;

-- ปรับแต้มเอง (เช่น ชดเชยลูกค้า) เจ้าของ/ผู้จัดการ ต้องระบุเหตุผล
create or replace function member_adjust_points(p_member_id uuid, p_change int, p_note text)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rid uuid;
  v_points int;
begin
  select restaurant_id into v_rid from members where id = p_member_id for update;
  if v_rid is null or not has_role(v_rid, array['owner', 'manager']) then
    raise exception 'forbidden';
  end if;
  if p_change = 0 or abs(p_change) > 100000 then
    raise exception 'invalid_points';
  end if;
  if coalesce(trim(p_note), '') = '' then
    raise exception 'note_required';
  end if;
  update members set points = points + p_change where id = p_member_id returning points into v_points;  -- ติดลบไม่ได้ (check)
  insert into point_ledger (restaurant_id, member_id, change, reason, note, created_by)
  values (v_rid, p_member_id, p_change, 'adjust', left(trim(p_note), 200), auth.uid());
  return v_points;
end;
$$;
revoke execute on function member_adjust_points(uuid, int, text) from public, anon;
grant execute on function member_adjust_points(uuid, int, text) to authenticated;

-- ===== 3) ข้อมูลการชำระในออเดอร์ =====
alter table orders add column if not exists payment_method text check (payment_method in ('cash', 'promptpay', 'card', 'other'));
alter table orders add column if not exists member_id uuid references members(id) on delete set null;
alter table orders add column if not exists points_earned int not null default 0 check (points_earned >= 0);
alter table orders add column if not exists points_redeemed int not null default 0 check (points_redeemed >= 0);
alter table orders add column if not exists points_discount numeric(10,2) not null default 0 check (points_discount >= 0);

-- ===== 4) รับชำระ (แทนของ 0012) =====
drop function if exists counter_pay_bill(uuid, uuid[], uuid[]);
create or replace function counter_pay_bill(
  p_restaurant_id uuid,
  p_order_ids uuid[],
  p_promotion_ids uuid[] default null,
  p_payment_method text default 'cash',
  p_member_id uuid default null,
  p_redeem_points int default 0
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_count int;
  v_set shop_settings%rowtype;
  v_member members%rowtype;
  v_total numeric(10,2);
  v_disc numeric(10,2) := 0;
  v_earned int := 0;
  v_left numeric(10,2);
  v_share numeric(10,2);
  o record;
  v_i int := 0;
  v_n int;
begin
  if not has_role(p_restaurant_id, array['owner', 'staff']) then
    raise exception 'forbidden';
  end if;
  if p_order_ids is null or cardinality(p_order_ids) = 0 or cardinality(p_order_ids) > 50 then
    raise exception 'invalid_orders';
  end if;
  if coalesce(p_payment_method, '') not in ('cash', 'promptpay', 'card', 'other') then
    raise exception 'invalid_payment_method';
  end if;
  if p_redeem_points is null or p_redeem_points < 0 then
    raise exception 'invalid_points';
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

  -- ===== แต้มสมาชิก =====
  select * into v_set from shop_settings where restaurant_id = p_restaurant_id;
  if p_member_id is not null then
    if not coalesce(v_set.loyalty_enabled, false) then
      raise exception 'loyalty_disabled';
    end if;
    select * into v_member from members where id = p_member_id and restaurant_id = p_restaurant_id for update;
    if v_member.id is null then
      raise exception 'member_not_found';
    end if;
  elsif p_redeem_points > 0 then
    raise exception 'member_required';
  end if;

  select coalesce(sum(total), 0) into v_total from orders where id = any (p_order_ids);

  if p_redeem_points > 0 then
    if p_redeem_points > v_member.points then
      raise exception 'not_enough_points';
    end if;
    if p_redeem_points < v_set.loyalty_min_redeem then
      raise exception 'below_min_redeem';
    end if;
    v_disc := round(p_redeem_points * v_set.loyalty_point_value, 2);
    if v_disc > v_total then
      raise exception 'redeem_exceeds_total';
    end if;
    -- แบ่งส่วนลดจากแต้มตามยอดแต่ละออเดอร์ เศษไปที่ออเดอร์สุดท้าย
    v_left := v_disc;
    v_n := cardinality(p_order_ids);
    for o in select id, total from orders where id = any (p_order_ids) order by total, id loop
      v_i := v_i + 1;
      v_share := case when v_i = v_n then v_left
                      when v_total = 0 then 0
                      else least(o.total, trunc(v_disc * o.total / v_total, 2)) end;
      v_left := v_left - v_share;
      update orders set total = total - v_share,
                        discount_total = coalesce(discount_total, 0) + v_share,
                        points_discount = v_share
       where id = o.id;
    end loop;
    v_total := v_total - v_disc;
    update members set points = points - p_redeem_points where id = p_member_id;
    insert into point_ledger (restaurant_id, member_id, change, reason, order_ids, created_by)
    values (p_restaurant_id, p_member_id, -p_redeem_points, 'redeem', p_order_ids, auth.uid());
  end if;

  if p_member_id is not null then
    v_earned := floor(v_total / v_set.loyalty_baht_per_point);
    if v_earned > 0 then
      update members set points = points + v_earned where id = p_member_id;
      insert into point_ledger (restaurant_id, member_id, change, reason, order_ids, created_by)
      values (p_restaurant_id, p_member_id, v_earned, 'earn', p_order_ids, auth.uid());
    end if;
    -- บันทึกแต้มไว้ที่ออเดอร์ที่ยอดมากที่สุด (ใช้ตอนยกเลิกบิล)
    update orders set member_id = p_member_id where id = any (p_order_ids);
    update orders set points_earned = v_earned, points_redeemed = p_redeem_points
     where id = (select id from orders where id = any (p_order_ids) order by total desc, id limit 1);
  end if;

  update orders set status = 'paid', payment_method = p_payment_method where id = any (p_order_ids);

  return (
    select jsonb_build_object(
      'subtotal', coalesce(sum(coalesce(subtotal, total + discount_total)), 0),
      'discount', coalesce(sum(discount_total), 0),
      'points_discount', coalesce(sum(points_discount), 0),
      'total', coalesce(sum(total), 0),
      'points_earned', v_earned,
      'points_redeemed', p_redeem_points,
      'member_points', (select points from members where id = p_member_id)
    )
    from orders where id = any (p_order_ids)
  );
end;
$$;
revoke execute on function counter_pay_bill(uuid, uuid[], uuid[], text, uuid, int) from public, anon;
grant execute on function counter_pay_bill(uuid, uuid[], uuid[], text, uuid, int) to authenticated;

-- ===== 5) ยกเลิกบิลที่ชำระแล้ว: คืน/หักแต้ม =====
create or replace function reverse_order_points()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_change int;
begin
  if new.status = 'cancelled' and old.status = 'paid' and old.member_id is not null
     and (old.points_earned > 0 or old.points_redeemed > 0) then
    v_change := old.points_redeemed - old.points_earned;
    -- แต้มที่ได้ไปถ้าใช้หมดแล้ว หักได้ไม่เกินที่มี (ไม่ให้ติดลบ)
    update members set points = greatest(0, points + v_change) where id = old.member_id;
    insert into point_ledger (restaurant_id, member_id, change, reason, order_ids, note, created_by)
    values (old.restaurant_id, old.member_id, v_change, 'reverse', array[old.id], 'ยกเลิกบิล', auth.uid());
    new.points_earned := 0;
    new.points_redeemed := 0;
  end if;
  return new;
end;
$$;
drop trigger if exists orders_reverse_points on orders;
create trigger orders_reverse_points
  before update of status on orders
  for each row execute function reverse_order_points();

-- ===== 6) ข้อมูลใบเสร็จ =====
-- รวมออเดอร์ในบิลเดียว: รายการอาหาร โปร แต้ม วิธีชำระ (พนักงานหน้าร้าน/เจ้าของ/บัญชี)
create or replace function bill_receipt(p_order_ids uuid[])
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_rid uuid;
begin
  if p_order_ids is null or cardinality(p_order_ids) = 0 or cardinality(p_order_ids) > 50 then
    raise exception 'invalid_orders';
  end if;
  select min(restaurant_id::text)::uuid into v_rid from orders where id = any (p_order_ids);
  if v_rid is null or not has_role(v_rid, array['owner', 'staff', 'accountant'])
     or exists (select 1 from orders where id = any (p_order_ids) and restaurant_id <> v_rid) then
    raise exception 'forbidden';
  end if;

  return jsonb_build_object(
    'restaurant', (select name from restaurants where id = v_rid),
    'header', (select receipt_header from shop_settings where restaurant_id = v_rid),
    'footer', (select receipt_footer from shop_settings where restaurant_id = v_rid),
    'paid_at', (select max(paid_at) from orders where id = any (p_order_ids)),
    'payment_method', (select max(payment_method) from orders where id = any (p_order_ids)),
    'table', (select string_agg(distinct t.label, ', ') from orders o join dining_tables t on t.id = o.table_id where o.id = any (p_order_ids)),
    'bill_no', upper(left(replace((select min(id::text) from orders where id = any (p_order_ids)), '-', ''), 8)),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('name', x.name, 'quantity', x.qty, 'unit_price', x.unit_price, 'amount', x.amount) order by x.name)
      from (
        select m.name, oi.unit_price, sum(oi.quantity) as qty, sum(oi.quantity * oi.unit_price) as amount
        from order_items oi join menu_items m on m.id = oi.menu_item_id
        where oi.order_id = any (p_order_ids)
        group by m.name, oi.unit_price
      ) x
    ), '[]'::jsonb),
    'promotions', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.name, 'discount', d.discount) order by p.name)
      from (select promotion_id, sum(discount) as discount from order_promotions where order_id = any (p_order_ids) group by promotion_id) d
      join promotions p on p.id = d.promotion_id
    ), '[]'::jsonb),
    'subtotal', (select coalesce(sum(coalesce(subtotal, total + discount_total)), 0) from orders where id = any (p_order_ids)),
    'points_discount', (select coalesce(sum(points_discount), 0) from orders where id = any (p_order_ids)),
    'total', (select coalesce(sum(total), 0) from orders where id = any (p_order_ids)),
    'member', (
      select jsonb_build_object('phone', '***' || right(m.phone, 4), 'points', m.points,
                                'earned', (select sum(points_earned) from orders where id = any (p_order_ids)),
                                'redeemed', (select sum(points_redeemed) from orders where id = any (p_order_ids)))
      from members m where m.id = (select min(member_id::text)::uuid from orders where id = any (p_order_ids))
    )
  );
end;
$$;
revoke execute on function bill_receipt(uuid[]) from public, anon;
grant execute on function bill_receipt(uuid[]) to authenticated;
