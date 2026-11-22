-- Audit remediation. Existing tokens are intentionally invalidated on deployment.
alter table app_users add column credential_version bigint not null default 0;
create or replace function app_session_valid(p_user_id uuid, p_credential_version bigint, p_password_change boolean default false)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from app_users where id=p_user_id and is_active
 and credential_version=p_credential_version and (p_password_change or not must_change_password));
$$;
revoke all on function app_session_valid(uuid,bigint,boolean) from public,anon,authenticated;
grant execute on function app_session_valid(uuid,bigint,boolean) to service_role;
create or replace function app_session_current() returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from app_users where id=auth.uid() and is_active and not must_change_password
 and credential_version::text = (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'credential_version')
 and coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'scope','') <> 'password_change');
$$;
revoke all on function app_session_current() from public,anon;
grant execute on function app_session_current() to authenticated;
create or replace function app_logout(p_user_id uuid) returns void
language sql security definer set search_path=public,pg_temp as $$
 update app_users set credential_version=credential_version+1 where id=p_user_id;
$$;
revoke all on function app_logout(uuid) from public,anon,authenticated;
grant execute on function app_logout(uuid) to service_role;
create or replace function app_disable_revokes() returns trigger language plpgsql as $$
begin
 if new.is_active is distinct from old.is_active then new.credential_version:=old.credential_version+1; end if;
 return new;
end; $$;
create trigger app_disable_revokes before update on app_users for each row execute function app_disable_revokes();


create or replace function is_staff_of(rid uuid) returns boolean
language sql stable security definer as $$
  select app_session_current() and exists (
    select 1 from staff_members
    where user_id = auth.uid() and restaurant_id = rid
  );
$$;

create or replace function has_role(rid uuid, roles text[])
returns boolean
language sql stable security definer set search_path = public as $$
  select app_session_current() and exists (
    select 1 from staff_members
    where user_id = auth.uid()
      and restaurant_id = rid
      and role = any(roles)
  );
$$;

drop policy staff_read_self on staff_members; create policy staff_read_self on staff_members for select using(user_id=auth.uid() and app_session_current());

drop function app_login(text,text);

create or replace function app_login(p_email text, p_password text)
returns table (id uuid, email text, display_name text, must_change_password boolean, credential_version bigint)
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  u app_users;
begin
  select * into u from app_users a where a.email = lower(trim(p_email));
  if u.id is null or u.password_hash is null or not u.is_active
     or u.password_hash <> crypt(coalesce(p_password, ''), u.password_hash) then
    return;
  end if;
  update app_users set last_login_at = now() where app_users.id = u.id;
  return query select u.id, u.email, u.display_name, u.must_change_password, u.credential_version;
end;
$$;

revoke all on function app_login(text,text) from public,anon,authenticated; grant execute on function app_login(text,text) to service_role;

create or replace function app_set_password(p_user_id uuid, p_password text, p_must_change boolean default false)
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  if char_length(coalesce(p_password, '')) < 8 or octet_length(p_password) > 72 then
    raise exception 'weak_password';
  end if;
  update app_users
     set password_hash = crypt(p_password, gen_salt('bf', 10)),
         must_change_password = p_must_change, credential_version = credential_version + 1
   where id = p_user_id;
  if not found then
    raise exception 'not_found';
  end if;
end;
$$;

drop function app_update_profile(uuid,text,text);

create or replace function app_update_profile(p_user_id uuid, p_display_name text, p_phone text, p_set_display_name boolean default true, p_set_phone boolean default true)
returns void
language sql security definer set search_path = public, pg_temp as $$
  update app_users
     set display_name = case when p_set_display_name then nullif(trim(p_display_name),'') else display_name end,
         phone = case when p_set_phone then nullif(trim(p_phone),'') else phone end
   where id = p_user_id;
$$;

revoke all on function app_update_profile(uuid,text,text,boolean,boolean) from public,anon,authenticated; grant execute on function app_update_profile(uuid,text,text,boolean,boolean) to service_role;

