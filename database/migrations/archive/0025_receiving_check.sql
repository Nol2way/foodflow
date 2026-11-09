-- 0025: แยกการนับสต็อก 2 แบบ
--   แบบที่ 1 นับตอนรับเข้า (ใบรับของ = Goods Received Note เทียบบิล)
--     - แต่ละบรรทัด: ตามบิล (จำนวน/หน่วยบนบิล) เทียบ รับจริง (ชั่ง/นับเอง)
--     - อาหารทะเลแช่แข็ง: น้ำหนักรวม (มีน้ำแข็ง) และน้ำหนักสุทธิหลังละลายน้ำแข็ง -> % น้ำแข็ง (glaze)
--     - สต็อกเพิ่มตาม "รับจริง" · ต้นทุน = รับจริง x ราคาต่อหน่วยในบิล
--     - ขาดเกินเกณฑ์ (ค่าเริ่มต้น ±2%) = ขาด/เกิน · รับจริง 0 = ตีกลับ · ส่วนที่ขาดเป็นยอด "รอทวง" ติดตามจนได้ลดหนี้
--   แบบที่ 2 นับตอนนับล่าสุด (ใบตรวจนับ): รายสัปดาห์ (เฉพาะวัตถุดิบที่ติ๊กนับทุกสัปดาห์) / รายเดือน (ทั้งหมด)
--   + รายงานผู้ขาย และสรุป "รับเข้าล่าสุด / นับล่าสุด" ต่อวัตถุดิบ

-- ===== 1) ตั้งค่า =====
alter table shop_settings add column if not exists receive_tolerance_pct numeric(5,2) not null default 2
  check (receive_tolerance_pct >= 0 and receive_tolerance_pct <= 50);
alter table shop_settings add column if not exists glaze_max_pct numeric(5,2) not null default 12
  check (glaze_max_pct >= 0 and glaze_max_pct <= 60);
alter table ingredients add column if not exists count_weekly boolean not null default false;  -- รายการสำคัญ นับทุกสัปดาห์
grant update (count_weekly) on ingredients to authenticated;

-- ===== 2) ใบรับของ: ตามบิล vs รับจริง =====
alter table stock_receipt_lines alter column quantity drop not null;
alter table stock_receipt_lines drop constraint if exists stock_receipt_lines_quantity_check;
alter table stock_receipt_lines add constraint stock_receipt_lines_quantity_check check (quantity >= 0);
alter table stock_receipt_lines add column if not exists invoice_qty numeric(12,3) check (invoice_qty >= 0);   -- ตามบิล (หน่วยหลัก)
alter table stock_receipt_lines add column if not exists invoice_unit text;                                    -- หน่วยบนบิล เช่น ลัง
alter table stock_receipt_lines add column if not exists invoice_unit_qty numeric(12,3);                       -- จำนวนบนบิล เช่น 3
alter table stock_receipt_lines add column if not exists gross_qty numeric(12,3) check (gross_qty >= 0);       -- น้ำหนักรวมก่อนละลายน้ำแข็ง
alter table stock_receipt_lines add column if not exists status text not null default 'ok'
  check (status in ('ok', 'short', 'over', 'rejected'));
alter table stock_receipt_lines add column if not exists claim_value numeric(12,2) not null default 0;        -- มูลค่าที่ขาด (รอทวง)
alter table stock_receipt_lines add column if not exists claim_status text not null default 'none'
  check (claim_status in ('none', 'pending', 'credited', 'accepted'));
alter table stock_receipt_lines add column if not exists prev_unit_cost numeric(12,4);                        -- ราคาครั้งก่อน (ผู้ขายเดิม)
alter table stock_receipt_lines add column if not exists line_note text check (char_length(line_note) <= 200);

alter table stock_receipts add column if not exists invoice_total numeric(12,2) not null default 0;   -- ยอดตามบิล
alter table stock_receipts add column if not exists claim_total numeric(12,2) not null default 0;     -- รอทวงที่ยังไม่จบ

-- ใบเก่าก่อน 0025: ถือว่าตามบิล = รับจริง
update stock_receipt_lines set invoice_qty = quantity where invoice_qty is null;
update stock_receipts set invoice_total = total_cost where invoice_total = 0 and total_cost > 0;

