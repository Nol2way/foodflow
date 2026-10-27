-- 0023: สต็อกแบบร้านอาหารทะเล (น้ำหนักผันผวน ของเสียสูง ปริมาณต่อจานไม่คงที่)
--   1) วัตถุดิบ: Yield % (ส่วนที่ใช้ได้จริงหลังแกะ/ล้าง/ตัดแต่ง), เกณฑ์เตือนส่วนต่าง %, หมวด
--      สูตรอาหารกรอก "น้ำหนักสุทธิที่ใช้ได้" ระบบตัดน้ำหนักดิบ = สุทธิ x 100 / yield%
--   2) ของเตรียม / สูตรย่อย (เช่น น้ำจิ้มซีฟู้ด): ผลิตทีละถัง -> ตัดส่วนผสม (มะนาว พริก กระเทียม)
--      แล้วเพิ่มสต็อกน้ำจิ้ม · ขายอาหาร -> ตัดน้ำจิ้มตามกรัมต่อถ้วย
--   3) ใบรับของ (Receiving): ผู้ขาย เลขบิล หลายรายการ -> เพิ่มสต็อก + ต้นทุนเฉลี่ยถ่วงน้ำหนัก (+ บันทึกรายจ่าย)
--   4) ของเสียแยกประเภท (เน่า/เสีย, ตัดแต่ง, ตกหล่น, ลูกค้าคืน, หมดอายุ)
--   5) ขายตามน้ำหนักจริง (ปู/ปลาสดหน้าตู้): ชั่งแล้วคีย์น้ำหนัก ราคา = ราคาต่อ กก. x น้ำหนัก ตัดสต็อกตามน้ำหนักจริง
--   6) รายงานส่วนต่างชุดใหญ่ (Mass Variance) ระหว่างใบตรวจนับ 2 ใบ (รายสัปดาห์/รายเดือน)
--      ใช้จริง = ยอดนับต้นงวด + รับเข้า + ผลิตได้ - ยอดนับปลายงวด
--      ตามทฤษฎี = ยอดขายใน POS ย้อนกลับเป็นวัตถุดิบตามสูตร / yield% + ส่วนผสมที่ใช้ผลิตของเตรียม
--      ส่วนต่าง = ใช้จริง - ตามทฤษฎี · % = ส่วนต่าง / ตามทฤษฎี x 100 · เกินเกณฑ์ (ค่าเริ่มต้น ±5%) = เตือน

alter type stock_reason add value if not exists 'production';

-- ===== 1) วัตถุดิบ =====
alter table ingredients add column if not exists yield_pct numeric(5,2) not null default 100
  check (yield_pct > 0 and yield_pct <= 100);
alter table ingredients add column if not exists variance_threshold_pct numeric(5,2) not null default 5
  check (variance_threshold_pct >= 0 and variance_threshold_pct <= 100);
alter table ingredients add column if not exists category text check (char_length(category) <= 40);
alter table ingredients add column if not exists is_prep boolean not null default false;          -- ของเตรียม/สูตรย่อย
alter table ingredients add column if not exists batch_output_qty numeric(12,3) check (batch_output_qty > 0); -- ผลิต 1 ถังได้เท่าไร
grant update (yield_pct, variance_threshold_pct, category, is_prep, batch_output_qty) on ingredients to authenticated;

-- แปลงกรัมเป็นหน่วยของวัตถุดิบ (ใช้กับของขายตามน้ำหนัก) · หน่วยอื่นคืน null
create or replace function grams_to_unit(p_unit text)
returns numeric
language sql immutable set search_path = public, pg_temp as $$
  select case
    when lower(trim(p_unit)) in ('g', 'gram', 'grams', 'กรัม') then 1::numeric
    when lower(trim(p_unit)) in ('kg', 'kilogram', 'กก', 'กก.', 'กิโลกรัม', 'กิโล') then 0.001::numeric
  end;
$$;

-- ต้นทุนต่อเมนู: คิดจากน้ำหนักดิบ (สุทธิ / yield%)
create or replace view menu_item_costs with (security_invoker = true) as
select m.id as menu_item_id,
       m.restaurant_id,
       m.name,
       m.price,
       coalesce(sum(r.quantity_used * 100 / i.yield_pct * i.cost_per_unit), 0)::numeric(12,2) as unit_cost,
       count(r.ingredient_id) as ingredient_count