create or replace function staff_is_senior(p_restaurant_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select has_role(p_restaurant_id,array['owner','manager']) and exists (
    select 1 from staff_members
    where restaurant_id = p_restaurant_id and user_id = p_user_id and role in ('owner', 'manager')
  );
$$;

create or replace function promotion_uses_count(p_promotion_id uuid)
returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::int from promotion_uses u
  where u.promotion_id = p_promotion_id and is_staff_of(u.restaurant_id)
    and exists (select 1 from order_promotions op join orders o on o.id = op.order_id
                where op.promotion_use_id = u.id and o.status <> 'cancelled');
$$;

create or replace function keep_last_owner()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform 1 from restaurants where id=old.restaurant_id for update;
  if old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner' or new.restaurant_id <> old.restaurant_id or new.user_id <> old.user_id)
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

create schema if not exists private;
revoke all on schema private from public,anon,authenticated;
create table private.payment_authorizations(tx bigint not null, order_id uuid not null, primary key(tx,order_id));
create or replace function payment_authorized(p_order_id uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from private.payment_authorizations where tx=txid_current() and order_id=p_order_id);
$$;
revoke all on function payment_authorized(uuid) from public,anon;
grant execute on function payment_authorized(uuid) to authenticated;


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

  if new.status = 'paid' and old.status <> 'paid' and not payment_authorized(old.id) then
    raise exception 'payment_required';
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

drop function counter_pay_bill(uuid,uuid[],uuid[],text,uuid,int);

create or replace function counter_pay_bill(
  p_restaurant_id uuid,
  p_order_ids uuid[],
  p_promotion_ids uuid[] default null,
  p_payment_method text default 'cash',
  p_member_id uuid default null,
  p_redeem_points int default 0,
  p_expected_total numeric default null
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
  v_remaining numeric;
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
    v_remaining := v_total;
    v_n := cardinality(p_order_ids);
    for o in select id, total from orders where id = any (p_order_ids) order by total, id loop
      v_i := v_i + 1;
      v_share := case when v_i = v_n then v_left
                      when v_remaining = 0 then 0
                      else least(o.total, round(v_left * o.total / v_remaining, 2)) end;
      v_share := least(o.total, greatest(0,v_share));
      v_left := v_left - v_share;
      v_remaining := v_remaining - o.total;
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

  if p_expected_total is null then raise exception 'quote_required'; end if;
  if p_expected_total <> v_total then raise exception 'quote_changed'; end if;
  insert into private.payment_authorizations select txid_current(), unnest(p_order_ids);
  update orders set status = 'paid', payment_method = p_payment_method where id = any (p_order_ids);

  delete from private.payment_authorizations where tx=txid_current();
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

revoke all on function counter_pay_bill(uuid,uuid[],uuid[],text,uuid,int,numeric) from public,anon; grant execute on function counter_pay_bill(uuid,uuid[],uuid[],text,uuid,int,numeric) to authenticated;

create or replace function reverse_order_points()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_change int;
  v_balance int;
begin
  if new.status = 'cancelled' and old.status = 'paid' and old.member_id is not null
     and (old.points_earned > 0 or old.points_redeemed > 0) then
    select points into v_balance from members where id=old.member_id for update;
    v_change := greatest(-v_balance, old.points_redeemed - old.points_earned);
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
  -- Remove only promotions made ineligible by the remaining items. Unexpected failures abort.
  select coalesce(array_agg(p.id),'{}') into v_promos from promotions p
  where p.id=any(v_promos) and p.min_subtotal <= v_subtotal
  and (not exists(select 1 from promotion_items pi where pi.promotion_id=p.id)
    or exists(select 1 from promotion_items pi join order_items oi on oi.menu_item_id=pi.menu_item_id
      where pi.promotion_id=p.id and oi.order_id=p_order_id));
  perform apply_promotions(v_order.restaurant_id,array[p_order_id],v_promos);
  return false;
end;
$$;

alter table orders add constraint orders_money_nonnegative check(total>=0 and coalesce(discount_total,0)>=0 and coalesce(points_discount,0)>=0) not valid;

-- Liveness also runs inside token-authorized display RPCs without a staff JWT.
-- Count using the invoking SQL privileges (and RLS for direct callers), while the
-- exposed promotion_uses_count helper remains explicitly tenant guarded.
create or replace function promotion_is_live(p promotions) returns boolean
language sql stable set search_path=public,pg_temp as $$
 with t as(select now() at time zone timezone as local_now from restaurants where id=p.restaurant_id)
 select p.is_active
 and (p.starts_on is null or t.local_now::date>=p.starts_on)
 and (p.ends_on is null or t.local_now::date<=p.ends_on)
 and (p.days_of_week is null or cardinality(p.days_of_week)=0 or extract(dow from t.local_now)::smallint=any(p.days_of_week))
 and (p.start_time is null or t.local_now::time>=p.start_time)
 and (p.end_time is null or t.local_now::time<p.end_time)
 and (p.max_uses is null or (select count(*) from promotion_uses u where u.promotion_id=p.id
   and exists(select 1 from order_promotions op join orders o on o.id=op.order_id where op.promotion_use_id=u.id and o.status<>'cancelled'))<p.max_uses)
 from t;
$$;

-- Verify the old credential and epoch under the same lock as the password write.
create function app_change_password(p_user_id uuid,p_current_password text,p_new_password text,p_credential_version bigint)
returns bigint language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare u app_users; new_version bigint;
begin
 select * into u from app_users where id=p_user_id for update;
 if not found or not u.is_active or u.credential_version<>p_credential_version or p_credential_version is null then raise exception 'stale_session'; end if;
 if u.password_hash is null or u.password_hash<>crypt(coalesce(p_current_password,''),u.password_hash) then raise exception 'invalid_credentials'; end if;
 if char_length(coalesce(p_new_password,''))<8 or octet_length(p_new_password)>72 then raise exception 'weak_password'; end if;
 if p_new_password=p_current_password then raise exception 'same_password'; end if;
 update app_users set password_hash=crypt(p_new_password,gen_salt('bf',10)),must_change_password=false,credential_version=credential_version+1 where id=p_user_id returning credential_version into new_version;
 return new_version;
end; $$;
revoke all on function app_change_password(uuid,text,text,bigint) from public,anon,authenticated;
grant execute on function app_change_password(uuid,text,text,bigint) to service_role;

create table private.import_receipts(restaurant_id uuid not null references restaurants(id), source_key text not null, result jsonb not null, primary key(restaurant_id,source_key));

drop function import_sales_history(uuid,jsonb,boolean,boolean);

create or replace function import_sales_history(
  p_restaurant_id uuid,
  p_rows jsonb,
  p_dry_run boolean default false,
  p_skip_unknown boolean default false, p_preview_token text default null
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tz text;
  v_key text := md5(p_rows::text || p_skip_unknown::text);
  v_preview text;
  v_result jsonb;
  v_batch uuid := gen_random_uuid();
  v_unknown jsonb;
  v_unknown_rows int;
  v_lines int;
  v_orders int;
  v_blocked boolean := false;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager']) then
    raise exception 'forbidden';
  end if;
  if jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) = 0
     or jsonb_array_length(p_rows) > 20000 then
    raise exception 'invalid_rows';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_restaurant_id::text || v_key,0));
  select result into v_result from private.import_receipts where restaurant_id=p_restaurant_id and source_key=v_key;
  if found and exists(select 1 from orders where import_batch=(v_result->>'batch_id')::uuid) then return v_result || jsonb_build_object('duplicate',true,'dry_run',p_dry_run); end if;
  delete from private.import_receipts where restaurant_id=p_restaurant_id and source_key=v_key;
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

  select md5(coalesce(jsonb_agg(to_jsonb(s) order by line)::text,'')) into v_preview from import_stage s;
  if not p_dry_run and (p_preview_token is null or p_preview_token <> v_preview) then raise exception 'preview_changed'; end if;
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

  v_result := jsonb_build_object(
    'preview_token', v_preview, 'duplicate', false,
    'batch_id', case when p_dry_run or v_blocked or v_orders = 0 then null else v_batch end,
    'dry_run', p_dry_run,
    'blocked', v_blocked,
    'orders', v_orders,
    'lines', v_lines,
    'skipped_lines', v_unknown_rows,
    'unknown_items', v_unknown
  );
  if not p_dry_run and not v_blocked and v_orders>0 then insert into private.import_receipts values(p_restaurant_id,v_key,v_result); end if;
  return v_result;