-- p_lines: [{
--   "ingredient_id": "...",
--   "quantity": 25.4,            รับจริง (หน่วยหลัก สุทธิ) · 0 = ตีกลับทั้งบรรทัด
--   "unit_cost": 40,             ราคาต่อหน่วยหลักตามบิล
--   "invoice_qty": 30,           ตามบิล (หน่วยหลัก) ไม่ส่ง = เท่ารับจริง
--   "invoice_unit": "ลัง", "invoice_unit_qty": 3,      หน่วย/จำนวนบนบิล (ไม่บังคับ)
--   "gross_qty": 30.2,           น้ำหนักรวมก่อนละลายน้ำแข็ง (ไม่บังคับ)
--   "entered_unit": ..., "entered_qty": ..., "entered_unit_cost": ...,   ที่กรอกจริง (0024)
--   "note": "ลังบุบ 1 ลัง"
-- }]
-- ยอดตามบิลบันทึกเป็นรายจ่าย (จ่ายตามบิล) ได้ลดหนี้ภายหลัง -> หักออกจากรายจ่ายให้
drop function if exists submit_stock_receipt(uuid, jsonb, text, text, date, text, boolean);
create function submit_stock_receipt(
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
  v_tol numeric;
  v_received_total numeric := 0;
  v_invoice_total numeric := 0;
  v_claim_total numeric := 0;
  v_items int := 0;
  v_expense uuid;
  v_label text;
  v_supplier text := nullif(left(trim(p_supplier), 100), '');
  v_inv numeric;
  v_status text;
  v_claim numeric;
  v_prev numeric;
  v_diff_unit boolean;
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

  select coalesce((select receive_tolerance_pct from shop_settings where restaurant_id = p_restaurant_id), 2) into v_tol;
  select coalesce(display_name, email) into v_name from app_users where id = auth.uid();
  insert into stock_receipts (restaurant_id, supplier, invoice_no, received_on, note, received_by, received_by_name)
  values (p_restaurant_id, v_supplier, nullif(left(trim(p_invoice_no), 50), ''),
          coalesce(p_received_on, current_date), nullif(left(trim(p_note), 300), ''), auth.uid(), v_name)
  returning id into v_id;
  v_label := 'รับของ' || coalesce(' ' || v_supplier, '') || coalesce(' บิล ' || nullif(trim(p_invoice_no), ''), '');

  for l in
    select i.id, i.name, i.unit, i.quantity_on_hand, i.cost_per_unit,
           (e->>'quantity')::numeric as qty, (e->>'unit_cost')::numeric as cost,
           (e->>'invoice_qty')::numeric as inv_qty,
           nullif(left(trim(e->>'invoice_unit'), 30), '') as inv_unit,
           (e->>'invoice_unit_qty')::numeric as inv_unit_qty,
           (e->>'gross_qty')::numeric as gross,
           nullif(left(trim(e->>'entered_unit'), 30), '') as e_unit,
           (e->>'entered_qty')::numeric as e_qty, (e->>'entered_unit_cost')::numeric as e_cost,
           nullif(left(trim(e->>'note'), 200), '') as line_note
    from jsonb_array_elements(p_lines) e
    join ingredients i on i.id = (e->>'ingredient_id')::uuid and i.restaurant_id = p_restaurant_id
    order by i.name
    for update of i
  loop
    if l.qty is null or l.qty < 0 or l.qty > 1000000 then raise exception 'invalid_quantity'; end if;
    if l.cost is null or l.cost < 0 then raise exception 'invalid_cost'; end if;
    if l.inv_qty is not null and (l.inv_qty < 0 or l.inv_qty > 1000000) then raise exception 'invalid_quantity'; end if;
    if l.gross is not null and l.gross < l.qty then raise exception 'gross_less_than_net: %', l.name; end if;
    v_inv := coalesce(l.inv_qty, l.qty);
    if v_inv = 0 and l.qty = 0 then raise exception 'invalid_quantity'; end if;

    -- ผลตรวจรับ: ห่างจากบิลเกินเกณฑ์ % = ขาด/เกิน · รับ 0 = ตีกลับ
    v_status := case
      when l.qty = 0 then 'rejected'
      when l.qty < v_inv * (1 - v_tol / 100) then 'short'
      when l.qty > v_inv * (1 + v_tol / 100) then 'over'
      else 'ok'
    end;
    v_claim := case when v_status in ('short', 'rejected') then round((v_inv - l.qty) * l.cost, 2) else 0 end;

    select rl.unit_cost into v_prev
    from stock_receipt_lines rl join stock_receipts r on r.id = rl.receipt_id
    where rl.ingredient_id = l.id and r.id <> v_id and r.restaurant_id = p_restaurant_id
      and (v_supplier is null or r.supplier = v_supplier)
    order by r.created_at desc limit 1;

    v_diff_unit := l.e_unit is not null and l.e_unit <> l.unit;
    insert into stock_receipt_lines (receipt_id, ingredient_id, ingredient_name, unit, quantity, unit_cost, line_total,
                                     entered_unit, entered_qty, entered_unit_cost,
                                     invoice_qty, invoice_unit, invoice_unit_qty, gross_qty,
                                     status, claim_value, claim_status, prev_unit_cost, line_note)
    values (v_id, l.id, l.name, l.unit, round(l.qty, 3), round(l.cost, 4), round(l.qty * l.cost, 2),
            case when v_diff_unit then l.e_unit end, case when v_diff_unit then round(l.e_qty, 3) end,
            case when v_diff_unit then round(l.e_cost, 4) end,
            round(v_inv, 3), l.inv_unit, round(l.inv_unit_qty, 3), round(l.gross, 3),
            v_status, v_claim, case when v_claim > 0 then 'pending' else 'none' end, v_prev, l.line_note);

    if l.qty > 0 then
      update ingredients
         set cost_per_unit = round((l.quantity_on_hand * l.cost_per_unit + l.qty * l.cost) / (l.quantity_on_hand + l.qty), 4)
       where id = l.id;
      insert into stock_movements (restaurant_id, ingredient_id, change, reason, note, receipt_id)
      values (p_restaurant_id, l.id, round(l.qty, 3), 'purchase', v_label, v_id);
    end if;

    v_received_total := v_received_total + round(l.qty * l.cost, 2);
    v_invoice_total := v_invoice_total + round(v_inv * l.cost, 2);
    v_claim_total := v_claim_total + v_claim;
    v_items := v_items + 1;
  end loop;

  if p_record_expense and v_invoice_total > 0 then
    insert into expenses (restaurant_id, category, amount, spent_on, note)
    values (p_restaurant_id, 'ingredients', v_invoice_total, coalesce(p_received_on, current_date), left(v_label, 200))
    returning id into v_expense;
  end if;

  update stock_receipts
     set item_count = v_items, total_cost = v_received_total, invoice_total = v_invoice_total,
         claim_total = v_claim_total, expense_id = v_expense
   where id = v_id;
  return v_id;
end;
$$;
revoke execute on function submit_stock_receipt(uuid, jsonb, text, text, date, text, boolean) from public, anon;
grant execute on function submit_stock_receipt(uuid, jsonb, text, text, date, text, boolean) to authenticated;

-- ติดตามยอดที่ขาด: pending (รอทวง) -> credited (ได้ลดหนี้) / accepted (ยอมรับ ไม่ทวง)
-- ได้ลดหนี้: หักมูลค่าออกจากรายจ่ายของใบนั้น (ถ้าบันทึกรายจ่ายไว้)
create or replace function set_receipt_claim(p_receipt_id uuid, p_ingredient_id uuid, p_status text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rid uuid;
  v_expense uuid;
  v_invoice numeric;
begin
  select restaurant_id, expense_id, invoice_total into v_rid, v_expense, v_invoice from stock_receipts where id = p_receipt_id;
  if v_rid is null or not has_role(v_rid, array['owner', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;
  if p_status not in ('pending', 'credited', 'accepted') then
    raise exception 'invalid_status';
  end if;
  update stock_receipt_lines set claim_status = p_status
   where receipt_id = p_receipt_id and ingredient_id = p_ingredient_id and claim_value > 0;
  if not found then
    raise exception 'not_found';
  end if;
  update stock_receipts
     set claim_total = (select coalesce(sum(claim_value), 0) from stock_receipt_lines where receipt_id = p_receipt_id and claim_status = 'pending')
   where id = p_receipt_id;
  if v_expense is not null then
    update expenses
       set amount = v_invoice - (select coalesce(sum(claim_value), 0) from stock_receipt_lines where receipt_id = p_receipt_id and claim_status = 'credited')
     where id = v_expense;
  end if;
end;
$$;
revoke execute on function set_receipt_claim(uuid, uuid, text) from public, anon;
grant execute on function set_receipt_claim(uuid, uuid, text) to authenticated;

-- ===== 3) ใบตรวจนับ: รายสัปดาห์ / รายเดือน =====
alter table stock_counts add column if not exists count_type text not null default 'spot'
  check (count_type in ('weekly', 'monthly', 'spot'));

drop function if exists submit_stock_count(uuid, jsonb, text);
create function submit_stock_count(p_restaurant_id uuid, p_lines jsonb, p_note text default null, p_count_type text default 'spot')
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_name text;
  l record;
  v_items int := 0;
  v_diffs int := 0;
  v_value numeric := 0;
begin
  if not has_role(p_restaurant_id, array['owner', 'stock']) then
    raise exception 'forbidden';
  end if;
  if coalesce(p_count_type, 'spot') not in ('weekly', 'monthly', 'spot') then
    raise exception 'invalid_count_type';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'no_lines';
  end if;
  if jsonb_array_length(p_lines) > 1000 then
    raise exception 'too_many_lines';
  end if;
  if (select count(*) from jsonb_array_elements(p_lines) e)
     <> (select count(distinct e->>'ingredient_id') from jsonb_array_elements(p_lines) e) then
    raise exception 'duplicate_ingredient';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) e
    where not exists (
      select 1 from ingredients i where i.id = (e->>'ingredient_id')::uuid and i.restaurant_id = p_restaurant_id
    )
  ) then
    raise exception 'invalid_ingredient';
  end if;

  select coalesce(display_name, email) into v_name from app_users where id = auth.uid();
  insert into stock_counts (restaurant_id, counted_by, counted_by_name, note, count_type)
  values (p_restaurant_id, auth.uid(), v_name, nullif(left(trim(p_note), 300), ''), coalesce(p_count_type, 'spot'))
  returning id into v_id;

  for l in
    select i.id, i.name, i.unit, i.quantity_on_hand, i.cost_per_unit,
           (e->>'counted_qty')::numeric as counted, e->>'entered_text' as entered
    from jsonb_array_elements(p_lines) e
    join ingredients i on i.id = (e->>'ingredient_id')::uuid and i.restaurant_id = p_restaurant_id
    order by i.name
    for update of i
  loop
    if l.counted is null or l.counted < 0 then
      raise exception 'invalid_quantity';
    end if;

    insert into stock_count_lines (count_id, ingredient_id, ingredient_name, unit, system_qty, counted_qty, diff, unit_cost, entered_text)
    values (v_id, l.id, l.name, l.unit, l.quantity_on_hand, round(l.counted, 3), round(l.counted, 3) - l.quantity_on_hand, l.cost_per_unit,
            nullif(left(trim(l.entered), 100), ''));

    v_items := v_items + 1;
    if round(l.counted, 3) <> l.quantity_on_hand then
      v_diffs := v_diffs + 1;
      v_value := v_value + (round(l.counted, 3) - l.quantity_on_hand) * l.cost_per_unit;
      insert into stock_movements (restaurant_id, ingredient_id, change, reason, note, count_id)
      values (p_restaurant_id, l.id, round(l.counted, 3) - l.quantity_on_hand, 'adjustment', 'ตรวจนับสต็อก', v_id);
    end if;
  end loop;

  update stock_counts set item_count = v_items, diff_count = v_diffs, diff_value = round(v_value, 2) where id = v_id;
  return v_id;
end;
$$;
revoke execute on function submit_stock_count(uuid, jsonb, text, text) from public, anon;
grant execute on function submit_stock_count(uuid, jsonb, text, text) to authenticated;

-- ===== 4) สรุปต่อวัตถุดิบ: รับเข้าล่าสุด / นับล่าสุด (ใช้สิทธิ์ผู้เรียก) =====
create or replace function ingredient_last_activity(p_restaurant_id uuid)
returns table (
  ingredient_id uuid,
  received_at timestamptz,
  received_qty numeric,
  received_invoice_qty numeric,
  received_status text,
  counted_at timestamptz,
  counted_qty numeric,
  count_diff numeric
)
language sql stable security invoker set search_path = public, pg_temp as $$
  select i.id, rc.created_at, rc.quantity, rc.invoice_qty, rc.status, ct.created_at, ct.counted_qty, ct.diff
  from ingredients i
  left join lateral (
    select r.created_at, rl.quantity, rl.invoice_qty, rl.status
    from stock_receipt_lines rl join stock_receipts r on r.id = rl.receipt_id
    where rl.ingredient_id = i.id
    order by r.created_at desc limit 1
  ) rc on true
  left join lateral (
    select c.created_at, cl.counted_qty, cl.diff
    from stock_count_lines cl join stock_counts c on c.id = cl.count_id
    where cl.ingredient_id = i.id
    order by c.created_at desc limit 1
  ) ct on true
  where i.restaurant_id = p_restaurant_id;