from menu_items m
left join recipes r on r.menu_item_id = m.id
left join ingredients i on i.id = r.ingredient_id
group by m.id;

-- ===== 2) ของเตรียม / สูตรย่อย =====
create table if not exists prep_components (
  prep_id uuid not null references ingredients(id) on delete cascade,
  ingredient_id uuid not null references ingredients(id) on delete cascade,
  quantity numeric(12,3) not null check (quantity > 0),   -- ปริมาณสุทธิต่อ 1 ถัง (batch)
  primary key (prep_id, ingredient_id),
  check (prep_id <> ingredient_id)
);

create table if not exists prep_batches (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  prep_id uuid not null references ingredients(id) on delete cascade,
  output_qty numeric(12,3) not null check (output_qty > 0),
  note text check (char_length(note) <= 200),
  produced_by uuid references app_users(id) on delete set null,
  produced_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists prep_batches_restaurant_idx on prep_batches (restaurant_id, created_at);

alter table prep_components enable row level security;
alter table prep_batches enable row level security;

drop policy if exists prep_components_read on prep_components;
create policy prep_components_read on prep_components for select
  using (exists (
    select 1 from ingredients p
    where p.id = prep_id and has_role(p.restaurant_id, array['owner', 'stock', 'accountant', 'kitchen'])
  ));
drop policy if exists prep_components_write on prep_components;
create policy prep_components_write on prep_components for all
  using (exists (select 1 from ingredients p where p.id = prep_id and has_role(p.restaurant_id, array['owner', 'stock'])))
  with check (exists (
    select 1 from ingredients p join ingredients c on c.restaurant_id = p.restaurant_id
    where p.id = prep_id and c.id = ingredient_id and p.is_prep and has_role(p.restaurant_id, array['owner', 'stock'])
  ));

drop policy if exists prep_batches_read on prep_batches;
create policy prep_batches_read on prep_batches for select
  using (has_role(restaurant_id, array['owner', 'stock', 'accountant', 'kitchen']));
revoke insert, update, delete on prep_batches from anon, authenticated;

alter table stock_movements add column if not exists batch_id uuid references prep_batches(id) on delete set null;

-- ผลิตของเตรียม: ตัดส่วนผสมตามสัดส่วน (ปริมาณสุทธิ / yield%) แล้วเพิ่มสต็อกของเตรียม
-- ส่วนผสมในระบบไม่พอ ตัดเท่าที่มี (ของถูกทำไปแล้วจริง) รายงานส่วนต่างจะเห็นเอง
create or replace function produce_prep(p_prep_id uuid, p_output_qty numeric, p_note text default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prep ingredients;
  v_id uuid;
  v_name text;
  c record;
  v_need numeric;
begin
  select * into v_prep from ingredients where id = p_prep_id;
  if v_prep.id is null or not v_prep.is_prep then
    raise exception 'invalid_prep';
  end if;
  if not has_role(v_prep.restaurant_id, array['owner', 'stock', 'kitchen']) then
    raise exception 'forbidden';
  end if;
  if p_output_qty is null or p_output_qty <= 0 or p_output_qty > 1000000 then
    raise exception 'invalid_quantity';
  end if;
  if v_prep.batch_output_qty is null then
    raise exception 'batch_output_not_set';
  end if;
  if not exists (select 1 from prep_components where prep_id = p_prep_id) then
    raise exception 'no_components';
  end if;

  select coalesce(display_name, email) into v_name from app_users where id = auth.uid();
  insert into prep_batches (restaurant_id, prep_id, output_qty, note, produced_by, produced_by_name)
  values (v_prep.restaurant_id, p_prep_id, round(p_output_qty, 3), nullif(left(trim(p_note), 200), ''), auth.uid(), v_name)
  returning id into v_id;

  for c in
    select i.id, i.quantity_on_hand, pc.quantity * p_output_qty / v_prep.batch_output_qty * 100 / i.yield_pct as need
    from prep_components pc join ingredients i on i.id = pc.ingredient_id
    where pc.prep_id = p_prep_id
    for update of i
  loop
    v_need := least(round(c.need, 3), c.quantity_on_hand);
    if v_need > 0 then
      insert into stock_movements (restaurant_id, ingredient_id, change, reason, note, batch_id)
      values (v_prep.restaurant_id, c.id, -v_need, 'production', 'ใช้ผลิต ' || v_prep.name, v_id);
    end if;
  end loop;

  insert into stock_movements (restaurant_id, ingredient_id, change, reason, note, batch_id)
  values (v_prep.restaurant_id, p_prep_id, round(p_output_qty, 3), 'production', 'ผลิตได้', v_id);
  return v_id;
end;
$$;
revoke execute on function produce_prep(uuid, numeric, text) from public, anon;
grant execute on function produce_prep(uuid, numeric, text) to authenticated;

-- ===== 3) ใบรับของ =====
create table if not exists stock_receipts (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  supplier text check (char_length(supplier) <= 100),
  invoice_no text check (char_length(invoice_no) <= 50),
  received_on date not null default current_date,
  note text check (char_length(note) <= 300),
  item_count int not null default 0,
  total_cost numeric(12,2) not null default 0,
  expense_id uuid references expenses(id) on delete set null,
  received_by uuid references app_users(id) on delete set null,
  received_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists stock_receipts_restaurant_idx on stock_receipts (restaurant_id, created_at desc);

create table if not exists stock_receipt_lines (
  receipt_id uuid not null references stock_receipts(id) on delete cascade,
  ingredient_id uuid not null references ingredients(id) on delete cascade,
  ingredient_name text not null,
  unit text not null,
  quantity numeric(12,3) not null check (quantity > 0),
  unit_cost numeric(12,4) not null check (unit_cost >= 0),
  line_total numeric(12,2) not null,
  primary key (receipt_id, ingredient_id)
);

alter table stock_receipts enable row level security;
alter table stock_receipt_lines enable row level security;
drop policy if exists stock_receipts_read on stock_receipts;
create policy stock_receipts_read on stock_receipts for select
  using (has_role(restaurant_id, array['owner', 'stock', 'accountant']));
drop policy if exists stock_receipt_lines_read on stock_receipt_lines;
create policy stock_receipt_lines_read on stock_receipt_lines for select
  using (exists (
    select 1 from stock_receipts r where r.id = receipt_id and has_role(r.restaurant_id, array['owner', 'stock', 'accountant'])
  ));
revoke insert, update, delete on stock_receipts, stock_receipt_lines from anon, authenticated;

alter table stock_movements add column if not exists receipt_id uuid references stock_receipts(id) on delete set null;

-- p_lines: [{ "ingredient_id": "...", "quantity": 12.5, "unit_cost": 320 }, ...]
-- ต้นทุนต่อหน่วยใหม่ = (คงเหลือ x ต้นทุนเดิม + รับเข้า x ราคาใหม่) / (คงเหลือ + รับเข้า)
create or replace function submit_stock_receipt(
  p_restaurant_id uuid,
  p_lines jsonb,
  p_supplier text default null,
  p_invoice_no text default null,
  p_received_on date default null,
  p_note text default null,
  p_record_expense boolean default true
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_name text;
  l record;
  v_total numeric := 0;
  v_items int := 0;
  v_expense uuid;
  v_label text;
begin
  if not has_role(p_restaurant_id, array['owner', 'stock']) then
    raise exception 'forbidden';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'no_lines';
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'too_many_lines';
  end if;
  if (select count(*) from jsonb_array_elements(p_lines) e)
     <> (select count(distinct e->>'ingredient_id') from jsonb_array_elements(p_lines) e) then
    raise exception 'duplicate_ingredient';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) e
    where not exists (select 1 from ingredients i where i.id = (e->>'ingredient_id')::uuid and i.restaurant_id = p_restaurant_id)
  ) then
    raise exception 'invalid_ingredient';
  end if;
  if p_received_on is not null and p_received_on > current_date + 1 then
    raise exception 'invalid_date';
  end if;

  select coalesce(display_name, email) into v_name from app_users where id = auth.uid();
  insert into stock_receipts (restaurant_id, supplier, invoice_no, received_on, note, received_by, received_by_name)
  values (p_restaurant_id, nullif(left(trim(p_supplier), 100), ''), nullif(left(trim(p_invoice_no), 50), ''),
          coalesce(p_received_on, current_date), nullif(left(trim(p_note), 300), ''), auth.uid(), v_name)
  returning id into v_id;
  v_label := 'รับของ' || coalesce(' ' || nullif(trim(p_supplier), ''), '') || coalesce(' บิล ' || nullif(trim(p_invoice_no), ''), '');

  for l in
    select i.id, i.name, i.unit, i.quantity_on_hand, i.cost_per_unit,
           (e->>'quantity')::numeric as qty, (e->>'unit_cost')::numeric as cost
    from jsonb_array_elements(p_lines) e
    join ingredients i on i.id = (e->>'ingredient_id')::uuid and i.restaurant_id = p_restaurant_id
    order by i.name
    for update of i
  loop
    if l.qty is null or l.qty <= 0 or l.qty > 1000000 then raise exception 'invalid_quantity'; end if;
    if l.cost is null or l.cost < 0 then raise exception 'invalid_cost'; end if;

    insert into stock_receipt_lines (receipt_id, ingredient_id, ingredient_name, unit, quantity, unit_cost, line_total)
    values (v_id, l.id, l.name, l.unit, round(l.qty, 3), round(l.cost, 4), round(l.qty * l.cost, 2));

    update ingredients
       set cost_per_unit = round((l.quantity_on_hand * l.cost_per_unit + l.qty * l.cost) / (l.quantity_on_hand + l.qty), 4)
     where id = l.id;

    insert into stock_movements (restaurant_id, ingredient_id, change, reason, note, receipt_id)
    values (p_restaurant_id, l.id, round(l.qty, 3), 'purchase', v_label, v_id);

    v_total := v_total + round(l.qty * l.cost, 2);
    v_items := v_items + 1;
  end loop;

  if p_record_expense and v_total > 0 then
    insert into expenses (restaurant_id, category, amount, spent_on, note)
    values (p_restaurant_id, 'ingredients', v_total, coalesce(p_received_on, current_date), left(v_label, 200))
    returning id into v_expense;
  end if;

  update stock_receipts set item_count = v_items, total_cost = v_total, expense_id = v_expense where id = v_id;
  return v_id;
end;
$$;
revoke execute on function submit_stock_receipt(uuid, jsonb, text, text, date, text, boolean) from public, anon;
grant execute on function submit_stock_receipt(uuid, jsonb, text, text, date, text, boolean) to authenticated;

-- ===== 4) ของเสียแยกประเภท =====
alter table stock_movements add column if not exists waste_type text
  check (waste_type in ('spoiled', 'trim', 'dropped', 'returned', 'expired', 'other'));