end;
$$;

revoke all on function import_sales_history(uuid,jsonb,boolean,boolean,text) from public,anon; grant execute on function import_sales_history(uuid,jsonb,boolean,boolean,text) to authenticated;

create function acct_journal_export(p_restaurant_id uuid,p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
 if not has_role(p_restaurant_id,array['owner','manager','accountant']) then raise exception 'forbidden'; end if;
 if (select count(*) from journal_lines jl join journal_entries e on e.id=jl.entry_id where e.restaurant_id=p_restaurant_id and e.entry_date between p_from and p_to)>200000 then raise exception 'export_too_large'; end if;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (  select e.id as entry_id, e.entry_no, e.entry_date, e.source_type, e.source_id, e.memo, e.reason, e.reverses_entry_id, e.created_at,
         coalesce(u.display_name, u.email) as created_by_name, jl.id as line_id, jl.account_id, a.code as account_code, a.name as account_name, jl.debit, jl.credit, jl.memo as line_memo
  from journal_entries e
  join journal_lines jl on jl.entry_id = e.id
  join accounts a on a.id = jl.account_id
  left join app_users u on u.id = e.created_by
  where e.restaurant_id = p_restaurant_id and e.entry_date between p_from and p_to
  order by e.entry_date, e.entry_no, jl.id) x;
 return result;
end; $$;
revoke all on function acct_journal_export(uuid,date,date) from public,anon;
grant execute on function acct_journal_export(uuid,date,date) to authenticated;


create table private.auth_buckets(key text primary key, expires_at timestamptz not null, hits int not null);
create function app_auth_allow(p_key text,p_limit int,p_window_seconds int default 60) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare n int;
begin
 if length(p_key)>200 or p_limit<1 or p_window_seconds not between 1 and 86400 then raise exception 'invalid_limit'; end if;
 -- Serialize capacity admission too; never evict an active bucket to admit attacker-controlled keys.
 perform pg_advisory_xact_lock(917342);
 delete from private.auth_buckets where expires_at<=clock_timestamp();
 if not exists(select 1 from private.auth_buckets where key=p_key) and (select count(*) from private.auth_buckets)>=100000 then return false; end if;
 insert into private.auth_buckets values(p_key,clock_timestamp()+make_interval(secs=>p_window_seconds),1)
 on conflict(key) do update set hits=least(private.auth_buckets.hits+1,p_limit+1) returning hits into n;
 return n<=p_limit;
end; $$;
revoke all on function app_auth_allow(text,int,int) from public,anon,authenticated;
grant execute on function app_auth_allow(text,int,int) to service_role;


create function save_promotion(p_restaurant_id uuid,p_promotion_id uuid,p_values jsonb,p_item_ids uuid[]) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare p promotions; v_id uuid;
begin
 if not has_role(p_restaurant_id,array['owner','manager']) then raise exception 'forbidden'; end if;
 if exists(select 1 from unnest(p_item_ids) x where not exists(select 1 from menu_items where id=x and restaurant_id=p_restaurant_id)) then raise exception 'invalid_items'; end if;
 select * into p from jsonb_populate_record(null::promotions,p_values);
 if p_promotion_id is null then
  insert into promotions(restaurant_id,name,discount_type,value,min_subtotal,starts_on,ends_on,days_of_week,start_time,end_time,max_uses)
  values(p_restaurant_id,p.name,p.discount_type,p.value,coalesce(p.min_subtotal,0),p.starts_on,p.ends_on,p.days_of_week,p.start_time,p.end_time,p.max_uses) returning id into v_id;
 else
  update promotions set name=p.name,discount_type=p.discount_type,value=p.value,min_subtotal=coalesce(p.min_subtotal,0),starts_on=p.starts_on,ends_on=p.ends_on,days_of_week=p.days_of_week,start_time=p.start_time,end_time=p.end_time,max_uses=p.max_uses
  where id=p_promotion_id and restaurant_id=p_restaurant_id returning id into v_id;
  if v_id is null then raise exception 'not_found'; end if;
 end if;
 delete from promotion_items where promotion_id=v_id;
 insert into promotion_items(promotion_id,menu_item_id) select v_id,x from (select distinct unnest(p_item_ids) x) t;
 return v_id;
end; $$;
revoke all on function save_promotion(uuid,uuid,jsonb,uuid[]) from public,anon;
grant execute on function save_promotion(uuid,uuid,jsonb,uuid[]) to authenticated;


drop function daily_report_targets();

create or replace function daily_report_targets(p_scheduled_at timestamptz default now())
returns table (restaurant_id uuid, line_to text, local_date date, local_hour int)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.restaurant_id, s.line_to, (p_scheduled_at at time zone r.timezone)::date, extract(hour from p_scheduled_at at time zone r.timezone)::int
  from shop_settings s join restaurants r on r.id = s.restaurant_id
  where s.line_to is not null;
$$;

revoke all on function daily_report_targets(timestamptz) from public,anon,authenticated; grant execute on function daily_report_targets(timestamptz) to service_role;

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
  v_prev_from := (p_date - 7)::timestamp at time zone v_tz;

  return jsonb_build_object(
    'restaurant', (select name from restaurants where id = p_restaurant_id),
    'date', p_date,
    'orders', (select count(*) from orders where restaurant_id = p_restaurant_id and status = 'paid'
                and paid_at >= v_from and paid_at < v_to),
    'revenue', (select coalesce(sum(total), 0) from orders where restaurant_id = p_restaurant_id and status = 'paid'
                and paid_at >= v_from and paid_at < v_to),
    'discount', (select coalesce(sum(discount_total), 0) from orders where restaurant_id = p_restaurant_id and status = 'paid'
                and paid_at >= v_from and paid_at < v_to),
    'revenue_last_week', (select coalesce(sum(total), 0) from orders where restaurant_id = p_restaurant_id and status = 'paid'
                and paid_at >= v_prev_from and paid_at < v_prev_from + interval '1 day'),
    'cancelled', (select count(*) from orders where restaurant_id = p_restaurant_id and status = 'cancelled'
                and created_at >= v_from and created_at < v_to),
    'payments', coalesce((
      select jsonb_object_agg(coalesce(payment_method, 'unknown'), amount)
      from (select payment_method, sum(total) as amount from orders
            where restaurant_id = p_restaurant_id and status = 'paid' and paid_at >= v_from and paid_at < v_to
            group by payment_method) x
    ), '{}'::jsonb),
    'top_items', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'quantity', qty, 'amount', amount) order by qty desc, name)
      from (
        select m.name, sum(oi.quantity) as qty, sum(oi.quantity * oi.unit_price) as amount
        from order_items oi
        join orders o on o.id = oi.order_id
        join menu_items m on m.id = oi.menu_item_id
        where o.restaurant_id = p_restaurant_id and o.status = 'paid' and o.paid_at >= v_from and o.paid_at < v_to
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
    'expenses', (select coalesce(sum(amount), 0) from expenses where restaurant_id = p_restaurant_id and voided_at is null and spent_on = p_date),
    'new_members', (select count(*) from members where restaurant_id = p_restaurant_id and created_at >= v_from and created_at < v_to),
    'points_earned', (select coalesce(sum(change), 0) from point_ledger where restaurant_id = p_restaurant_id and reason = 'earn'
                      and created_at >= v_from and created_at < v_to),
    'points_redeemed', (select coalesce(-sum(change), 0) from point_ledger where restaurant_id = p_restaurant_id and reason = 'redeem'
                      and created_at >= v_from and created_at < v_to)
  );
