-- CRM/operations features. All identity and member mutations bind the tenant in the transaction.
alter table promotions add column coupon_code text check (coupon_code ~ '^[A-Z0-9_-]{3,40}$');
alter table promotions add column stackable boolean not null default true;
create unique index promotions_coupon_unique on promotions(restaurant_id,upper(coupon_code)) where coupon_code is not null;
grant insert(coupon_code,stackable),update(coupon_code,stackable) on promotions to authenticated;

alter function save_promotion(uuid,uuid,jsonb,uuid[]) rename to save_promotion_core;
revoke all on function save_promotion_core(uuid,uuid,jsonb,uuid[]) from authenticated;
create function save_promotion(p_restaurant_id uuid,p_promotion_id uuid,p_values jsonb,p_item_ids uuid[]) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid;
begin
 v_id:=save_promotion_core(p_restaurant_id,p_promotion_id,p_values,p_item_ids);
 update promotions set coupon_code=nullif(upper(trim(p_values->>'coupon_code')),''),stackable=coalesce((p_values->>'stackable')::boolean,true) where id=v_id;
 return v_id;
end; $$;
revoke all on function save_promotion(uuid,uuid,jsonb,uuid[]) from public,anon;
grant execute on function save_promotion(uuid,uuid,jsonb,uuid[]) to authenticated;

alter function apply_promotions(uuid,uuid[],uuid[]) rename to apply_promotions_before_coupons;
revoke all on function apply_promotions_before_coupons(uuid,uuid[],uuid[]) from public,anon,authenticated;
create function apply_promotions(p_restaurant_id uuid,p_order_ids uuid[],p_promotion_ids uuid[]) returns numeric
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform 1 from promotions where id=any(p_promotion_ids) order by id for update;
 if (select count(distinct x) from unnest(p_promotion_ids) x)>1 and exists(select 1 from promotions where id=any(p_promotion_ids) and not stackable) then raise exception 'promotion_conflict'; end if;
 return apply_promotions_before_coupons(p_restaurant_id,p_order_ids,p_promotion_ids);
end; $$;
revoke all on function apply_promotions(uuid,uuid[],uuid[]) from public,anon,authenticated;

create function coupon_lookup(p_restaurant_id uuid,p_code text) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
 if not has_role(p_restaurant_id,array['owner','manager','staff']) then raise exception 'forbidden'; end if;
 select to_jsonb(p)||jsonb_build_object('item_ids',coalesce((select jsonb_agg(menu_item_id) from promotion_items where promotion_id=p.id),'[]'::jsonb)) into result
 from promotions p where restaurant_id=p_restaurant_id and coupon_code=upper(trim(p_code)) and promotion_is_live(p);
 return result;
