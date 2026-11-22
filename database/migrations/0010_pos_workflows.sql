-- POS workflows: server-priced options, repeat-safe orders, table service and bill editing.
alter table menu_items add column option_choices jsonb not null default '[]';
alter table order_items add column options_snapshot jsonb not null default '[]';
alter table orders add column client_ref uuid, add column client_payload jsonb,
 add column is_split boolean not null default false,
 add column bill_requested_at timestamptz,
 add column service_charge numeric(10,2) not null default 0 check(service_charge>=0),
 add column tip numeric(10,2) not null default 0 check(tip>=0);
create unique index orders_client_ref on orders(restaurant_id,client_ref) where client_ref is not null;
alter table dining_tables add column floor_x numeric not null default 0 check(floor_x between 0 and 100),
 add column floor_y numeric not null default 0 check(floor_y between 0 and 100), add column zone text not null default 'Main' check(length(zone) between 1 and 80),add column seats int not null default 4 check(seats between 1 and 100);
alter table shop_settings add column kitchen_warn_minutes int not null default 15 check(kitchen_warn_minutes between 1 and 240),
 add column kitchen_auto_print boolean not null default false, add column kitchen_sound boolean not null default true;
create function validate_menu_options() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare x jsonb;
begin
 if jsonb_typeof(new.option_choices)<>'array' or jsonb_array_length(new.option_choices)>30 then raise exception 'invalid_options'; end if;
 for x in select * from jsonb_array_elements(new.option_choices) loop
  if coalesce(length(x->>'id'),0) not between 1 and 80 or coalesce(length(trim(x->>'name')),0) not between 1 and 80
   or jsonb_typeof(x->'price') is distinct from 'number' or (x->>'price')::numeric not between 0 and 100000
   or (x->>'price')::numeric <> round((x->>'price')::numeric,2) then raise exception 'invalid_options'; end if;
 end loop;
 if (select count(distinct choice->>'id') from jsonb_array_elements(new.option_choices) choice)<>jsonb_array_length(new.option_choices) then raise exception 'duplicate_option'; end if;
 return new;
end; $$;
create trigger validate_menu_options before insert or update on menu_items for each row execute function validate_menu_options();


drop function staff_place_order(uuid,jsonb,uuid,text,text,text,uuid[]);