end;
$$;

create table private.report_dispatches(restaurant_id uuid not null references restaurants(id),report_date date not null,retry_key uuid not null default gen_random_uuid(),claimed_at timestamptz,sent_at timestamptz,primary key(restaurant_id,report_date));
create function report_dispatch_claim(p_restaurant_id uuid,p_report_date date) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare d private.report_dispatches;
begin
 insert into private.report_dispatches(restaurant_id,report_date) values(p_restaurant_id,p_report_date) on conflict do nothing;
 select * into d from private.report_dispatches where restaurant_id=p_restaurant_id and report_date=p_report_date for update;
 if d.sent_at is not null or d.claimed_at>clock_timestamp()-interval '5 minutes' then return null; end if;
 update private.report_dispatches set claimed_at=clock_timestamp() where restaurant_id=p_restaurant_id and report_date=p_report_date;
 return d.retry_key;
end; $$;
create function report_dispatch_finish(p_restaurant_id uuid,p_report_date date,p_success boolean) returns void
language sql security definer set search_path=public,pg_temp as $$
 update private.report_dispatches set claimed_at=null,sent_at=case when p_success then clock_timestamp() else sent_at end where restaurant_id=p_restaurant_id and report_date=p_report_date;
$$;
revoke all on function report_dispatch_claim(uuid,date),report_dispatch_finish(uuid,date,boolean) from public,anon,authenticated;
grant execute on function report_dispatch_claim(uuid,date),report_dispatch_finish(uuid,date,boolean) to service_role;


create or replace function tax_doc_confirm(p_document_id uuid, p_terminal_code text)
returns tax_documents
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d tax_documents;
  r tax_documents;
  o orders;
  s tax_settings;
  t pos_terminals;
  v_tz text;
begin
  perform pg_advisory_xact_lock(hashtextextended('tax-order:'||(select order_id::text from tax_documents where id=p_document_id),0));
  select * into d from tax_documents where id = p_document_id for update;
  if d.id is null or not has_role(d.restaurant_id, tax_doc_roles(d.doc_type)) then
    raise exception 'forbidden';
  end if;
  if d.status='confirmed' and d.terminal_code=upper(trim(p_terminal_code)) then return d; end if;
  if d.status <> 'draft' then
    raise exception 'not_draft';
  end if;
  s := tax_doc_seller(d.restaurant_id);
  select * into t from pos_terminals
  where restaurant_id = d.restaurant_id and terminal_code = upper(trim(p_terminal_code)) and is_active;
  if t.id is null then
    raise exception 'terminal_not_found';
  end if;
  if d.doc_type = 'ABB' and t.pos_reg_no is null then
    raise exception 'pos_not_registered';
  end if;

  select * into o from orders where id = d.order_id for update;
  if d.doc_type in ('ABB', 'TAX') and o.status <> 'paid' then
    raise exception 'order_not_paid';
  end if;
  if d.doc_type in ('ABB', 'TAX') and d.ref_document_id is null and d.total_amount <> round(o.total, 2) then
    raise exception 'order_total_changed';
  end if;
  if d.doc_type = 'TAX' and (d.buyer_name is null or d.buyer_tax_id is null or d.buyer_address is null) then
    raise exception 'buyer_info_required';
  end if;

  if d.ref_document_id is not null then
    select * into r from tax_documents where id = d.ref_document_id for update;
    if r.status <> 'confirmed' then
      raise exception 'ref_must_be_confirmed';
    end if;
    if d.doc_type = 'CN' then
      if r.doc_type = 'ABB'
         and exists (select 1 from tax_documents where ref_document_id = r.id and doc_type = 'TAX' and status = 'confirmed') then
        raise exception 'abb_replaced_use_tax_invoice';
      end if;
      if d.total_amount + (select coalesce(sum(total_amount), 0) from tax_documents
                           where ref_document_id = r.id and doc_type = 'CN' and status = 'confirmed') > r.total_amount then
        raise exception 'credit_exceeds_invoice';
      end if;
    elsif exists (select 1 from tax_documents where ref_document_id = r.id and doc_type = 'CN' and status = 'confirmed') then
      raise exception 'abb_has_credit_note';
    end if;
  end if;

  v_tz := coalesce((select timezone from restaurants where id = d.restaurant_id), 'Asia/Bangkok');
  d.doc_number := next_tax_doc_no(d.restaurant_id, d.doc_type, t.terminal_code);
  d.status := 'confirmed';
  d.confirmed_at := now();
  d.confirmed_by := (select id from app_users where id = auth.uid());
  d.confirmed_by_name := (select coalesce(display_name, email) from app_users where id = auth.uid());
  d.issue_date := (d.confirmed_at at time zone v_tz)::date;
  d.terminal_id := t.id;
  d.terminal_code := t.terminal_code;
  d.pos_reg_no := t.pos_reg_no;
  d.seller_tax_id := s.tax_id;
  d.seller_name := s.company_name;
  d.seller_branch_code := s.branch_code;
  d.seller_address := s.registered_address;
  d.seller_postcode := s.postcode;
  d.xml_payload := tax_doc_build_xml(d, r, v_tz);

  perform set_config('plato.tax_confirm_ctx', d.id::text, true);
  update tax_documents
     set doc_number = d.doc_number, status = d.status, confirmed_at = d.confirmed_at,
         confirmed_by = d.confirmed_by, confirmed_by_name = d.confirmed_by_name, issue_date = d.issue_date,
         terminal_id = d.terminal_id, terminal_code = d.terminal_code, pos_reg_no = d.pos_reg_no,
         seller_tax_id = d.seller_tax_id, seller_name = d.seller_name, seller_branch_code = d.seller_branch_code,
         seller_address = d.seller_address, seller_postcode = d.seller_postcode, xml_payload = d.xml_payload
   where id = d.id
  returning * into d;
  perform set_config('plato.tax_confirm_ctx', '', true);
  return d;