alter table stock_movements drop constraint if exists stock_movements_waste_type_reason;
alter table stock_movements add constraint stock_movements_waste_type_reason
  check (waste_type is null or reason = 'waste');

-- ===== 5) ขายตามน้ำหนักจริง =====
alter table menu_items add column if not exists sold_by_weight boolean not null default false;  -- price = ราคาต่อ 1 กก.
alter table menu_items add column if not exists weight_ingredient_id uuid references ingredients(id) on delete set null;
alter table order_items add column if not exists weight_g numeric(10,1) check (weight_g > 0 and weight_g <= 100000);

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
  v_weight numeric;
  v_price numeric(10,2);
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

    insert into order_items (order_id, menu_item_id, quantity, unit_price, note, weight_g)
    values (v_order, v_menu.id, v_qty, v_price, nullif(left(trim(v_item->>'note'), 200), ''), v_weight);

    v_subtotal := v_subtotal + v_price * v_qty;
  end loop;

  update orders set subtotal = v_subtotal, discount_total = 0, total = v_subtotal where id = v_order;
  if coalesce(cardinality(p_promotion_ids), 0) > 0 then
    perform apply_promotions(p_restaurant_id, array[v_order], p_promotion_ids);
  end if;
  return v_order;
end;
$$;

-- ===== 6) ตัดสต็อกเมื่อครัวเริ่มทำ: น้ำหนักดิบตามสูตร (/ yield%) + น้ำหนักจริงของของชั่งขาย =====
create or replace function order_ingredient_need(p_order_id uuid, p_restaurant_id uuid)
returns table (ingredient_id uuid, qty numeric)
language sql stable set search_path = public, pg_temp as $$
  select ingredient_id, sum(qty) from (
    select r.ingredient_id, r.quantity_used * oi.quantity * 100 / i.yield_pct as qty
    from order_items oi
    join recipes r on r.menu_item_id = oi.menu_item_id
    join ingredients i on i.id = r.ingredient_id and i.restaurant_id = p_restaurant_id
    where oi.order_id = p_order_id
    union all
    select m.weight_ingredient_id, oi.weight_g * grams_to_unit(i.unit)
    from order_items oi
    join menu_items m on m.id = oi.menu_item_id and m.sold_by_weight
    join ingredients i on i.id = m.weight_ingredient_id and i.restaurant_id = p_restaurant_id
    where oi.order_id = p_order_id and oi.weight_g is not null and grams_to_unit(i.unit) is not null
  ) x
  group by ingredient_id;