create or replace function staff_place_order(
  p_restaurant_id uuid,
  p_items jsonb,
  p_table_id uuid default null,
  p_order_type text default 'dine_in',
  p_customer_label text default null,
  p_note text default null,
  p_promotion_ids uuid[] default null, p_client_ref uuid default null
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order uuid;
  v_payload jsonb;
  v_existing jsonb;
  v_options jsonb;
  v_selected jsonb;
  v_option_price numeric;
  v_subtotal numeric(10,2) := 0;
  v_item jsonb;
  v_menu menu_items%rowtype;
  v_qty int;
  v_weight numeric;
  v_price numeric(10,2);
begin
  if not has_role(p_restaurant_id, array['owner', 'staff']) then
    raise exception 'forbidden';
  end if;
  v_payload:=jsonb_build_object('items',p_items,'table',p_table_id,'type',p_order_type,'label',p_customer_label,'note',p_note,'promotions',p_promotion_ids);
  if p_client_ref is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_restaurant_id::text||p_client_ref::text,0));
    select id,client_payload into v_order,v_existing from orders where restaurant_id=p_restaurant_id and client_ref=p_client_ref;
    if found then
      if v_existing is distinct from v_payload then raise exception 'client_ref_conflict'; end if;
      return v_order;
    end if;
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

  insert into orders (restaurant_id, table_id, order_type, customer_label, note, created_by,client_ref,client_payload)
  values (p_restaurant_id, p_table_id, p_order_type,
          nullif(left(trim(p_customer_label), 50), ''), nullif(left(trim(p_note), 200), ''), auth.uid(),p_client_ref,v_payload)
  returning id into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::int;
    if v_qty is null or v_qty < 1 or v_qty > 50 then raise exception 'invalid_quantity'; end if;

    select * into v_menu from menu_items
      where id = (v_item->>'menu_item_id')::uuid and restaurant_id = p_restaurant_id;
    if not found then raise exception 'invalid_menu_item'; end if;
    if not v_menu.is_available then raise exception 'item_unavailable: %', v_menu.name; end if;

    -- ขายตามน้ำหนัก: 1 บรรทัด = 1 ครั้งที่ชั่ง ราคาคิดในฐานข้อมูลจากน้ำหนักจริง
    if v_menu.sold_by_weight then
      v_weight := round((v_item->>'weight_g')::numeric, 1);
      if v_weight is null or v_weight <= 0 or v_weight > 100000 then raise exception 'invalid_weight: %', v_menu.name; end if;
      v_qty := 1;
      v_price := round(v_menu.price * v_weight / 1000, 2);
    else
      v_weight := null;
      v_price := v_menu.price;
    end if;

    v_selected:=coalesce(v_item->'selected_option_ids','[]');
    if jsonb_typeof(v_selected)<>'array' or jsonb_array_length(v_selected)>30 then raise exception 'invalid_options'; end if;
    if (select count(distinct x) from jsonb_array_elements_text(v_selected) x)<>jsonb_array_length(v_selected) then raise exception 'duplicate_option'; end if;
    select coalesce(jsonb_agg(x order by x->>'id'),'[]'),coalesce(sum((x->>'price')::numeric),0) into v_options,v_option_price
    from jsonb_array_elements(v_menu.option_choices) x where x->>'id' in(select jsonb_array_elements_text(v_selected));
    if jsonb_array_length(v_options)<>jsonb_array_length(v_selected) then raise exception 'invalid_options'; end if;
    v_price:=v_price+v_option_price;
    insert into order_items (order_id, menu_item_id, quantity, unit_price, note, weight_g,options_snapshot)
    values (v_order, v_menu.id, v_qty, v_price, nullif(left(trim(v_item->>'note'), 200), ''), v_weight,v_options);

    v_subtotal := v_subtotal + v_price * v_qty;
  end loop;

  update orders set subtotal = v_subtotal, discount_total = 0, total = v_subtotal where id = v_order;
  if coalesce(cardinality(p_promotion_ids), 0) > 0 then
    perform apply_promotions(p_restaurant_id, array[v_order], p_promotion_ids);
  end if;
  return v_order;
end;
$$;

revoke all on function staff_place_order(uuid,jsonb,uuid,text,text,text,uuid[],uuid) from public,anon; grant execute on function staff_place_order(uuid,jsonb,uuid,text,text,text,uuid[],uuid) to authenticated;

create function table_move_orders(p_restaurant_id uuid,p_source_table_id uuid,p_target_table_id uuid) returns int
language plpgsql security definer set search_path=public,pg_temp as $$
declare n int;
begin
 if not has_role(p_restaurant_id,array['owner','staff']) then raise exception 'forbidden'; end if;
 if p_source_table_id=p_target_table_id then raise exception 'invalid_table'; end if;
 perform 1 from dining_tables where id in(p_source_table_id,p_target_table_id) and restaurant_id=p_restaurant_id order by id for update;
 get diagnostics n=row_count;
 if n<>2 then raise exception 'invalid_table'; end if;
 update orders set table_id=p_target_table_id where restaurant_id=p_restaurant_id and table_id=p_source_table_id and status not in('paid','cancelled');
 get diagnostics n=row_count;
 return n;