end;
$$;

create or replace function shift_close(p_shift_id uuid, p_actual_cash numeric, p_note text default null)
returns cashier_shifts
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s cashier_shifts;
  x record;
begin
  select * into s from cashier_shifts where id = p_shift_id for update;
  if s.id is null or not (has_role(s.restaurant_id, array['owner', 'manager'])
                          or (s.cashier_id = auth.uid() and is_staff_of(s.restaurant_id))) then
    raise exception 'forbidden';
  end if;
  if s.status='closed' and s.actual_cash=round(p_actual_cash,2) then return s; end if;
  if s.status <> 'open' then
    raise exception 'shift_closed';
  end if;
  if p_actual_cash is null or p_actual_cash < 0 then
    raise exception 'invalid_amount';
  end if;
  select * into x from shift_totals(s.id);
  update cashier_shifts
     set status = 'closed', closed_at = now(),
         cash_sales = x.cash_sales, cash_in_total = x.cash_in_total, cash_out_total = x.cash_out_total,
         expected_cash = x.expected_cash, actual_cash = round(p_actual_cash, 2),
         variance_cash = round(p_actual_cash, 2) - x.expected_cash,
         close_note = left(nullif(trim(p_note), ''), 300),
         closed_by = (select id from app_users where id = auth.uid()),
         closed_by_name = (select coalesce(display_name, email) from app_users where id = auth.uid())
   where id = s.id
  returning * into s;
  return s;
end;
$$;

create or replace function acct_close_day(p_restaurant_id uuid, p_date date, p_counted_cash numeric, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_system numeric;
  v_diff numeric;
  v_entry uuid;
  v_summary jsonb;
  v_id uuid;
  previous day_closes;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager']) then
    raise exception 'forbidden';
  end if;
  if p_date is null or p_date > acct_today(p_restaurant_id) then
    raise exception 'invalid_date';
  end if;
  if p_counted_cash is null or p_counted_cash < 0 or p_counted_cash > 100000000 then
    raise exception 'invalid_amount';
  end if;
  perform 1 from restaurants where id = p_restaurant_id for update;     -- กันปิดวันซ้ำพร้อมกัน 2 เครื่อง
  select * into previous from day_closes where restaurant_id=p_restaurant_id and close_date=p_date;
  if found and previous.counted_cash=round(p_counted_cash,2) then
    return previous.summary || jsonb_build_object('id',previous.id,'restaurant',(select name from restaurants where id=p_restaurant_id),'date',p_date,'system_cash',previous.system_cash,'counted_cash',previous.counted_cash,'difference',previous.difference,'closed',true);
  end if;
  if previous.id is not null then
    raise exception 'already_closed';
  end if;

  select coalesce(sum(jl.debit - jl.credit), 0) into v_system
  from journal_lines jl join journal_entries e on e.id = jl.entry_id
  join accounts a on a.id = jl.account_id and a.grp = 'cash'
  where jl.restaurant_id = p_restaurant_id and e.entry_date <= p_date;
  v_diff := round(p_counted_cash, 2) - v_system;

  if v_diff <> 0 then
    v_entry := acct_new_entry(p_restaurant_id, 'day_close', null, p_date,
                              case when v_diff > 0 then 'ปิดวัน: เงินสดเกิน' else 'ปิดวัน: เงินสดขาด' end);
    perform acct_line(v_entry, 'cash', v_diff);
    perform acct_line(v_entry, 'cash_over_short', -v_diff);
  end if;

  v_summary := acct_summary_data(p_restaurant_id, p_date, p_date);
  insert into day_closes (restaurant_id, close_date, system_cash, counted_cash, difference, summary, note, confirmed_by, confirmed_by_name)
  values (p_restaurant_id, p_date, v_system, round(p_counted_cash, 2), v_diff, v_summary, nullif(left(trim(p_note), 300), ''),
          (select id from app_users where id = auth.uid()),
          (select coalesce(display_name, email) from app_users where id = auth.uid()))
  returning id into v_id;

  return v_summary || jsonb_build_object(
    'id', v_id, 'restaurant', (select name from restaurants where id = p_restaurant_id), 'date', p_date,
    'system_cash', v_system, 'counted_cash', round(p_counted_cash, 2), 'difference', v_diff, 'closed', true);
end;
$$;

create or replace function display_content(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_rid uuid;
begin
  if p_token is null or length(p_token) < 32 then
    return null;
  end if;
  select restaurant_id into v_rid from display_screens where token = p_token;
  if v_rid is null then
    return null;
  end if;

  return jsonb_build_object(
    'restaurant', (select name from restaurants where id = v_rid),
    'settings', coalesce((select settings from display_settings where restaurant_id = v_rid), '{}'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'name', m.name, 'price', m.price, 'sold_by_weight', m.sold_by_weight, 'description', m.description, 'category', c.name,
               'media', coalesce((
                 select jsonb_agg(display_media_json(d) order by d.sort_order, d.created_at)
                 from display_media d where d.menu_item_id = m.id and d.is_active
               ), '[]'::jsonb))
             order by c.sort_order nulls last, m.name)
      from menu_items m
      left join menu_categories c on c.id = m.category_id
      where m.restaurant_id = v_rid and m.is_recommended and m.is_available
    ), '[]'::jsonb),
    'promotions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'discount_type', p.discount_type, 'value', p.value,
               'min_subtotal', p.min_subtotal, 'ends_on', p.ends_on,
               'start_time', p.start_time, 'end_time', p.end_time,
               'items', coalesce((
                 select jsonb_agg(jsonb_build_object('name', m.name, 'image', (
                          select display_media_json(d) from display_media d
                          where d.menu_item_id = m.id and d.is_active and d.kind = 'image'
                          order by d.sort_order, d.created_at limit 1))
                        order by m.name)
                 from promotion_items pi join menu_items m on m.id = pi.menu_item_id
                 where pi.promotion_id = p.id and m.is_available
               ), '[]'::jsonb))
             order by p.name)
      from promotions p
      where p.restaurant_id = v_rid and promotion_is_live(p)
    ), '[]'::jsonb),
    'ads', coalesce((
      select jsonb_agg(display_media_json(d) order by d.sort_order, d.created_at)
      from display_media d where d.restaurant_id = v_rid and d.menu_item_id is null and d.is_active
    ), '[]'::jsonb)
  );