$$;

create or replace function deduct_stock_for_order()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.stock_deducted_at is null
     and new.status in ('preparing', 'ready', 'served', 'paid') then
    insert into stock_movements (restaurant_id, ingredient_id, change, reason, order_id)
    select new.restaurant_id, n.ingredient_id, -least(round(n.qty, 3), i.quantity_on_hand), 'sale'::stock_reason, new.id
    from order_ingredient_need(new.id, new.restaurant_id) n
    join ingredients i on i.id = n.ingredient_id
    where least(round(n.qty, 3), i.quantity_on_hand) > 0;

    new.stock_deducted_at := now();
  end if;
  return new;
end;
$$;

-- ===== 7) รายงานส่วนต่างชุดใหญ่ (Mass Variance) =====
-- การใช้ตามทฤษฎีในช่วงเวลา: ย้อนจากออเดอร์ที่ครัวเริ่มทำ (ตามสูตรปัจจุบัน ไม่จำกัดด้วยสต็อกที่มี)
-- + ส่วนผสมที่ควรใช้ผลิตของเตรียมในช่วงนั้น
create or replace function theoretical_usage(p_restaurant_id uuid, p_from timestamptz, p_to timestamptz)
returns table (ingredient_id uuid, sales_qty numeric, production_qty numeric)
language sql stable set search_path = public, pg_temp as $$
  select ingredient_id, sum(s), sum(p) from (
    select n.ingredient_id, n.qty as s, 0::numeric as p
    from orders o
    cross join lateral order_ingredient_need(o.id, o.restaurant_id) n
    where o.restaurant_id = p_restaurant_id and o.stock_deducted_at > p_from and o.stock_deducted_at <= p_to
    union all
    select pc.ingredient_id, 0, pc.quantity * b.output_qty / pi.batch_output_qty * 100 / i.yield_pct
    from prep_batches b
    join ingredients pi on pi.id = b.prep_id and pi.batch_output_qty is not null
    join prep_components pc on pc.prep_id = b.prep_id
    join ingredients i on i.id = pc.ingredient_id
    where b.restaurant_id = p_restaurant_id and b.created_at > p_from and b.created_at <= p_to
  ) x
  group by ingredient_id;