end; $$;
create function table_request_bill(p_restaurant_id uuid,p_table_id uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not has_role(p_restaurant_id,array['owner','staff']) then raise exception 'forbidden'; end if;
 if not exists(select 1 from dining_tables where id=p_table_id and restaurant_id=p_restaurant_id) then raise exception 'invalid_table'; end if;
 update orders set bill_requested_at=coalesce(bill_requested_at,now()) where restaurant_id=p_restaurant_id and table_id=p_table_id and status not in('paid','cancelled');
end; $$;
create function order_set_charges(p_order_id uuid,p_service_charge numeric,p_tip numeric) returns numeric
language plpgsql security definer set search_path=public,pg_temp as $$
declare o orders; v numeric;
begin
 select * into o from orders where id=p_order_id for update;
 if not found or not has_role(o.restaurant_id,array['owner','staff']) then raise exception 'forbidden'; end if;
 if o.status not in('received','served') then raise exception 'bill_not_ready'; end if;
 if p_service_charge is null or p_tip is null or p_service_charge not between 0 and 100000 or p_tip not between 0 and 100000 or round(p_service_charge,2)<>p_service_charge or round(p_tip,2)<>p_tip then raise exception 'invalid_amount'; end if;
 update orders set total=total-service_charge-tip+p_service_charge+p_tip,service_charge=p_service_charge,tip=p_tip where id=p_order_id returning total into v;
 return v;
end; $$;
create function staff_edit_order(p_order_id uuid,p_items jsonb,p_note text default null) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare o orders; temp_id uuid; promos uuid[]; subtotal_new numeric;
begin
 select * into o from orders where id=p_order_id for update;
 if not found or not has_role(o.restaurant_id,array['owner','staff']) then raise exception 'forbidden'; end if;
 if o.status<>'received' then raise exception 'order_already_started'; end if;
 if o.is_split and exists(select 1 from order_promotions where order_id=p_order_id) then raise exception 'split_promotion_locked'; end if;
 select array_agg(promotion_id) into promos from order_promotions where order_id=p_order_id;
 temp_id:=staff_place_order(o.restaurant_id,p_items,o.table_id,o.order_type,o.customer_label,p_note,null,null);
 select subtotal into subtotal_new from orders where id=temp_id;
 delete from order_items where order_id=p_order_id;
 update order_items set order_id=p_order_id where order_id=temp_id;
 delete from orders where id=temp_id;
 update orders set subtotal=subtotal_new,total=subtotal_new+service_charge+tip,discount_total=0,note=nullif(trim(p_note),'') where id=p_order_id;
 perform apply_promotions(o.restaurant_id,array[p_order_id],coalesce(promos,'{}'));
 return p_order_id;
end; $$;
create function staff_split_order(p_order_id uuid,p_item_ids uuid[]) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare o orders; new_id uuid; selected numeric; all_subtotal numeric; ratio numeric; disc numeric; fee numeric; tips numeric; n int; op record; share numeric; disc_left numeric; disc_remaining numeric; movement record; selected_need numeric; remaining_need numeric; selected_stock numeric;
begin
 select * into o from orders where id=p_order_id for update;
 if not found or not has_role(o.restaurant_id,array['owner','staff']) then raise exception 'forbidden'; end if;
 if o.status not in('received','served') or o.points_redeemed<>0 or o.points_earned<>0 then raise exception 'split_not_allowed'; end if;
 select count(*),sum(quantity*unit_price) into n,selected from order_items where order_id=p_order_id and id=any(p_item_ids);
 if n=0 or n<>cardinality(p_item_ids) or n=(select count(*) from order_items where order_id=p_order_id) then raise exception 'invalid_items'; end if;
 select sum(quantity*unit_price) into all_subtotal from order_items where order_id=p_order_id;
 ratio:=case when all_subtotal=0 then 0 else selected/all_subtotal end;
 disc:=least(selected,round(o.discount_total*ratio,2)); fee:=round(o.service_charge*ratio,2); tips:=round(o.tip*ratio,2);
 insert into orders(restaurant_id,table_id,status,total,subtotal,discount_total,order_type,customer_label,note,created_by,started_at,ready_at,stock_deducted_at,service_charge,tip,bill_requested_at,created_at)
 values(o.restaurant_id,o.table_id,o.status,selected-disc+fee+tips,selected,disc,o.order_type,o.customer_label,o.note,auth.uid(),o.started_at,o.ready_at,o.stock_deducted_at,fee,tips,o.bill_requested_at,o.created_at) returning id into new_id;
 update order_items set order_id=new_id where order_id=p_order_id and id=any(p_item_ids);
 -- Reassign actual stock quantities transactionally so either split bill can be cancelled independently.
 -- The old movements stay immutable and are explicitly reversed; replacements retain their combined quantity.
 for movement in select m.* from stock_movements m where m.order_id=p_order_id and m.type='recipe_deduct'
    and not exists(select 1 from stock_movements x where x.reverses_id=m.id) order by m.ingredient_id,m.id loop
   select coalesce(sum(qty),0) into selected_need from order_ingredient_need(new_id,o.restaurant_id) where ingredient_id=movement.ingredient_id;
   select coalesce(sum(qty),0) into remaining_need from order_ingredient_need(p_order_id,o.restaurant_id) where ingredient_id=movement.ingredient_id;
   if selected_need+remaining_need=0 then raise exception 'split_recipe_changed'; end if;
   selected_stock:=round(-movement.change*selected_need/(selected_need+remaining_need),3);
   insert into stock_movements(restaurant_id,ingredient_id,change,type,order_id,reverses_id,note)
   values(o.restaurant_id,movement.ingredient_id,-movement.change,'recipe_return',p_order_id,movement.id,'Split bill stock reassignment');
   if selected_stock>0 then
    insert into stock_movements(restaurant_id,ingredient_id,change,type,order_id,note) values(o.restaurant_id,movement.ingredient_id,-selected_stock,'recipe_deduct',new_id,'Split bill stock allocation');
   end if;
   if -movement.change-selected_stock>0 then
    insert into stock_movements(restaurant_id,ingredient_id,change,type,order_id,note) values(o.restaurant_id,movement.ingredient_id,movement.change+selected_stock,'recipe_deduct',p_order_id,'Split bill stock allocation');
   end if;
 end loop;
 disc_left:=disc; disc_remaining:=o.discount_total; disc:=0;
 for op in select * from order_promotions where order_id=p_order_id order by promotion_id loop
   share:=case when disc_remaining=0 then 0 else least(op.discount,round(disc_left*op.discount/disc_remaining,2)) end;
   disc_left:=disc_left-share; disc_remaining:=disc_remaining-op.discount;
   insert into order_promotions(order_id,promotion_id,promotion_use_id,discount) values(new_id,op.promotion_id,op.promotion_use_id,share);
   update order_promotions set discount=discount-share where order_id=p_order_id and promotion_id=op.promotion_id;
   disc:=disc+share;
 end loop;
 update orders set discount_total=disc,total=selected-disc+fee+tips,promotion_id=o.promotion_id,is_split=true where id=new_id;
 update orders set subtotal=all_subtotal-selected,discount_total=o.discount_total-disc,total=o.total-(selected-disc+fee+tips),service_charge=o.service_charge-fee,tip=o.tip-tips,is_split=true where id=p_order_id;
 return new_id;
end; $$;
revoke all on function table_move_orders(uuid,uuid,uuid),table_request_bill(uuid,uuid),order_set_charges(uuid,numeric,numeric),staff_edit_order(uuid,jsonb,text),staff_split_order(uuid,uuid[]) from public,anon;
grant execute on function table_move_orders(uuid,uuid,uuid),table_request_bill(uuid,uuid),order_set_charges(uuid,numeric,numeric),staff_edit_order(uuid,jsonb,text),staff_split_order(uuid,uuid[]) to authenticated;


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
  allocation record;
  discount_left numeric;
  base_left numeric;
  allocation_share numeric;
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

    discount_left:=v_disc; base_left:=v_elig;
    for allocation in select * from ap_alloc where promotion_id=p.promotion_id order by base,order_id loop
      allocation_share:=case when base_left=0 then 0 else least(allocation.base,round(discount_left*allocation.base/base_left,2)) end;
      update ap_alloc set share=allocation_share where promotion_id=p.promotion_id and order_id=allocation.order_id;
      discount_left:=discount_left-allocation_share; base_left:=base_left-allocation.base;
    end loop;
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
         total = x.subtotal - coalesce(d.discount, 0) + o.service_charge + o.tip,
         -- โปรหลักของออเดอร์ (ส่วนลดมากสุด) ไว้แสดงผลแบบเดิม
         promotion_id = (select op.promotion_id from order_promotions op where op.order_id = o.id
                         order by op.discount desc, op.promotion_id limit 1)
    from ap_orders x
    left join (select order_id, sum(share) as discount from ap_alloc group by order_id) d on d.order_id = x.order_id
   where o.id = x.order_id;

  return (select coalesce(sum(discount), 0) from ap_promos);
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

  if v_order.is_split and exists(select 1 from order_promotions where order_id=p_order_id) then
    raise exception 'split_promotion_locked';
  end if;
  select sum(quantity * unit_price) into v_subtotal from order_items where order_id = p_order_id;
  select coalesce(array_agg(distinct promotion_id), '{}') into v_promos from order_promotions where order_id = p_order_id;

  update orders set subtotal = v_subtotal, discount_total = 0, total = v_subtotal + service_charge + tip where id = p_order_id;
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

create or replace function acct_post_bill(p orders)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_vat_on boolean;
  v_rate numeric;
  v_f numeric := 1;
  v_gross numeric;
  v_points numeric := coalesce(p.points_discount, 0);
  v_promo numeric;
  v_net_total numeric;
  v_rev_target numeric;
  v_rev_sum numeric := 0;
  v_entry uuid;
  r record;
  v_first uuid;
  v_first_amt numeric;
  v_amt numeric;
  v_n int := 0;
begin
  select coalesce(sum(quantity * unit_price), 0) into v_gross from order_items where order_id = p.id;
  if v_gross = 0 and coalesce(p.total, 0) = 0 then
    return null;
  end if;
  v_gross := v_gross + p.service_charge + p.tip;
  v_promo := greatest(v_gross - p.total - v_points, 0);

  select vat_registered, vat_rate into v_vat_on, v_rate from shop_settings where restaurant_id = p.restaurant_id;
  if coalesce(v_vat_on, false) and coalesce(v_rate, 0) > 0 then
    v_f := 100 / (100 + v_rate);                       -- ราคาขายรวม VAT แล้ว
  end if;
  v_net_total := round(p.total * v_f, 2);
  v_promo := round(v_promo * v_f, 2);
  v_points := round(v_points * v_f, 2);
  v_rev_target := v_net_total + v_promo + v_points;

  v_entry := acct_new_entry(p.restaurant_id, 'bill', p.id,
                            acct_open_date(p.restaurant_id, (coalesce(p.paid_at, now()) at time zone
                              coalesce((select timezone from restaurants where id = p.restaurant_id), 'Asia/Bangkok'))::date),
                            'ขาย ' || coalesce(p.customer_label, (select label from dining_tables where id = p.table_id), 'บิล'));
  perform acct_line(v_entry, case when coalesce(p.payment_method, 'cash') = 'cash' then 'cash' else 'bank' end, p.total);
  perform acct_line(v_entry, 'disc_promo', v_promo);
  perform acct_line(v_entry, 'disc_points', v_points);
  perform acct_line(v_entry, 'vat_out', -(p.total - v_net_total));

  -- รายได้แยกตามบัญชีของหมวดเมนู · เศษสตางค์ลงบรรทัดที่ยอดมากที่สุด
  for r in
    select coalesce(c.revenue_account_id, acct_account(p.restaurant_id, 'rev_food')) as acc, sum(oi.quantity * oi.unit_price) as amt
    from order_items oi
    join menu_items m on m.id = oi.menu_item_id
    left join menu_categories c on c.id = m.category_id
    where oi.order_id = p.id
    group by 1
    order by 2 desc, 1
  loop
    v_n := v_n + 1;
    v_amt := case when v_gross = 0 then 0 else round(r.amt * v_f, 2) end;
    if v_n = 1 then
      v_first := r.acc; v_first_amt := v_amt;
    else
      perform acct_line_id(v_entry, r.acc, -v_amt);
    end if;
    v_rev_sum := v_rev_sum + v_amt;
  end loop;
  if v_n = 0 then
    v_first := acct_account(p.restaurant_id, 'rev_food'); v_first_amt := 0;
  end if;
  perform acct_line_id(v_entry, v_first, -(v_first_amt + v_rev_target - v_rev_sum));
  return v_entry;
end;
$$;

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
      select jsonb_agg(jsonb_build_object('name', x.name, 'options_snapshot',x.options_snapshot, 'quantity', x.qty, 'unit_price', x.unit_price, 'amount', x.amount) order by x.name)
      from (
        select m.name, oi.options_snapshot, oi.unit_price, sum(oi.quantity) as qty, sum(oi.quantity * oi.unit_price) as amount
        from order_items oi join menu_items m on m.id = oi.menu_item_id
        where oi.order_id = any (p_order_ids)
        group by m.name, oi.options_snapshot, oi.unit_price
      ) x
    ), '[]'::jsonb),
    'promotions', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.name, 'discount', d.discount) order by p.name)
      from (select promotion_id, sum(discount) as discount from order_promotions where order_id = any (p_order_ids) group by promotion_id) d
      join promotions p on p.id = d.promotion_id
    ), '[]'::jsonb),
    'service_charge',(select coalesce(sum(service_charge),0) from orders where id=any(p_order_ids)),
    'tip',(select coalesce(sum(tip),0) from orders where id=any(p_order_ids)),
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