end;
$$;

create function acct_expense_export(p_restaurant_id uuid,p_from date,p_to date) returns jsonb
 language plpgsql stable security definer set search_path=public,pg_temp as $$
 declare result jsonb;
 begin
 if not has_role(p_restaurant_id,array['owner','manager','accountant']) then raise exception 'forbidden'; end if;
 if (select count(*) from expenses e where e.restaurant_id=p_restaurant_id and e.spent_on between p_from and p_to )>200000 then raise exception 'export_too_large'; end if;
 select coalesce(jsonb_agg(to_jsonb(e) || jsonb_build_object('accounts',jsonb_build_object('code',a.code,'name',a.name)) order by e.spent_on,e.id),'[]') into result from expenses e left join accounts a on a.id=e.account_id where e.restaurant_id=p_restaurant_id and e.spent_on between p_from and p_to ;
 return result;
 end; $$;
 revoke all on function acct_expense_export(uuid,date,date) from public,anon;
 grant execute on function acct_expense_export(uuid,date,date) to authenticated;

create function tax_document_export(p_restaurant_id uuid,p_from date,p_to date) returns jsonb
 language plpgsql stable security definer set search_path=public,pg_temp as $$
 declare result jsonb;
 begin
 if not has_role(p_restaurant_id,array['owner','manager','accountant']) then raise exception 'forbidden'; end if;
 if (select count(*) from tax_documents e where e.restaurant_id=p_restaurant_id and e.issue_date between p_from and p_to and e.status='confirmed')>200000 then raise exception 'export_too_large'; end if;
 select coalesce(jsonb_agg(to_jsonb(e)-'xml_payload' order by e.issue_date,e.id),'[]') into result from tax_documents e  where e.restaurant_id=p_restaurant_id and e.issue_date between p_from and p_to and e.status='confirmed';
 return result;
 end; $$;
 revoke all on function tax_document_export(uuid,date,date) from public,anon;
 grant execute on function tax_document_export(uuid,date,date) to authenticated;

-- Scalar JSON results are not truncated by the PostgREST row cap.
create function acct_trial_balance_export(p_restaurant_id uuid,p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
 if not has_role(p_restaurant_id,array['owner','manager','accountant']) then raise exception 'forbidden'; end if;
 if (select count(*) from accounts where restaurant_id=p_restaurant_id)>200000 then raise exception 'export_too_large'; end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.code,x.account_id),'[]') into result from acct_trial_balance(p_restaurant_id,p_from,p_to) x;
 return result;
end; $$;
create function acct_menu_profit_export(p_restaurant_id uuid,p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
 if not has_role(p_restaurant_id,array['owner','manager','accountant']) then raise exception 'forbidden'; end if;
 if (select count(*) from menu_items where restaurant_id=p_restaurant_id)>200000 then raise exception 'export_too_large'; end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.gross_profit desc,x.menu_item_id),'[]') into result from acct_menu_profit(p_restaurant_id,p_from,p_to) x;
 return result;
end; $$;
revoke all on function acct_trial_balance_export(uuid,date,date),acct_menu_profit_export(uuid,date,date) from public,anon;
grant execute on function acct_trial_balance_export(uuid,date,date),acct_menu_profit_export(uuid,date,date) to authenticated;