end; $$;
create function promo_report(p_restaurant_id uuid,p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
 if not has_role(p_restaurant_id,array['owner','manager','accountant']) then raise exception 'forbidden'; end if;
 if p_from>p_to or p_to-p_from>3660 then raise exception 'invalid_range'; end if;
 select coalesce(jsonb_agg(to_jsonb(t)),'[]') into result from (
 select p.id,p.name,p.coupon_code,p.stackable,count(distinct op.promotion_use_id) uses,count(distinct o.id) orders,
 coalesce(sum(op.discount),0) discount,coalesce(sum(o.total),0) attributed_sales
 from promotions p left join order_promotions op on op.promotion_id=p.id
 left join orders o on o.id=op.order_id and o.status='paid' and (o.paid_at at time zone (select timezone from restaurants where id=p_restaurant_id))::date between p_from and p_to
 where p.restaurant_id=p_restaurant_id and (op.order_id is null or o.id is not null)
 group by p.id order by coalesce(sum(op.discount),0) desc,p.id) t;
 return result;
end; $$;
revoke all on function coupon_lookup(uuid,text),promo_report(uuid,date,date) from public,anon;
grant execute on function coupon_lookup(uuid,text),promo_report(uuid,date,date) to authenticated;

create function member_find(p_restaurant_id uuid,p_phone text) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if not has_role(p_restaurant_id,array['owner','manager','staff']) then raise exception 'forbidden'; end if;
 if p_phone !~ '^([0-9]{4}|0[0-9]{8,9})$' then raise exception 'invalid_phone'; end if;
 return (select coalesce(jsonb_agg(to_jsonb(t)),'[]') from (select id,name,phone,points from members where restaurant_id=p_restaurant_id and
 (case when length(p_phone)=4 then right(phone,4)=p_phone else phone=p_phone end) order by name,id limit 100) t);
end; $$;
create function member_export(p_restaurant_id uuid,p_member_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare m members;
begin
 if not has_role(p_restaurant_id,array['owner']) then raise exception 'forbidden'; end if;
 select * into m from members where id=p_member_id and restaurant_id=p_restaurant_id;
 if m.id is null then raise exception 'not_found'; end if;
 return jsonb_build_object('member',to_jsonb(m),'points',coalesce((select jsonb_agg(to_jsonb(l) order by l.created_at,l.id) from point_ledger l where member_id=m.id),'[]'),
 'orders',coalesce((select jsonb_agg(jsonb_build_object('id',id,'created_at',created_at,'paid_at',paid_at,'total',total,'status',status) order by created_at,id) from orders where member_id=m.id),'[]'));
end; $$;
create function member_delete(p_restaurant_id uuid,p_member_id uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not has_role(p_restaurant_id,array['owner']) then raise exception 'forbidden'; end if;
 perform 1 from orders where member_id=p_member_id and restaurant_id=p_restaurant_id order by id for update;
 perform 1 from members where id=p_member_id and restaurant_id=p_restaurant_id for update;
 if not found then raise exception 'not_found'; end if;
 -- Preserve accounting records without member identity; loyalty ledger is erased with the member.
 update orders set member_id=null where member_id=p_member_id;
 delete from members where id=p_member_id;
 return jsonb_build_object('deleted',true,'financial_records_retained',true);
end; $$;
revoke all on function member_find(uuid,text),member_export(uuid,uuid),member_delete(uuid,uuid) from public,anon;
grant execute on function member_find(uuid,text),member_export(uuid,uuid),member_delete(uuid,uuid) to authenticated;

create table feedback (
 id uuid primary key default gen_random_uuid(), restaurant_id uuid not null references restaurants(id) on delete cascade,
 rating smallint not null check(rating between 1 and 5), created_at timestamptz not null default now(),
 client_ref uuid not null, unique(restaurant_id,client_ref)
);
alter table feedback enable row level security;
create policy feedback_read on feedback for select to authenticated using(has_role(restaurant_id,array['owner','manager']));
revoke all on feedback from public,anon,authenticated;
grant select on feedback to authenticated;
create function submit_feedback(p_restaurant_id uuid,p_rating int,p_client_ref uuid) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid;
begin
 if not has_role(p_restaurant_id,array['owner','manager','staff']) then raise exception 'forbidden'; end if;
 insert into feedback(restaurant_id,rating,client_ref) values(p_restaurant_id,p_rating,p_client_ref) on conflict(restaurant_id,client_ref) do nothing returning id into v_id;
 return coalesce(v_id,(select id from feedback where restaurant_id=p_restaurant_id and client_ref=p_client_ref));
end; $$;
create function feedback_report(p_restaurant_id uuid,p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if not has_role(p_restaurant_id,array['owner','manager']) then raise exception 'forbidden'; end if;
 return (select jsonb_build_object('count',count(*),'average',round(avg(rating),2),'ratings',jsonb_build_object('1',count(*) filter(where rating=1),'2',count(*) filter(where rating=2),'3',count(*) filter(where rating=3),'4',count(*) filter(where rating=4),'5',count(*) filter(where rating=5)))
 from feedback where restaurant_id=p_restaurant_id and (created_at at time zone (select timezone from restaurants where id=p_restaurant_id))::date between p_from and p_to);
end; $$;
revoke all on function submit_feedback(uuid,int,uuid),feedback_report(uuid,date,date) from public,anon;
grant execute on function submit_feedback(uuid,int,uuid),feedback_report(uuid,date,date) to authenticated;

alter table shop_settings add column morning_report_enabled boolean not null default false;
alter table shop_settings add column morning_report_hour int not null default 8 check(morning_report_hour between 0 and 23);
grant insert(morning_report_enabled,morning_report_hour),update(morning_report_enabled,morning_report_hour) on shop_settings to authenticated;
create function morning_report_targets(p_scheduled_at timestamptz default now()) returns table(restaurant_id uuid,line_to text,report_date date)
language sql stable security definer set search_path=public,pg_temp as $$
 select s.restaurant_id,s.line_to,(p_scheduled_at at time zone r.timezone)::date-1 from shop_settings s join restaurants r on r.id=s.restaurant_id
 where s.morning_report_enabled and s.line_to is not null and extract(hour from p_scheduled_at at time zone r.timezone)=s.morning_report_hour;
$$;
create function morning_stock_data(p_restaurant_id uuid,p_date date) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('low_stock',coalesce((select jsonb_agg(jsonb_build_object('name',name,'unit',unit,'quantity',quantity_on_hand,'par',coalesce(par_level,reorder_level))) from ingredients where restaurant_id=p_restaurant_id and is_active and quantity_on_hand<coalesce(par_level,reorder_level)),'[]'),
 'expiring',coalesce((select jsonb_agg(jsonb_build_object('name',i.name,'unit',i.unit,'quantity',l.qty_remaining,'expiry_date',l.expiry_date)) from stock_lots l join ingredients i on i.id=l.ingredient_id where l.restaurant_id=p_restaurant_id and l.qty_remaining>0 and l.expiry_date<=p_date+3),'[]'));
$$;
revoke all on function morning_report_targets(timestamptz),morning_stock_data(uuid,date) from public,anon,authenticated;
grant execute on function morning_report_targets(timestamptz),morning_stock_data(uuid,date) to service_role;

create table private.morning_dispatches (like private.report_dispatches including all);
create function morning_dispatch_claim(p_restaurant_id uuid,p_report_date date) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare d private.morning_dispatches;
begin
 insert into private.morning_dispatches(restaurant_id,report_date) values(p_restaurant_id,p_report_date) on conflict do nothing;
 select * into d from private.morning_dispatches where restaurant_id=p_restaurant_id and report_date=p_report_date for update;
 if d.sent_at is not null or d.claimed_at>clock_timestamp()-interval '5 minutes' then return null; end if;
 update private.morning_dispatches set claimed_at=clock_timestamp() where restaurant_id=p_restaurant_id and report_date=p_report_date;
 return d.retry_key;
end; $$;
create function morning_dispatch_finish(p_restaurant_id uuid,p_report_date date,p_success boolean) returns void
language sql security definer set search_path=public,pg_temp as $$
 update private.morning_dispatches set claimed_at=null,sent_at=case when p_success then clock_timestamp() else sent_at end where restaurant_id=p_restaurant_id and report_date=p_report_date;
$$;
revoke all on function morning_dispatch_claim(uuid,date),morning_dispatch_finish(uuid,date,boolean) from public,anon,authenticated;
grant execute on function morning_dispatch_claim(uuid,date),morning_dispatch_finish(uuid,date,boolean) to service_role;

create function report_dispatch_pending(p_morning boolean default false)
returns table(restaurant_id uuid,report_date date,line_to text)
language sql stable security definer set search_path=public,pg_temp as $$
 select d.restaurant_id,d.report_date,s.line_to from (
   select * from private.report_dispatches where not p_morning
   union all select * from private.morning_dispatches where p_morning
 ) d join shop_settings s on s.restaurant_id=d.restaurant_id
 where d.sent_at is null and (d.claimed_at is null or d.claimed_at<now()-interval '5 minutes') and s.line_to is not null
 order by d.report_date,d.restaurant_id limit 500;
$$;
revoke all on function report_dispatch_pending(boolean) from public,anon,authenticated;
grant execute on function report_dispatch_pending(boolean) to service_role;

create table private.day_close_dispatches (like private.report_dispatches including all);
alter function acct_close_day(uuid,date,numeric,text) rename to acct_close_day_core;
revoke all on function acct_close_day_core(uuid,date,numeric,text) from public,anon,authenticated;
create function acct_close_day(p_restaurant_id uuid,p_date date,p_counted_cash numeric,p_note text default null,p_notify boolean default false) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
 result:=acct_close_day_core(p_restaurant_id,p_date,p_counted_cash,p_note);
 if p_notify then insert into private.day_close_dispatches(restaurant_id,report_date) values(p_restaurant_id,p_date) on conflict do nothing; end if;
 return result;
end; $$;
revoke all on function acct_close_day(uuid,date,numeric,text,boolean) from public,anon;
grant execute on function acct_close_day(uuid,date,numeric,text,boolean) to authenticated;
create function day_close_dispatch_claim(p_restaurant_id uuid,p_report_date date) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare d private.day_close_dispatches;
begin
 if not exists(select 1 from day_closes where restaurant_id=p_restaurant_id and close_date=p_report_date) then raise exception 'not_found'; end if;
 insert into private.day_close_dispatches(restaurant_id,report_date) values(p_restaurant_id,p_report_date) on conflict do nothing;
 select * into d from private.day_close_dispatches where restaurant_id=p_restaurant_id and report_date=p_report_date for update;
 if d.sent_at is not null or d.claimed_at>clock_timestamp()-interval '5 minutes' then return null; end if;
 update private.day_close_dispatches set claimed_at=clock_timestamp() where restaurant_id=p_restaurant_id and report_date=p_report_date;
 return d.retry_key;
end; $$;
create function day_close_dispatch_finish(p_restaurant_id uuid,p_report_date date,p_success boolean) returns void
language sql security definer set search_path=public,pg_temp as $$
 update private.day_close_dispatches set claimed_at=null,sent_at=case when p_success then clock_timestamp() else sent_at end where restaurant_id=p_restaurant_id and report_date=p_report_date;
$$;
create function day_close_dispatch_pending() returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(to_jsonb(t)),'[]') from (
 select d.restaurant_id,d.report_date,s.line_to,c.summary||jsonb_build_object('restaurant',r.name,'date',c.close_date,'system_cash',c.system_cash,'counted_cash',c.counted_cash,'difference',c.difference) as summary from private.day_close_dispatches d
 join day_closes c on c.restaurant_id=d.restaurant_id and c.close_date=d.report_date
 join shop_settings s on s.restaurant_id=d.restaurant_id
 join restaurants r on r.id=d.restaurant_id
 where d.sent_at is null and (d.claimed_at is null or d.claimed_at<now()-interval '5 minutes') and s.line_to is not null
 order by d.report_date,d.restaurant_id limit 500) t;
$$;
revoke all on function day_close_dispatch_claim(uuid,date),day_close_dispatch_finish(uuid,date,boolean),day_close_dispatch_pending() from public,anon,authenticated;
grant execute on function day_close_dispatch_claim(uuid,date),day_close_dispatch_finish(uuid,date,boolean),day_close_dispatch_pending() to service_role;

-- Local owners can deactivate only identities exclusively belonging to their restaurant.
-- Lock membership table to close races against concurrently attaching the identity elsewhere.
create function staff_set_active(p_restaurant_id uuid,p_user_id uuid,p_active boolean) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not has_role(p_restaurant_id,array['owner']) or p_user_id=auth.uid() then raise exception 'forbidden'; end if;
 lock table staff_members in share row exclusive mode;
 perform 1 from app_users where id=p_user_id for update;
 if not exists(select 1 from staff_members where user_id=p_user_id and restaurant_id=p_restaurant_id) then raise exception 'not_found'; end if;
 if exists(select 1 from staff_members where user_id=p_user_id and (restaurant_id<>p_restaurant_id or role='owner')) then raise exception 'identity_management_required'; end if;
 update app_users set is_active=p_active where id=p_user_id;
 return p_active;
end; $$;
revoke all on function staff_set_active(uuid,uuid,boolean) from public,anon;
grant execute on function staff_set_active(uuid,uuid,boolean) to authenticated;

create function staff_reset_password(p_restaurant_id uuid,p_user_id uuid,p_password text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not has_role(p_restaurant_id,array['owner','manager']) or p_user_id=auth.uid() then raise exception 'forbidden'; end if;
 lock table staff_members in share row exclusive mode;
 perform 1 from app_users where id=p_user_id for update;
 if not exists(select 1 from staff_members where user_id=p_user_id and restaurant_id=p_restaurant_id) then raise exception 'not_found'; end if;
 if exists(select 1 from staff_members where user_id=p_user_id and restaurant_id<>p_restaurant_id)
 or (not has_role(p_restaurant_id,array['owner']) and exists(select 1 from staff_members where user_id=p_user_id and role in ('owner','manager')))
 then raise exception 'identity_management_required'; end if;
 perform app_set_password(p_user_id,p_password,true);
end; $$;
revoke all on function staff_reset_password(uuid,uuid,text) from public,anon;
grant execute on function staff_reset_password(uuid,uuid,text) to authenticated;

create function staff_identity_setup_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare pending boolean;
begin
 select must_change_password into pending from app_users where id=new.user_id for update;
 if pending and exists(select 1 from staff_members where user_id=new.user_id and restaurant_id<>new.restaurant_id) then raise exception 'identity_setup_required'; end if;
 return new;
end; $$;
create trigger staff_identity_setup_guard before insert or update of user_id,restaurant_id on staff_members for each row execute function staff_identity_setup_guard();

drop function staff_list(uuid);
create function staff_list(p_restaurant_id uuid)
returns table(user_id uuid,email text,display_name text,roles text[],is_active boolean)
language sql stable security definer set search_path=public,pg_temp as $$
 select s.user_id,u.email,u.display_name,array_agg(s.role order by s.role),u.is_active
 from staff_members s join app_users u on u.id=s.user_id where s.restaurant_id=p_restaurant_id
 group by s.user_id,u.email,u.display_name,u.is_active
 order by min(case s.role when 'owner' then 0 when 'manager' then 1 else 2 end),u.email;
$$;
revoke all on function staff_list(uuid) from public,anon,authenticated;
grant execute on function staff_list(uuid) to service_role;

create table private.tax_create_requests (
 restaurant_id uuid not null references restaurants(id), client_ref uuid not null, payload_hash text not null,
 document_id uuid not null references tax_documents(id), primary key(restaurant_id,client_ref)
);
alter function tax_doc_create(text,uuid,uuid,text,text,text,text,numeric,numeric,text) rename to tax_doc_create_core;
revoke all on function tax_doc_create_core(text,uuid,uuid,text,text,text,text,numeric,numeric,text) from public,anon,authenticated;
create function tax_doc_create(
 p_doc_type text,p_order_id uuid default null,p_ref_document_id uuid default null,p_buyer_name text default null,
 p_buyer_tax_id text default null,p_buyer_branch_code text default null,p_buyer_address text default null,
 p_exempt_amount numeric default 0,p_amount numeric default null,p_credit_note_reason text default null,p_client_ref uuid default null
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare rid uuid; v_id uuid; v_hash text; previous private.tax_create_requests;
begin
 select restaurant_id into rid from orders where id=p_order_id;
 if rid is null then select restaurant_id into rid from tax_documents where id=p_ref_document_id; end if;
 if rid is null or not has_role(rid,tax_doc_roles(upper(trim(p_doc_type)))) then raise exception 'forbidden'; end if;
 if p_client_ref is not null then
  v_hash:=encode(sha256(convert_to(jsonb_build_array(p_doc_type,p_order_id,p_ref_document_id,p_buyer_name,p_buyer_tax_id,p_buyer_branch_code,p_buyer_address,p_exempt_amount,p_amount,p_credit_note_reason)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(rid::text||p_client_ref::text,0));
  select * into previous from private.tax_create_requests where restaurant_id=rid and client_ref=p_client_ref;
  if found then
   if previous.payload_hash<>v_hash then raise exception 'idempotency_conflict'; end if;
   return previous.document_id;
  end if;
 end if;
 v_id:=tax_doc_create_core(p_doc_type,p_order_id,p_ref_document_id,p_buyer_name,p_buyer_tax_id,p_buyer_branch_code,p_buyer_address,p_exempt_amount,p_amount,p_credit_note_reason);
 if p_client_ref is not null then insert into private.tax_create_requests values(rid,p_client_ref,v_hash,v_id); end if;
 return v_id;
end; $$;
revoke all on function tax_doc_create(text,uuid,uuid,text,text,text,text,numeric,numeric,text,uuid) from public,anon;
grant execute on function tax_doc_create(text,uuid,uuid,text,text,text,text,numeric,numeric,text,uuid) to authenticated;