create or replace function tax_doc_build_xml(d tax_documents, r tax_documents, p_tz text)
returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_root text := case when d.doc_type = 'CN' then 'DebitCreditNote' else 'TaxInvoice' end;
  v_issue text := to_char(d.confirmed_at at time zone p_tz, 'YYYY-MM-DD"T"HH24:MI:SS');
  v_target_net numeric := d.taxable_amount + d.exempt_amount;
  v_lines xml;
  v_body xml;
begin
  if d.doc_type = 'CN' then
    v_lines := xmlelement(name "ram:IncludedSupplyChainTradeLineItem",
      xmlelement(name "ram:AssociatedDocumentLineDocument", xmlelement(name "ram:LineID", 1)),
      xmlelement(name "ram:SpecifiedTradeProduct",
        xmlelement(name "ram:Name", left('ลดหนี้ตามเอกสารเลขที่ ' || r.doc_number || ': ' || d.credit_note_reason, 256))),
      xmlelement(name "ram:SpecifiedLineTradeAgreement",
        xmlelement(name "ram:GrossPriceProductTradePrice", xmlelement(name "ram:ChargeAmount", tax_fmt(v_target_net)))),
      xmlelement(name "ram:SpecifiedLineTradeDelivery",
        xmlelement(name "ram:BilledQuantity", xmlattributes('C62' as "unitCode"), 1)),
      xmlelement(name "ram:SpecifiedLineTradeSettlement",
        xmlelement(name "ram:SpecifiedTradeSettlementLineMonetarySummation",
          xmlelement(name "ram:NetLineTotalAmount", tax_fmt(v_target_net)))));
  else
    with source_lines as (
      select oi.id::text as line_key,coalesce(m.name,'รายการอาหาร') || coalesce((select ' · '||string_agg(x->>'name',', ') from jsonb_array_elements(oi.options_snapshot) x),'') as name,oi.quantity,round(oi.unit_price*oi.quantity,2) as gross_total
      from order_items oi left join menu_items m on m.id=oi.menu_item_id where oi.order_id=d.order_id
      union all select 'service','ค่าบริการ',1,service_charge from orders where id=d.order_id and service_charge>0
      union all select 'tip','ทิป',1,tip from orders where id=d.order_id and tip>0
    ), raw_lines as (
      select row_number() over(order by line_key) as rn,count(*) over() as cnt,name,quantity,gross_total,sum(gross_total) over() as sum_gross from source_lines
    ),
    allocated as (
      select rn, cnt, name, quantity,
             case when sum_gross > 0 then trunc(v_target_net * gross_total / sum_gross, 2) else 0 end as base_net
      from raw_lines
    ),
    final_lines as (
      select rn, name, quantity,
             case when rn = cnt
               then v_target_net - coalesce(sum(base_net) over (order by rn rows between unbounded preceding and 1 preceding), 0)
               else base_net
             end as line_total
      from allocated
    )
    select xmlagg(xmlelement(name "ram:IncludedSupplyChainTradeLineItem",
             xmlelement(name "ram:AssociatedDocumentLineDocument", xmlelement(name "ram:LineID", x.rn)),
             xmlelement(name "ram:SpecifiedTradeProduct", xmlelement(name "ram:Name", x.name)),
             xmlelement(name "ram:SpecifiedLineTradeAgreement",
               xmlelement(name "ram:GrossPriceProductTradePrice",
                 xmlelement(name "ram:ChargeAmount",
                   tax_fmt(case when x.quantity > 0 then round(x.line_total / x.quantity, 2) else 0 end)))),
             xmlelement(name "ram:SpecifiedLineTradeDelivery",
               xmlelement(name "ram:BilledQuantity", xmlattributes('C62' as "unitCode"), x.quantity)),
             xmlelement(name "ram:SpecifiedLineTradeSettlement",
               xmlelement(name "ram:SpecifiedTradeSettlementLineMonetarySummation",
                 xmlelement(name "ram:NetLineTotalAmount", tax_fmt(x.line_total)))))
           order by x.rn)
      into v_lines
    from final_lines x;
  end if;

  v_body := xmlconcat(
    xmlelement(name "rsm:ExchangedDocumentContext",
      xmlelement(name "ram:GuidelineSpecifiedDocumentContextParameter",
        xmlelement(name "ram:ID", xmlattributes('ETDA' as "schemeAgencyID", 'v2.0' as "schemeVersionID"), 'ER3-2560'))),
    xmlelement(name "rsm:ExchangedDocument",
      xmlelement(name "ram:ID", d.doc_number),
      xmlelement(name "ram:Name", case d.doc_type when 'ABB' then 'ใบกำกับภาษีอย่างย่อ'
                                                  when 'TAX' then 'ใบเสร็จรับเงิน/ใบกำกับภาษี' else 'ใบลดหนี้' end),
      xmlelement(name "ram:TypeCode", case d.doc_type when 'ABB' then 'T05' when 'TAX' then 'T03' else '81' end),
      xmlelement(name "ram:IssueDateTime", v_issue),
      case when d.doc_type = 'CN' then xmlelement(name "ram:Purpose", d.credit_note_reason) end,
      case when d.doc_type = 'CN' then xmlelement(name "ram:PurposeCode", 'CDNG99') end,
      xmlelement(name "ram:CreationDateTime", v_issue)),
    xmlelement(name "rsm:SupplyChainTradeTransaction",
      xmlelement(name "ram:ApplicableHeaderTradeAgreement",
        xmlelement(name "ram:SellerTradeParty",
          xmlelement(name "ram:Name", d.seller_name),
          xmlelement(name "ram:SpecifiedTaxRegistration",
            xmlelement(name "ram:ID", xmlattributes('TXID' as "schemeID"), d.seller_tax_id || d.seller_branch_code)),
          xmlelement(name "ram:PostalTradeAddress",
            case when d.seller_postcode is not null then xmlelement(name "ram:PostcodeCode", d.seller_postcode) end,
            xmlelement(name "ram:LineOne", d.seller_address),
            xmlelement(name "ram:CountryID", xmlattributes('3166-1 alpha-2' as "schemeID"), 'TH'))),
        case when d.buyer_name is not null then
          xmlelement(name "ram:BuyerTradeParty",
            xmlelement(name "ram:Name", d.buyer_name),
            xmlelement(name "ram:SpecifiedTaxRegistration",
              case when d.buyer_tax_id is not null
                then xmlelement(name "ram:ID", xmlattributes('TXID' as "schemeID"),
                                d.buyer_tax_id || coalesce(d.buyer_branch_code, '00000'))
                else xmlelement(name "ram:ID", xmlattributes('OTHR' as "schemeID"), 'N/A') end),
            xmlelement(name "ram:PostalTradeAddress",
              case when d.buyer_address is not null then xmlelement(name "ram:LineOne", d.buyer_address) end,
              xmlelement(name "ram:CountryID", xmlattributes('3166-1 alpha-2' as "schemeID"), 'TH')))
        end,
        case when r.id is not null then
          xmlelement(name "ram:AdditionalReferencedDocument",
            xmlelement(name "ram:IssuerAssignedID", r.doc_number),
            xmlelement(name "ram:IssueDateTime", to_char(r.confirmed_at at time zone p_tz, 'YYYY-MM-DD"T"HH24:MI:SS')),
            xmlelement(name "ram:ReferenceTypeCode", case r.doc_type when 'ABB' then 'T05' else 'T03' end))
        end),
      xmlelement(name "ram:ApplicableHeaderTradeDelivery"),
      xmlelement(name "ram:ApplicableHeaderTradeSettlement",
        xmlelement(name "ram:InvoiceCurrencyCode", xmlattributes('ISO 4217 3A' as "listID"), 'THB'),
        xmlelement(name "ram:ApplicableTradeTax",
          xmlelement(name "ram:TypeCode", 'VAT'),
          xmlelement(name "ram:CalculatedRate", tax_fmt(d.vat_rate)),
          xmlelement(name "ram:BasisAmount", tax_fmt(d.taxable_amount)),
          xmlelement(name "ram:CalculatedAmount", tax_fmt(d.vat_amount))),
        case when d.exempt_amount > 0 then
          xmlelement(name "ram:ApplicableTradeTax",
            xmlelement(name "ram:TypeCode", 'VAT'),
            xmlelement(name "ram:CalculatedRate", '0.00'),
            xmlelement(name "ram:BasisAmount", tax_fmt(d.exempt_amount)),
            xmlelement(name "ram:CalculatedAmount", '0.00'))
        end,
        xmlelement(name "ram:SpecifiedTradeSettlementHeaderMonetarySummation",
          case when d.doc_type = 'CN' then xmlelement(name "ram:OriginalInformationAmount", tax_fmt(r.total_amount)) end,
          xmlelement(name "ram:LineTotalAmount", tax_fmt(v_target_net)),
          xmlelement(name "ram:TaxBasisTotalAmount", tax_fmt(v_target_net)),
          xmlelement(name "ram:TaxTotalAmount", tax_fmt(d.vat_amount)),
          xmlelement(name "ram:GrandTotalAmount", tax_fmt(d.total_amount)))),
      v_lines));

  return '<?xml version="1.0" encoding="UTF-8"?>' || E'\n'
      || '<rsm:' || v_root || '_CrossIndustryInvoice'
      || ' xmlns:rsm="urn:etda:uncefact:data:standard:' || v_root || '_CrossIndustryInvoice:2"'
      || ' xmlns:ram="urn:etda:uncefact:data:standard:' || v_root || '_ReusableAggregateBusinessInformationEntity:2">'
      || v_body::text
      || '</rsm:' || v_root || '_CrossIndustryInvoice>';