create function tax_documents_list(p_restaurant_id uuid,p_from date default null,p_to date default null,
 p_doc_type text default null,p_status text default null,p_order_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
 if not has_role(p_restaurant_id,array['owner','manager','staff','accountant']) then raise exception 'forbidden'; end if;
 if (p_from is not null and p_to is not null and p_from>p_to)
 or (p_doc_type is not null and p_doc_type not in('ABB','TAX','CN'))
 or (p_status is not null and p_status not in('draft','confirmed','voided')) then raise exception 'invalid_request'; end if;
 select coalesce(jsonb_agg(to_jsonb(d)-'xml_payload' order by d.created_at desc,d.id),'[]') into result from (
  select * from tax_documents where restaurant_id=p_restaurant_id
  and (p_from is null or issue_date>=p_from) and (p_to is null or issue_date<=p_to)
  and (p_doc_type is null or doc_type=p_doc_type) and (p_status is null or status=p_status)
  and (p_order_id is null or order_id=p_order_id) order by created_at desc,id limit 200001
 ) d;
 if jsonb_array_length(result)>200000 then raise exception 'export_too_large'; end if;
 return result;
end; $$;
revoke all on function tax_documents_list(uuid,date,date,text,text,uuid) from public,anon;
grant execute on function tax_documents_list(uuid,date,date,text,text,uuid) to authenticated;


-- Serialize tax mutations for the same order before taking document row locks.
create or replace function tax_doc_create(
  p_doc_type text,
  p_order_id uuid default null,
  p_ref_document_id uuid default null,
  p_buyer_name text default null,
  p_buyer_tax_id text default null,
  p_buyer_branch_code text default null,
  p_buyer_address text default null,
  p_exempt_amount numeric default 0,
  p_amount numeric default null,
  p_credit_note_reason text default null
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_type text := upper(trim(p_doc_type));
  o orders;
  r tax_documents;
  v_rate numeric;
  v_total numeric;
  v_exempt numeric;
  v_taxable numeric;
  v_vat numeric;
  v_buyer_name text := nullif(trim(p_buyer_name), '');
  v_buyer_tax text := nullif(trim(p_buyer_tax_id), '');
  v_buyer_branch text := nullif(trim(p_buyer_branch_code), '');
  v_buyer_addr text := nullif(trim(p_buyer_address), '');
  v_reason text := nullif(trim(p_credit_note_reason), '');
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('tax-order:'||coalesce(p_order_id,(select order_id from tax_documents where id=p_ref_document_id))::text,0));
  if v_type is null or v_type not in ('ABB', 'TAX', 'CN') then
    raise exception 'invalid_doc_type';
  end if;
  if p_ref_document_id is not null then
    select * into r from tax_documents where id = p_ref_document_id for update;
    if r.id is null then
      raise exception 'ref_not_found';
    end if;
    if p_order_id is not null and p_order_id <> r.order_id then
      raise exception 'ref_order_mismatch';
    end if;
  end if;
  select * into o from orders where id = coalesce(p_order_id, r.order_id) for update;
  if o.id is null then
    raise exception 'order_not_found';
  end if;
  if not has_role(o.restaurant_id, tax_doc_roles(v_type)) then
    raise exception 'forbidden';
  end if;
  perform tax_doc_seller(o.restaurant_id);
  if v_buyer_tax is not null and not th_tax_id_valid(v_buyer_tax) then
    raise exception 'invalid_buyer_tax_id';
  end if;
  if v_buyer_branch is not null and v_buyer_branch !~ '^[0-9]{5}$' then
    raise exception 'invalid_buyer_branch_code';
  end if;

  if v_type in ('ABB', 'TAX') then
    if o.status <> 'paid' then
      raise exception 'order_not_paid';
    end if;
    if v_reason is not null then
      raise exception 'invalid_request';
    end if;
    if v_type = 'ABB' then
      if r.id is not null then
        raise exception 'invalid_request';
      end if;
      if exists (select 1 from tax_documents where order_id = o.id and doc_type = 'TAX' and status <> 'voided') then
        raise exception 'tax_invoice_exists';
      end if;
    end if;
    if v_type = 'TAX' and r.id is not null then
      if r.doc_type <> 'ABB' or r.status <> 'confirmed' then
        raise exception 'ref_must_be_confirmed_abb';
      end if;
      if exists (select 1 from tax_documents where ref_document_id = r.id and doc_type = 'CN' and status <> 'voided') then
        raise exception 'abb_has_credit_note';
      end if;
      v_rate := r.vat_rate;
      v_total := r.total_amount;
      v_exempt := r.exempt_amount;
    else
      if v_type = 'TAX'
         and exists (select 1 from tax_documents where order_id = o.id and doc_type = 'ABB' and status = 'confirmed') then
        raise exception 'abb_exists_use_ref';
      end if;
      select vat_rate into v_rate from shop_settings where restaurant_id = o.restaurant_id;
      v_total := round(o.total, 2);
      v_exempt := round(coalesce(p_exempt_amount, 0), 2);
      if v_exempt < 0 or v_exempt > v_total then
        raise exception 'invalid_exempt_amount';
      end if;
    end if;
  else
    if r.id is null then
      raise exception 'ref_required';
    end if;
    if r.doc_type not in ('ABB', 'TAX') or r.status <> 'confirmed' then
      raise exception 'ref_must_be_confirmed_invoice';
    end if;
    if r.doc_type = 'ABB'
       and exists (select 1 from tax_documents where ref_document_id = r.id and doc_type = 'TAX' and status <> 'voided') then
      raise exception 'abb_replaced_use_tax_invoice';
    end if;
    if v_reason is null then
      raise exception 'reason_required';
    end if;
    v_total := round(coalesce(p_amount, 0), 2);
    if v_total <= 0 then
      raise exception 'invalid_amount';
    end if;
    if v_total + (select coalesce(sum(total_amount), 0) from tax_documents
                  where ref_document_id = r.id and doc_type = 'CN' and status <> 'voided') > r.total_amount then
      raise exception 'credit_exceeds_invoice';
    end if;
    v_rate := r.vat_rate;
    v_exempt := round(v_total * r.exempt_amount / r.total_amount, 2);
    v_buyer_name := coalesce(v_buyer_name, r.buyer_name);
    v_buyer_tax := coalesce(v_buyer_tax, r.buyer_tax_id);
    v_buyer_branch := coalesce(v_buyer_branch, r.buyer_branch_code);
    v_buyer_addr := coalesce(v_buyer_addr, r.buyer_address);
  end if;

  if v_total <= 0 then
    raise exception 'zero_amount';
  end if;
  if v_buyer_tax is not null then
    v_buyer_branch := coalesce(v_buyer_branch, '00000');
  else
    v_buyer_branch := null;
  end if;
  select taxable, vat into v_taxable, v_vat from tax_doc_split(v_total, v_exempt, v_rate);

  begin
    insert into tax_documents (restaurant_id, order_id, ref_document_id, doc_type, status,
                               buyer_name, buyer_tax_id, buyer_branch_code, buyer_address,
                               vat_rate, taxable_amount, exempt_amount, vat_amount, total_amount,
                               credit_note_reason, created_by, created_by_name)
    values (o.restaurant_id, o.id, r.id, v_type, 'draft',
            v_buyer_name, v_buyer_tax, v_buyer_branch, v_buyer_addr,
            v_rate, v_taxable, v_exempt, v_vat, v_total,
            case when v_type = 'CN' then v_reason end,
            (select id from app_users where id = auth.uid()),
            (select coalesce(display_name, email) from app_users where id = auth.uid()))
    returning id into v_id;
  exception when unique_violation then
    raise exception 'document_exists';
  end;
  return v_id;
end;
$$;


-- Serialize tax mutations for the same order before taking document row locks.
create or replace function tax_doc_update_draft(
  p_document_id uuid,
  p_buyer_name text default null,
  p_buyer_tax_id text default null,
  p_buyer_branch_code text default null,
  p_buyer_address text default null,
  p_exempt_amount numeric default null,
  p_amount numeric default null,
  p_credit_note_reason text default null
)
returns tax_documents
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d tax_documents;
  r tax_documents;
  v_tax text := nullif(trim(p_buyer_tax_id), '');
  v_branch text := nullif(trim(p_buyer_branch_code), '');
  v_total numeric;
  v_exempt numeric;
  v_taxable numeric;
  v_vat numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended('tax-order:'||(select order_id::text from tax_documents where id=p_document_id),0));
  select * into d from tax_documents where id = p_document_id for update;
  if d.id is null or not has_role(d.restaurant_id, tax_doc_roles(d.doc_type)) then
    raise exception 'forbidden';
  end if;
  if d.status <> 'draft' then
    raise exception 'not_draft';
  end if;
  if v_tax is not null and not th_tax_id_valid(v_tax) then
    raise exception 'invalid_buyer_tax_id';
  end if;
  if v_branch is not null and v_branch !~ '^[0-9]{5}$' then
    raise exception 'invalid_buyer_branch_code';
  end if;
  d.buyer_name := nullif(trim(p_buyer_name), '');
  d.buyer_tax_id := v_tax;
  d.buyer_branch_code := case when v_tax is null then null else coalesce(v_branch, '00000') end;
  d.buyer_address := nullif(trim(p_buyer_address), '');

  if d.doc_type = 'CN' then
    if p_exempt_amount is not null then
      raise exception 'invalid_request';
    end if;
    select * into r from tax_documents where id = d.ref_document_id for update;
    if p_credit_note_reason is not null then
      d.credit_note_reason := nullif(trim(p_credit_note_reason), '');
      if d.credit_note_reason is null then
        raise exception 'reason_required';
      end if;
    end if;
    if p_amount is not null then
      v_total := round(p_amount, 2);
      if v_total <= 0 then
        raise exception 'invalid_amount';
      end if;
      if v_total + (select coalesce(sum(total_amount), 0) from tax_documents
                    where ref_document_id = r.id and doc_type = 'CN' and status <> 'voided' and id <> d.id) > r.total_amount then
        raise exception 'credit_exceeds_invoice';
      end if;
      v_exempt := round(v_total * r.exempt_amount / r.total_amount, 2);
      select taxable, vat into v_taxable, v_vat from tax_doc_split(v_total, v_exempt, d.vat_rate);
      d.total_amount := v_total;
      d.exempt_amount := v_exempt;
      d.taxable_amount := v_taxable;
      d.vat_amount := v_vat;
    end if;
  else
    if p_amount is not null or p_credit_note_reason is not null then
      raise exception 'invalid_request';
    end if;
    if p_exempt_amount is not null then
      if d.ref_document_id is not null then
        raise exception 'amounts_follow_ref';
      end if;
      v_exempt := round(p_exempt_amount, 2);
      if v_exempt < 0 or v_exempt > d.total_amount then
        raise exception 'invalid_exempt_amount';
      end if;
      select taxable, vat into v_taxable, v_vat from tax_doc_split(d.total_amount, v_exempt, d.vat_rate);
      d.exempt_amount := v_exempt;
      d.taxable_amount := v_taxable;
      d.vat_amount := v_vat;
    end if;
  end if;

  update tax_documents
     set buyer_name = d.buyer_name, buyer_tax_id = d.buyer_tax_id, buyer_branch_code = d.buyer_branch_code,
         buyer_address = d.buyer_address, credit_note_reason = d.credit_note_reason,
         total_amount = d.total_amount, exempt_amount = d.exempt_amount,
         taxable_amount = d.taxable_amount, vat_amount = d.vat_amount
   where id = d.id
  returning * into d;
  return d;
end;
$$;


-- Serialize tax mutations for the same order before taking document row locks.
create or replace function tax_doc_void_draft(p_document_id uuid, p_reason text)
returns tax_documents
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d tax_documents;
begin
  perform pg_advisory_xact_lock(hashtextextended('tax-order:'||(select order_id::text from tax_documents where id=p_document_id),0));
  select * into d from tax_documents where id = p_document_id for update;
  if d.id is null or not has_role(d.restaurant_id, tax_doc_roles(d.doc_type)) then
    raise exception 'forbidden';
  end if;
  if d.status <> 'draft' then
    raise exception 'not_draft';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'reason_required';
  end if;
  update tax_documents
     set status = 'voided', voided_at = now(),
         voided_by = (select id from app_users where id = auth.uid()),
         voided_by_name = (select coalesce(display_name, email) from app_users where id = auth.uid()),
         void_reason = left(trim(p_reason), 300)
   where id = d.id
  returning * into d;
  return d;
end;
$$;