$$;

create or replace function stock_variance(p_restaurant_id uuid, p_start_count uuid, p_end_count uuid)
returns table (
  ingredient_id uuid,
  ingredient_name text,
  unit text,
  category text,
  is_prep boolean,
  yield_pct numeric,
  threshold_pct numeric,
  unit_cost numeric,
  opening numeric,
  purchased numeric,
  produced numeric,
  closing numeric,
  actual_usage numeric,
  sales_usage numeric,
  production_usage numeric,
  theoretical_usage numeric,
  recorded_waste numeric,
  variance numeric,
  variance_pct numeric,
  variance_value numeric,
  unexplained numeric,
  status text
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_from timestamptz;
  v_to timestamptz;
begin
  if not has_role(p_restaurant_id, array['owner', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;
  select created_at into v_from from stock_counts where id = p_start_count and restaurant_id = p_restaurant_id;
  select created_at into v_to from stock_counts where id = p_end_count and restaurant_id = p_restaurant_id;
  if v_from is null or v_to is null then
    raise exception 'invalid_count';
  end if;
  if v_from >= v_to then
    raise exception 'start_after_end';
  end if;

  return query
  with mv as (
    select m.ingredient_id,
           coalesce(sum(m.change) filter (where m.reason = 'purchase'), 0) as purchased,
           coalesce(sum(m.change) filter (where m.reason = 'production' and m.change > 0), 0) as produced,
           coalesce(-sum(m.change) filter (where m.reason = 'waste'), 0) as waste
    from stock_movements m
    where m.restaurant_id = p_restaurant_id and m.created_at > v_from and m.created_at <= v_to
    group by m.ingredient_id
  ),
  th as (select * from theoretical_usage(p_restaurant_id, v_from, v_to)),
  base as (
    select i.id, i.name, i.unit, i.category, i.is_prep, i.yield_pct, i.variance_threshold_pct, i.cost_per_unit,
           s.counted_qty as opening, e.counted_qty as closing,
           coalesce(mv.purchased, 0) as purchased, coalesce(mv.produced, 0) as produced, coalesce(mv.waste, 0) as waste,
           coalesce(th.sales_qty, 0) as sales, coalesce(th.production_qty, 0) as prod_use
    from stock_count_lines s
    join stock_count_lines e on e.ingredient_id = s.ingredient_id and e.count_id = p_end_count
    join ingredients i on i.id = s.ingredient_id
    left join mv on mv.ingredient_id = i.id
    left join th on th.ingredient_id = i.id
    where s.count_id = p_start_count
  ),
  calc as (
    select b.*,
           b.opening + b.purchased + b.produced - b.closing as actual,
           b.sales + b.prod_use as theory
    from base b
  )
  select c.id, c.name, c.unit, c.category, c.is_prep, c.yield_pct, c.variance_threshold_pct, c.cost_per_unit,
         c.opening, round(c.purchased, 3), round(c.produced, 3), c.closing,
         round(c.actual, 3), round(c.sales, 3), round(c.prod_use, 3), round(c.theory, 3), round(c.waste, 3),
         round(c.actual - c.theory, 3),
         case when c.theory > 0 then round((c.actual - c.theory) / c.theory * 100, 2) end,
         round((c.actual - c.theory) * c.cost_per_unit, 2),
         round(c.actual - c.theory - c.waste, 3),
         case
           when round(c.theory, 3) = 0 and round(c.actual, 3) = 0 then 'no_usage'
           when round(c.theory, 3) = 0 then 'alert'
           when abs((c.actual - c.theory) / c.theory * 100) > c.variance_threshold_pct then 'alert'
           else 'ok'
         end
  from calc c
  order by abs((c.actual - c.theory) * c.cost_per_unit) desc, c.name;
end;
$$;

revoke execute on function theoretical_usage(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function order_ingredient_need(uuid, uuid) from public, anon, authenticated;
revoke execute on function stock_variance(uuid, uuid, uuid) from public, anon;
grant execute on function stock_variance(uuid, uuid, uuid) to authenticated;

-- ===== 8) ประวัติสต็อก: เพิ่มประเภทของเสีย (เปลี่ยนชนิดผลลัพธ์ ต้องสร้างใหม่) =====
drop function if exists stock_history(uuid, timestamptz, timestamptz, uuid, stock_reason, int);
create function stock_history(
  p_restaurant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_ingredient_id uuid default null,
  p_reason stock_reason default null,
  p_limit int default 200
)
returns table (
  id uuid,
  created_at timestamptz,
  ingredient_id uuid,
  ingredient_name text,
  unit text,
  change numeric,
  reason stock_reason,
  balance_after numeric,
  cost numeric,
  note text,
  actor_email text,
  order_id uuid,
  order_label text,
  waste_type text
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;

  return query
  select sm.id, sm.created_at, sm.ingredient_id, i.name, i.unit, sm.change, sm.reason, sm.balance_after,
         round(abs(sm.change) * i.cost_per_unit, 2),
         sm.note, coalesce(u.display_name, u.email), sm.order_id,
         case
           when o.id is null then null
           when o.order_type = 'takeaway' then coalesce('กลับบ้าน · ' || o.customer_label, 'กลับบ้าน')
           else coalesce(t.label, 'ไม่ระบุโต๊ะ')
         end,
         sm.waste_type
  from stock_movements sm
  join ingredients i on i.id = sm.ingredient_id
  left join app_users u on u.id = sm.created_by
  left join orders o on o.id = sm.order_id
  left join dining_tables t on t.id = o.table_id
  where sm.restaurant_id = p_restaurant_id
    and sm.created_at >= p_from and sm.created_at < p_to
    and (p_ingredient_id is null or sm.ingredient_id = p_ingredient_id)
    and (p_reason is null or sm.reason = p_reason)
  order by sm.created_at desc, sm.id
  limit least(greatest(p_limit, 1), 1000);
end;
$$;
revoke execute on function stock_history(uuid, timestamptz, timestamptz, uuid, stock_reason, int) from public, anon;
grant execute on function stock_history(uuid, timestamptz, timestamptz, uuid, stock_reason, int) to authenticated;