end;
$$;

create table private.audit_log(id bigint generated always as identity primary key,restaurant_id uuid not null,created_at timestamptz not null default clock_timestamp(),actor_id uuid,action text not null,entity text not null,record_id text,details jsonb not null default '{}');
create index audit_log_restaurant_id on private.audit_log(restaurant_id,id desc);
create function audit_write() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare row_data jsonb; rid uuid; changed jsonb;
begin
 row_data:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 rid:=(row_data->>'restaurant_id')::uuid;
 if rid is null and tg_table_name='order_items' then select restaurant_id into rid from orders where id=(row_data->>'order_id')::uuid; end if;
 if rid is null then return coalesce(new,old); end if;
 if tg_op='UPDATE' then select coalesce(jsonb_agg(key),'[]') into changed from jsonb_each(row_data) where value is distinct from to_jsonb(old)->key;
 else changed:='[]'; end if;
 insert into private.audit_log(restaurant_id,actor_id,action,entity,record_id,details) values(rid,auth.uid(),lower(tg_op),tg_table_name,coalesce(row_data->>'id',row_data->>'user_id'),jsonb_build_object('changed_fields',changed));
 return coalesce(new,old);
end; $$;
do $$ declare tab text; begin
 foreach tab in array array['orders','order_items','menu_items','menu_categories','dining_tables','promotions','staff_members','members','expenses','stock_receipts','stock_counts','cashier_shifts','tax_documents','shop_settings'] loop
 execute format('create trigger audit_write after insert or update or delete on %I for each row execute function audit_write()',tab);
 end loop;