$$;
grant execute on function ingredient_last_activity(uuid) to authenticated;

-- ===== 5) รายงานผู้ขาย =====
create or replace function supplier_receiving_report(p_restaurant_id uuid, p_from date, p_to date)
returns table (
  supplier text,
  receipts bigint,
  lines bigint,
  invoice_value numeric,
  received_value numeric,
  claim_pending numeric,
  claim_credited numeric,
  claim_accepted numeric,
  gap_pct numeric,
  short_lines bigint,
  rejected_lines bigint,
  glaze_pct numeric,
  glaze_over_lines bigint,
  price_up_lines bigint
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_glaze numeric;
begin
  if not has_role(p_restaurant_id, array['owner', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;
  select coalesce((select glaze_max_pct from shop_settings where restaurant_id = p_restaurant_id), 12) into v_glaze;

  return query
  select coalesce(r.supplier, 'ไม่ระบุผู้ขาย'),
         count(distinct r.id),
         count(*),
         round(sum(rl.invoice_qty * rl.unit_cost), 2),
         round(sum(rl.quantity * rl.unit_cost), 2),
         coalesce(sum(rl.claim_value) filter (where rl.claim_status = 'pending'), 0),
         coalesce(sum(rl.claim_value) filter (where rl.claim_status = 'credited'), 0),
         coalesce(sum(rl.claim_value) filter (where rl.claim_status = 'accepted'), 0),
         case when sum(rl.invoice_qty * rl.unit_cost) > 0
              then round(sum(rl.claim_value) / sum(rl.invoice_qty * rl.unit_cost) * 100, 2) end,
         count(*) filter (where rl.status = 'short'),
         count(*) filter (where rl.status = 'rejected'),
         case when sum(rl.gross_qty) filter (where rl.gross_qty > 0) > 0
              then round(sum(rl.gross_qty - rl.quantity) filter (where rl.gross_qty > 0)
                         / sum(rl.gross_qty) filter (where rl.gross_qty > 0) * 100, 2) end,
         count(*) filter (where rl.gross_qty > 0 and (rl.gross_qty - rl.quantity) / rl.gross_qty * 100 > v_glaze),
         count(*) filter (where rl.prev_unit_cost > 0 and rl.unit_cost > rl.prev_unit_cost * 1.1)
  from stock_receipts r
  join stock_receipt_lines rl on rl.receipt_id = r.id
  where r.restaurant_id = p_restaurant_id and r.received_on between p_from and p_to
  group by coalesce(r.supplier, 'ไม่ระบุผู้ขาย')
  order by 9 desc nulls last, 1;
end;
$$;
revoke execute on function supplier_receiving_report(uuid, date, date) from public, anon;
grant execute on function supplier_receiving_report(uuid, date, date) to authenticated;