end; $$;
create function audit_events(p_restaurant_id uuid,p_before bigint default null,p_limit int default 100)
returns table(id bigint,created_at timestamptz,actor_id uuid,action text,entity text,record_id text,details jsonb)
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if not has_role(p_restaurant_id,array['owner','manager']) then raise exception 'forbidden'; end if;
 return query select a.id,a.created_at,a.actor_id,a.action,a.entity,a.record_id,a.details from private.audit_log a where a.restaurant_id=p_restaurant_id and (p_before is null or a.id<p_before) order by a.id desc limit least(greatest(p_limit,1),500);
end; $$;
revoke all on function audit_events(uuid,bigint,int) from public,anon;
grant execute on function audit_events(uuid,bigint,int) to authenticated;



-- Preserve shared promotion allocations when split bills settle separately.
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
    if exists(select 1 from orders where id=any(p_order_ids) and is_split) then
      -- Splitting freezes the allocated entitlement. Reapplying a fixed-value
      -- promotion to each child bill would spend the original discount twice.
      if (select coalesce(array_agg(distinct x order by x),'{}') from unnest(p_promotion_ids) x)
         is distinct from (select coalesce(array_agg(distinct promotion_id order by promotion_id),'{}') from order_promotions where order_id=any(p_order_ids)) then
        raise exception 'split_promotion_locked';
      end if;
    else
      perform apply_promotions(p_restaurant_id, p_order_ids, p_promotion_ids);
    end if;
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
