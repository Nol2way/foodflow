-- 0027: สต็อกแบบ ledger + ล็อต (โมดูลสต็อกวัตถุดิบ ตอนที่ 1/4)
--   หลักการ
--   - ยอดคงเหลือ = ผลรวมของ stock_movements เสมอ · ingredients.quantity_on_hand เป็นแค่ยอดสะสมที่ trigger ดูแล แก้ตรงไม่ได้
--   - stock_movements เพิ่มได้อย่างเดียว (append-only) ผิดให้สร้างรายการกลับ (reverses_id)
--   - สต็อกมี 3 แหล่ง: receive (นำเข้า) · recipe_deduct / recipe_return (ตัด/คืนตามสูตร) · count_adjust (นับสุดท้าย)
--     ไม่มีการบันทึกของเสียแยก ของหาย/เสียทั้งหมดไปโผล่เป็นส่วนต่างตอนนับ (Actual vs Theoretical)
--   - ทุกการรับเข้าสร้างล็อต (stock_lots) · หยิบของแบบ FEFO (หมดอายุก่อนออกก่อน) · คิดต้นทุนแบบ FIFO (รับก่อนคิดก่อน)
--     ล็อตเดียวมี 2 ยอด: qty_remaining (ของจริงบนชั้น ตัดแบบ FEFO) และ fifo_remaining (ชั้นต้นทุน ตัดแบบ FIFO)
--     ทั้งสองรวมกันทุกล็อตเท่ากับยอดคงเหลือเสมอ · stock_movement_lots จำว่ารายการไหนใช้ล็อตไหน (คืนได้ตรงล็อต)
--   - หน่วยฐาน (recipe_unit) มีแค่ g / ml / pcs · สต็อก สูตร ล็อต นับ เก็บเป็นหน่วยฐานทั้งหมด
--     หน่วยซื้อ (purchase_unit x conversion_factor) และหน่วยที่ครัวพูด (display_unit x display_factor) ใช้ตอนกรอก/แสดง
--   - บัญชี (0026) ยังใช้ quantity_on_hand x cost_per_unit · cost_per_unit = ต้นทุนเฉลี่ยของชั้น FIFO ที่เหลือ
--     จึงเท่ากับมูลค่าสต็อกแบบ FIFO และกระทบยอดกับบัญชีได้เหมือนเดิม

-- ===== 1) แปลงหน่วยเดิมเป็นหน่วยฐาน =====
create or replace function stock_unit_base(p_unit text, out base text, out factor numeric)
language sql immutable set search_path = public, pg_temp as $$
  select case
           when u in ('g', 'gram', 'grams', 'กรัม', 'kg', 'kgs', 'kilogram', 'กก', 'กก.', 'กิโลกรัม', 'กิโล') then 'g'
           when u in ('ml', 'มล', 'มล.', 'มิลลิลิตร', 'l', 'lt', 'liter', 'litre', 'ลิตร') then 'ml'
           else 'pcs'
         end,
         case
           when u in ('kg', 'kgs', 'kilogram', 'กก', 'กก.', 'กิโลกรัม', 'กิโล', 'l', 'lt', 'liter', 'litre', 'ลิตร') then 1000
           else 1
         end::numeric
  from (select lower(trim(coalesce(p_unit, ''))) as u) x;
$$;

-- ต้นทุนต่อกรัมต้องการทศนิยมมากขึ้น (เช่น 123.45 บาท/kg = 0.12345 บาท/g)
drop view if exists menu_item_costs;   -- สร้างใหม่ใน 0028 (อ่านต้นทุนจากสูตรแบบใหม่)
-- trigger บัญชีผูกกับคอลัมน์ที่เปลี่ยนชนิด: ถอดออกก่อน แล้วสร้างคืนหลังแปลงหน่วย (มูลค่าไม่เปลี่ยน ไม่ต้องลงบัญชี)
drop trigger if exists ingredients_accounting on ingredients;
-- นโยบายเดิมที่ให้ครัวบันทึกของเสียเอง (อ้างคอลัมน์ change) ไม่มีแล้ว: ระบบใหม่เขียน ledger ผ่านฟังก์ชันเท่านั้น (0030)
drop policy if exists stock_movements_insert on stock_movements;
alter table ingredients alter column cost_per_unit type numeric(16,7);
alter table stock_count_lines alter column unit_cost type numeric(16,7);
alter table stock_receipt_lines alter column unit_cost type numeric(16,7);
alter table stock_receipt_lines alter column prev_unit_cost type numeric(16,7);
alter table ingredients alter column quantity_on_hand type numeric(14,3);
alter table stock_movements alter column change type numeric(14,3);
alter table stock_movements alter column balance_after type numeric(14,3);

-- ===== 2) คอลัมน์ใหม่ของวัตถุดิบ =====
alter table ingredients add column if not exists recipe_unit text;                       -- g | ml | pcs (หน่วยฐาน)
alter table ingredients add column if not exists purchase_unit text check (char_length(purchase_unit) <= 30);   -- เช่น kg, ลัง
alter table ingredients add column if not exists conversion_factor numeric(14,4) not null default 1
  check (conversion_factor > 0);                                                        -- 1 หน่วยซื้อ = ? หน่วยฐาน
alter table ingredients add column if not exists display_unit text check (char_length(display_unit) <= 30);     -- หน่วยที่ครัวพูด เช่น ถุง ฟอง
alter table ingredients add column if not exists display_factor numeric(14,4) not null default 1
  check (display_factor > 0);                                                           -- 1 หน่วยครัว = ? หน่วยฐาน
alter table ingredients add column if not exists trim_yield_pct numeric(5,2) not null default 100
  check (trim_yield_pct > 0 and trim_yield_pct <= 100);                                 -- เหลือหลังตัดแต่ง/แกะ/ล้าง
alter table ingredients add column if not exists cook_yield_pct numeric(5,2) not null default 100
  check (cook_yield_pct > 0 and cook_yield_pct <= 400);                                 -- หลังปรุง (ข้าวหุงสุก > 100)
alter table ingredients add column if not exists abc_class text not null default 'C' check (abc_class in ('A', 'B', 'C'));
alter table ingredients add column if not exists storage_location text check (char_length(storage_location) <= 40);  -- เช่น ตู้แช่ 1
alter table ingredients add column if not exists shelf_order int not null default 0;    -- ลำดับบนชั้น (เรียงใบนับ shelf-to-sheet)
alter table ingredients add column if not exists par_level numeric(14,3) check (par_level >= 0);   -- ว่าง = คำนวณให้
alter table ingredients add column if not exists safety_stock numeric(14,3) not null default 0 check (safety_stock >= 0);
alter table ingredients add column if not exists last_unit_cost numeric(16,7) check (last_unit_cost >= 0);  -- ราคาซื้อล่าสุด/หน่วยฐาน (คิดต้นทุนสูตร)
alter table ingredients add column if not exists is_active boolean not null default true;

-- yield รวมแบบเดิม = trim x cook (ฟังก์ชันเก่ายังอ่าน yield_pct ได้)
alter table ingredients drop constraint if exists ingredients_yield_pct_check;
alter table ingredients add constraint ingredients_yield_pct_check check (yield_pct > 0 and yield_pct <= 400);
update ingredients set trim_yield_pct = yield_pct where yield_pct <= 100;

-- ===== 3) เปลี่ยนวัตถุดิบเดิมเป็นหน่วยฐาน (kg -> g, ลิตร -> ml) =====
-- ปรับทุกตัวเลขที่เป็นหน่วยของวัตถุดิบนั้นด้วยตัวคูณเดียวกัน: มูลค่า (จำนวน x ต้นทุน) ไม่เปลี่ยน บัญชีจึงไม่ต้องลงรายการ
create temp table stock_redenom on commit drop as
select i.id, i.unit as old_unit, b.base, b.factor
from ingredients i cross join lateral stock_unit_base(i.unit) b;

update ingredients i
   set recipe_unit = r.base,
       unit = case when r.base = 'pcs' then i.unit else r.base end,
       quantity_on_hand = i.quantity_on_hand * r.factor,
       reorder_level = i.reorder_level * r.factor,
       cost_per_unit = i.cost_per_unit / r.factor,
       last_unit_cost = i.cost_per_unit / r.factor,
       batch_output_qty = i.batch_output_qty * r.factor,
       purchase_unit = i.unit,
       conversion_factor = r.factor,
       display_unit = case when r.factor <> 1 or r.base = 'pcs' then i.unit end,
       display_factor = r.factor
  from stock_redenom r where r.id = i.id;

update stock_movements m set change = m.change * r.factor, balance_after = m.balance_after * r.factor
  from stock_redenom r where r.id = m.ingredient_id and r.factor <> 1;
update recipes x set quantity_used = x.quantity_used * r.factor
  from stock_redenom r where r.id = x.ingredient_id and r.factor <> 1;
update prep_components x set quantity = x.quantity * r.factor
  from stock_redenom r where r.id = x.ingredient_id and r.factor <> 1;
update prep_batches x set output_qty = x.output_qty * r.factor
  from stock_redenom r where r.id = x.prep_id and r.factor <> 1;
update ingredient_units x set factor = x.factor * r.factor
  from stock_redenom r where r.id = x.ingredient_id and r.factor <> 1;
update stock_count_lines x
   set system_qty = x.system_qty * r.factor, counted_qty = x.counted_qty * r.factor, diff = x.diff * r.factor,
       unit_cost = x.unit_cost / r.factor, unit = r.base
  from stock_redenom r where r.id = x.ingredient_id and r.factor <> 1;
update stock_receipt_lines x
   set quantity = x.quantity * r.factor, unit_cost = x.unit_cost / r.factor, invoice_qty = x.invoice_qty * r.factor,
       gross_qty = x.gross_qty * r.factor, prev_unit_cost = x.prev_unit_cost / r.factor, unit = r.base
  from stock_redenom r where r.id = x.ingredient_id and r.factor <> 1;

create trigger ingredients_accounting
  after insert or update of quantity_on_hand, cost_per_unit or delete on ingredients
  for each row execute function acct_ingredient_value();

update ingredients set yield_pct = round(trim_yield_pct * cook_yield_pct / 100, 2);
alter table ingredients alter column recipe_unit set not null;
-- ไม่มีค่าเริ่มต้น: ผู้เรียกที่ไม่ส่ง recipe_unit (แบบเดิม ส่งแค่ unit เช่น kg) ให้ trigger แปลงหน่วยให้ (ingredients_before_write)
alter table ingredients add constraint ingredients_recipe_unit_check check (recipe_unit in ('g', 'ml', 'pcs'));

-- ===== 4) ผู้ขาย =====
create table if not exists suppliers (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 100),
  phone text check (char_length(phone) <= 30),
  lead_time_days int not null default 1 check (lead_time_days between 0 and 60),   -- สั่งแล้วกี่วันได้ของ
  delivery_days int[] not null default '{0,1,2,3,4,5,6}'                           -- วันที่มาส่ง 0=อาทิตย์ .. 6=เสาร์
    check (cardinality(delivery_days) between 1 and 7 and delivery_days <@ '{0,1,2,3,4,5,6}'),
  note text check (char_length(note) <= 200),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists suppliers_restaurant_name_key on suppliers (restaurant_id, lower(trim(name)));

alter table ingredients add column if not exists supplier_id uuid references suppliers(id) on delete set null;
alter table stock_receipts add column if not exists supplier_id uuid references suppliers(id) on delete set null;

-- ชื่อผู้ขายเดิมในใบรับของ -> แถวผู้ขาย
insert into suppliers (restaurant_id, name)
select distinct restaurant_id, trim(supplier) from stock_receipts where nullif(trim(supplier), '') is not null
on conflict do nothing;
update stock_receipts r set supplier_id = s.id
  from suppliers s where s.restaurant_id = r.restaurant_id and lower(trim(s.name)) = lower(trim(r.supplier));

-- ===== 5) ล็อต =====
create table if not exists stock_lots (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  ingredient_id uuid not null references ingredients(id) on delete cascade,
  receipt_id uuid references stock_receipts(id) on delete set null,
  source text not null check (source in ('receive', 'count', 'opening', 'return')),
  qty numeric(14,3) not null check (qty > 0),                                     -- ที่รับเข้า (หน่วยฐาน)
  qty_remaining numeric(14,3) not null check (qty_remaining >= 0 and qty_remaining <= qty),    -- ของจริง (FEFO)
  fifo_remaining numeric(14,3) not null check (fifo_remaining >= 0 and fifo_remaining <= qty), -- ชั้นต้นทุน (FIFO)
  raw_unit_cost numeric(16,7) not null check (raw_unit_cost >= 0),                -- ราคาซื้อต่อหน่วยฐาน (ก่อนหัก yield)
  unit_cost numeric(16,7) not null check (unit_cost >= 0),                        -- หลังหัก yield = ราคา / (trim x cook)
  expiry_date date,
  received_at timestamptz not null default now()
);
create index if not exists stock_lots_fefo_idx on stock_lots (ingredient_id, expiry_date nulls last, received_at) where qty_remaining > 0;
create index if not exists stock_lots_fifo_idx on stock_lots (ingredient_id, received_at) where fifo_remaining > 0;
create index if not exists stock_lots_expiry_idx on stock_lots (restaurant_id, expiry_date) where qty_remaining > 0;

-- ===== 6) ledger =====
alter table stock_movements add column if not exists type text;
alter table stock_movements add column if not exists qty numeric(14,3) generated always as (change) stored;  -- ชื่อตามสเปก
alter table stock_movements add column if not exists cost numeric(14,2);           -- มูลค่าตามต้นทุน FIFO (เครื่องหมายเดียวกับจำนวน)
alter table stock_movements add column if not exists unit_cost numeric(16,7);      -- ต้นทุนต่อหน่วยฐานของรายการนี้
alter table stock_movements add column if not exists expiry_date date;             -- วันหมดอายุของล็อตที่รับเข้า
alter table stock_movements add column if not exists ref_id uuid;                  -- เอกสารต้นทาง (ออเดอร์ ใบรับ ใบนับ)
alter table stock_movements add column if not exists reverses_id uuid references stock_movements(id);
create unique index if not exists stock_movements_reverses_key on stock_movements (reverses_id) where reverses_id is not null;
create index if not exists stock_movements_ingredient_type_idx on stock_movements (ingredient_id, type, created_at);
create index if not exists stock_movements_order_idx on stock_movements (order_id) where order_id is not null;

-- ประวัติเดิม: ของเสีย / ผลิตของเตรียม ไม่มีในระบบใหม่ เก็บไว้เป็น legacy (สร้างใหม่ไม่ได้)
update stock_movements set
  type = case reason::text
           when 'purchase' then 'receive'
           when 'adjustment' then 'count_adjust'
           when 'sale' then case when change < 0 then 'recipe_deduct' else 'recipe_return' end
           else 'legacy'
         end,
  ref_id = coalesce(order_id, receipt_id, count_id, batch_id),
  cost = round(change * (select cost_per_unit from ingredients i where i.id = ingredient_id), 2);

-- ยอดตั้งต้นที่ไม่เคยผ่าน ledger (เช่น สร้างวัตถุดิบพร้อมยอด) -> 1 รายการยกมา ให้ ผลรวม ledger = คงเหลือ
alter table stock_movements disable trigger stock_movements_apply;
insert into stock_movements (restaurant_id, ingredient_id, change, reason, type, note, balance_after, cost)
select i.restaurant_id, i.id, i.quantity_on_hand - coalesce(s.total, 0), 'adjustment', 'legacy',
       'ยอดยกมา (ปรับประวัติให้ตรงคงเหลือ ก่อนเปิดใช้ ledger)', i.quantity_on_hand,
       round((i.quantity_on_hand - coalesce(s.total, 0)) * i.cost_per_unit, 2)
from ingredients i
left join (select ingredient_id, sum(change) as total from stock_movements group by ingredient_id) s on s.ingredient_id = i.id
where i.quantity_on_hand <> coalesce(s.total, 0);
alter table stock_movements enable trigger stock_movements_apply;

alter table stock_movements alter column type set not null;
alter table stock_movements add constraint stock_movements_type_check
  check (type in ('receive', 'recipe_deduct', 'recipe_return', 'count_adjust', 'legacy'));

-- ล็อตตั้งต้น: ยอดที่มีอยู่ ณ วันเปิดใช้ ที่ต้นทุนเดิม
insert into stock_lots (restaurant_id, ingredient_id, source, qty, qty_remaining, fifo_remaining, raw_unit_cost, unit_cost)
select restaurant_id, id, 'opening', quantity_on_hand, quantity_on_hand, quantity_on_hand, cost_per_unit,
       round(cost_per_unit * 10000 / (trim_yield_pct * cook_yield_pct), 7)
from ingredients where quantity_on_hand > 0;

-- รายการไหนใช้/เติมล็อตไหน (basis: fefo = ของจริง, fifo = ชั้นต้นทุน) · qty มีเครื่องหมายเดียวกับรายการ
create table if not exists stock_movement_lots (
  movement_id uuid not null references stock_movements(id) on delete cascade deferrable initially deferred,
  lot_id uuid not null references stock_lots(id) on delete cascade,
  basis text not null check (basis in ('fefo', 'fifo')),
  qty numeric(14,3) not null check (qty <> 0),
  unit_cost numeric(16,7) not null,
  primary key (movement_id, lot_id, basis)
);
create index if not exists stock_movement_lots_lot_idx on stock_movement_lots (lot_id);

-- บัญชี: รายการคืนสต็อกจากออเดอร์ที่ยกเลิก
alter table journal_entries drop constraint if exists journal_entries_source_type_check;
alter table journal_entries add constraint journal_entries_source_type_check check (source_type in (
  'bill', 'stock_receipt', 'recipe_deduct', 'recipe_return', 'count_adjust', 'expense', 'reversal', 'day_close',
  'waste', 'production', 'stock_revalue', 'supplier_claim', 'supplier_payment', 'opening'));

-- ===== 7) ตัด/เติมล็อต (ใช้ภายในเท่านั้น) =====
-- ตัดออก: ของจริงแบบ FEFO และต้นทุนแบบ FIFO · คืนมูลค่า FIFO (บวก)
create or replace function stock_take_lots(p_movement uuid, p_ingredient uuid, p_qty numeric)
returns numeric
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_need numeric;
  v_take numeric;
  v_cost numeric := 0;
  l stock_lots;
begin
  v_need := p_qty;
  for l in select * from stock_lots where ingredient_id = p_ingredient and qty_remaining > 0
           order by expiry_date nulls last, received_at, id for update
  loop
    exit when v_need <= 0;
    v_take := least(v_need, l.qty_remaining);
    update stock_lots set qty_remaining = qty_remaining - v_take where id = l.id;
    insert into stock_movement_lots values (p_movement, l.id, 'fefo', -v_take, l.raw_unit_cost);
    v_need := v_need - v_take;
  end loop;
  if v_need > 0 then
    raise exception 'lots_out_of_sync';
  end if;

  v_need := p_qty;
  for l in select * from stock_lots where ingredient_id = p_ingredient and fifo_remaining > 0
           order by received_at, id for update
  loop
    exit when v_need <= 0;
    v_take := least(v_need, l.fifo_remaining);
    update stock_lots set fifo_remaining = fifo_remaining - v_take where id = l.id;
    insert into stock_movement_lots values (p_movement, l.id, 'fifo', -v_take, l.raw_unit_cost);
    v_cost := v_cost + v_take * l.raw_unit_cost;
    v_need := v_need - v_take;
  end loop;
  if v_need > 0 then
    raise exception 'lots_out_of_sync';
  end if;
  return v_cost;
end;
$$;

-- เติมเข้า: สร้างล็อตใหม่ · คืนมูลค่า (บวก)
create or replace function stock_add_lot(
  p_movement uuid, p_ing ingredients, p_qty numeric, p_unit_cost numeric, p_source text,
  p_receipt uuid default null, p_expiry date default null
)
returns numeric
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_lot uuid;
begin
  insert into stock_lots (restaurant_id, ingredient_id, receipt_id, source, qty, qty_remaining, fifo_remaining,
                          raw_unit_cost, unit_cost, expiry_date)
  values (p_ing.restaurant_id, p_ing.id, p_receipt, p_source, p_qty, p_qty, p_qty, p_unit_cost,
          round(p_unit_cost * 10000 / (p_ing.trim_yield_pct * p_ing.cook_yield_pct), 7), p_expiry)
  returning id into v_lot;
  insert into stock_movement_lots values (p_movement, v_lot, 'fefo', p_qty, p_unit_cost), (p_movement, v_lot, 'fifo', p_qty, p_unit_cost);
  return p_qty * p_unit_cost;
end;
$$;

-- กลับรายการ: ย้อนผลต่อล็อตของรายการต้นทางทีละบรรทัด · คืน (มูลค่าที่ย้อนแล้ว, จำนวนที่ย้อนแล้ว)
create or replace function stock_undo_lots(p_movement uuid, p_original uuid, out cost numeric, out qty numeric)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
begin
  cost := 0;
  qty := 0;
  for r in select ml.*, l.qty_remaining, l.fifo_remaining
           from stock_movement_lots ml join stock_lots l on l.id = ml.lot_id
           where ml.movement_id = p_original order by ml.basis, ml.lot_id
           for update of l
  loop
    -- รายการต้นทางเติมล็อต (รับเข้า) แต่ของในล็อตถูกใช้ไปแล้ว: ย้อนไม่ได้
    if r.qty > 0 and ((r.basis = 'fefo' and r.qty_remaining < r.qty) or (r.basis = 'fifo' and r.fifo_remaining < r.qty)) then
      raise exception 'lot_already_used';
    end if;
    if r.basis = 'fefo' then
      update stock_lots set qty_remaining = qty_remaining - r.qty where id = r.lot_id;
      qty := qty - r.qty;
    else
      update stock_lots set fifo_remaining = fifo_remaining - r.qty where id = r.lot_id;
      cost := cost - r.qty * r.unit_cost;
    end if;
    insert into stock_movement_lots values (p_movement, r.lot_id, r.basis, -r.qty, r.unit_cost);
  end loop;
end;
$$;

revoke execute on function stock_take_lots(uuid, uuid, numeric) from public, anon, authenticated;
revoke execute on function stock_add_lot(uuid, ingredients, numeric, numeric, text, uuid, date) from public, anon, authenticated;
revoke execute on function stock_undo_lots(uuid, uuid) from public, anon, authenticated;

-- ===== 8) trigger หลักของ ledger =====
-- ก่อนบันทึก: ตรวจกฎ -> ตัด/เติมล็อต -> คิดต้นทุน FIFO -> ปรับยอดคงเหลือ + ต้นทุนเฉลี่ยของชั้น FIFO ในคำสั่งเดียว
-- (บัญชี 0026 ลงรายการจากผลต่างมูลค่า ตามบริบท plato.stock_ctx)
create or replace function apply_stock_movement()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ing ingredients;
  v_rev stock_movements;
  v_cost numeric;
  v_done record;
  v_unit numeric;
  v_val numeric;
  v_q numeric;
  v_ctx text;
begin
  new.created_by := auth.uid();
  -- ผู้เรียกแบบเดิมส่งแค่ reason: แปลงเป็นประเภทใหม่ (ของเสีย/ผลิตไม่มีแล้ว)
  if new.type is null then
    new.type := case new.reason::text
                  when 'purchase' then 'receive'
                  when 'adjustment' then 'count_adjust'
                  when 'sale' then case when new.change < 0 then 'recipe_deduct' else 'recipe_return' end
                end;
  end if;
  if new.type is null or new.type = 'legacy' then
    raise exception 'movement_type_not_allowed';
  end if;
  new.reason := (case new.type when 'receive' then 'purchase' when 'count_adjust' then 'adjustment' else 'sale' end)::stock_reason;
  new.waste_type := null;
  new.batch_id := null;
  new.change := round(new.change, 3);
  new.ref_id := coalesce(new.ref_id, new.order_id, new.receipt_id, new.count_id);
  if new.change is null or new.change = 0 then
    raise exception 'invalid_quantity';
  end if;
  if (new.type = 'recipe_deduct' and new.change > 0)
     or (new.type = 'recipe_return' and (new.change < 0 or new.reverses_id is null))
     or (new.type = 'receive' and new.change < 0 and new.reverses_id is null) then
    raise exception 'invalid_quantity';
  end if;

  select * into v_ing from ingredients where id = new.ingredient_id and restaurant_id = new.restaurant_id for update;
  if v_ing.id is null then
    raise exception 'invalid_ingredient';
  end if;
  if new.reverses_id is not null then
    -- รายการกลับ: ต้องตรงข้ามกับต้นทางพอดี และกลับได้ครั้งเดียว (unique index)
    select * into v_rev from stock_movements where id = new.reverses_id;
    if v_rev.id is null or v_rev.ingredient_id <> new.ingredient_id or v_rev.change <> -new.change
       or v_rev.type = 'legacy' or v_rev.reverses_id is not null
       or new.type <> (case v_rev.type when 'recipe_deduct' then 'recipe_return' else v_rev.type end) then
      raise exception 'invalid_reversal';
    end if;
    v_done := stock_undo_lots(new.id, v_rev.id);
    v_cost := v_done.cost;
    -- ประวัติก่อนมีล็อต: ส่วนที่ไม่รู้ล็อต ตัด/เติมตามปกติ
    if abs(v_done.qty) < abs(new.change) then
      if new.change > 0 then
        v_cost := v_cost + stock_add_lot(new.id, v_ing, new.change - v_done.qty,
                                         coalesce(abs(v_rev.cost / nullif(v_rev.change, 0)), v_ing.cost_per_unit), 'return');
      else
        v_cost := v_cost - stock_take_lots(new.id, new.ingredient_id, -(new.change - v_done.qty));
      end if;
    end if;
  elsif new.change < 0 then
    if v_ing.quantity_on_hand + new.change < 0 then
      raise exception 'insufficient_stock: %', v_ing.name;   -- สต็อกติดลบไม่ได้
    end if;
    v_cost := -stock_take_lots(new.id, new.ingredient_id, -new.change);
  else
    if new.type = 'receive' then
      v_unit := new.unit_cost;
    else
      -- นับเจอเกิน: คิดต้นทุนตามล็อตล่าสุด (ยังไม่เคยมีล็อต = ต้นทุนที่ตั้งไว้)
      select raw_unit_cost into v_unit from stock_lots where ingredient_id = new.ingredient_id order by received_at desc, id limit 1;
      v_unit := coalesce(new.unit_cost, v_unit, v_ing.last_unit_cost, v_ing.cost_per_unit, 0);
    end if;
    if v_unit is null or v_unit < 0 then
      raise exception 'invalid_cost';
    end if;
    v_cost := stock_add_lot(new.id, v_ing, new.change, v_unit,
                            case new.type when 'receive' then 'receive' else 'count' end, new.receipt_id, new.expiry_date);
  end if;

  new.cost := round(v_cost, 2);
  new.unit_cost := round(abs(v_cost / new.change), 7);

  v_ctx := case new.type
    when 'receive' then
      case when new.receipt_id is null then 'stock_receipt||@payment'
           when new.reverses_id is not null then 'stock_receipt|' || new.receipt_id || '|claim'
           else 'stock_receipt|' || new.receipt_id || '|' end
    when 'recipe_deduct' then 'recipe_deduct|' || coalesce(new.order_id::text, '') || '|cogs'
    when 'recipe_return' then 'recipe_return|' || coalesce(new.order_id::text, '') || '|cogs'
    else
      -- ยอดแรกของวัตถุดิบ (สร้างพร้อมยอดยกมา/นับครั้งแรก) = ยอดยกมา ไม่ใช่ส่วนต่าง
      case when new.change > 0 and new.reverses_id is null
                and not exists (select 1 from stock_movements where ingredient_id = new.ingredient_id)
           then 'opening|' || new.ingredient_id || '|equity'
           else 'count_adjust|' || coalesce(new.count_id, new.id) || '|variance' end
  end;

  select sum(fifo_remaining * raw_unit_cost), sum(fifo_remaining) into v_val, v_q
  from stock_lots where ingredient_id = new.ingredient_id and fifo_remaining > 0;

  perform set_config('plato.stock_ctx', v_ctx, true);
  perform set_config('plato.ledger', 'on', true);
  update ingredients
     set quantity_on_hand = quantity_on_hand + new.change,
         cost_per_unit = case when v_q > 0 then round(v_val / v_q, 7) else cost_per_unit end
   where id = new.ingredient_id
  returning quantity_on_hand into new.balance_after;
  perform set_config('plato.ledger', '', true);
  perform set_config('plato.stock_ctx', '', true);
  return new;
end;
$$;

drop trigger if exists stock_movements_apply on stock_movements;
create trigger stock_movements_apply before insert on stock_movements
  for each row execute function apply_stock_movement();

-- append-only: แก้/ลบไม่ได้ (ยกเว้นลบทั้งร้าน/วัตถุดิบ และ FK ที่ตั้งเป็น null เมื่อเอกสารต้นทางถูกลบ)
create or replace function stock_movements_guard()
returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from restaurants where id = old.restaurant_id)
       and exists (select 1 from ingredients where id = old.ingredient_id) then
      raise exception 'stock_ledger_append_only';
    end if;
    return old;
  end if;
  if (new.restaurant_id, new.ingredient_id, new.change, new.type, new.cost, new.unit_cost, new.balance_after,
      new.created_at, new.created_by, new.reverses_id, new.note)
     is distinct from
     (old.restaurant_id, old.ingredient_id, old.change, old.type, old.cost, old.unit_cost, old.balance_after,
      old.created_at, old.created_by, old.reverses_id, old.note) then
    raise exception 'stock_ledger_append_only';
  end if;
  return new;
end;
$$;
drop trigger if exists stock_movements_guard on stock_movements;
create trigger stock_movements_guard before update or delete on stock_movements
  for each row execute function stock_movements_guard();

-- ===== 9) วัตถุดิบ: หน่วย yield ยอดยกมา และห้ามแก้ยอด/ต้นทุนตรงๆ =====
create or replace function ingredients_before_write()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b record;
begin
  if tg_op = 'INSERT' then
    -- ผู้เรียกแบบเดิมส่งแค่ unit (เช่น kg): แปลงเป็นหน่วยฐาน ตัวเลขทุกช่องคูณตามกัน
    if new.recipe_unit is null then
      select * into b from stock_unit_base(new.unit);
      new.recipe_unit := b.base;
      if b.factor <> 1 then
        new.purchase_unit := coalesce(new.purchase_unit, new.unit);
        new.conversion_factor := b.factor;
        new.display_unit := coalesce(new.display_unit, new.unit);
        new.display_factor := b.factor;
        new.quantity_on_hand := new.quantity_on_hand * b.factor;
        new.reorder_level := new.reorder_level * b.factor;
        new.batch_output_qty := new.batch_output_qty * b.factor;
        new.cost_per_unit := new.cost_per_unit / b.factor;
      end if;
    end if;
    new.purchase_unit := coalesce(nullif(trim(new.purchase_unit), ''), case when new.recipe_unit = 'pcs' then new.unit else new.recipe_unit end);
    new.last_unit_cost := coalesce(new.last_unit_cost, new.cost_per_unit);
    -- ยอดเริ่มต้นไม่เขียนลงยอดตรงๆ: เก็บไว้แล้วบันทึกเป็นรายการยกมาหลังสร้างแถว (ingredients_after_insert)
    if new.quantity_on_hand > 0 then
      perform set_config('plato.open_' || replace(new.id::text, '-', ''), new.quantity_on_hand::text, true);
    end if;
    new.quantity_on_hand := 0;
  else
    if (new.quantity_on_hand, new.cost_per_unit, new.last_unit_cost)
       is distinct from (old.quantity_on_hand, old.cost_per_unit, old.last_unit_cost)
       and coalesce(current_setting('plato.ledger', true), '') <> 'on' then
      raise exception 'stock_balance_is_ledger';   -- ยอด/ต้นทุนมาจาก ledger และใบรับของเท่านั้น
    end if;
    if new.recipe_unit <> old.recipe_unit
       and exists (select 1 from stock_movements where ingredient_id = old.id) then
      raise exception 'recipe_unit_locked';
    end if;
    -- ผู้เรียกแบบเดิมแก้ yield_pct: ถือเป็น trim yield
    if new.yield_pct is distinct from old.yield_pct
       and (new.trim_yield_pct, new.cook_yield_pct) is not distinct from (old.trim_yield_pct, old.cook_yield_pct) then
      if new.yield_pct is null or new.yield_pct <= 0 or new.yield_pct > 100 then
        raise exception 'invalid_yield';
      end if;
      new.trim_yield_pct := new.yield_pct;
      new.cook_yield_pct := 100;
    end if;
  end if;

  if tg_op = 'INSERT' and new.trim_yield_pct = 100 and new.cook_yield_pct = 100 and coalesce(new.yield_pct, 100) <> 100 then
    if new.yield_pct <= 0 or new.yield_pct > 100 then
      raise exception 'invalid_yield';
    end if;
    new.trim_yield_pct := new.yield_pct;
  end if;
  new.yield_pct := round(new.trim_yield_pct * new.cook_yield_pct / 100, 2);
  -- หน่วยแสดงผล: g/ml ใช้ชื่อหน่วยฐาน · pcs ใช้ชื่อที่ร้านตั้ง (ฟอง ขวด ตัว)
  if new.recipe_unit in ('g', 'ml') then
    new.unit := new.recipe_unit;
  elsif new.unit is null or (stock_unit_base(new.unit)).base <> 'pcs' then
    new.unit := 'pcs';
  end if;
  return new;
end;
$$;
drop trigger if exists ingredients_before_write on ingredients;
create trigger ingredients_before_write before insert or update on ingredients
  for each row execute function ingredients_before_write();

create or replace function ingredients_after_insert()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_key text := 'plato.open_' || replace(new.id::text, '-', '');
  v_qty numeric := nullif(current_setting(v_key, true), '')::numeric;
begin
  if v_qty > 0 then
    perform set_config(v_key, '', true);
    insert into stock_movements (restaurant_id, ingredient_id, change, type, unit_cost, note)
    values (new.restaurant_id, new.id, v_qty, 'count_adjust', new.cost_per_unit, 'ยอดยกมา');
  end if;
  return null;
end;
$$;
drop trigger if exists ingredients_after_insert on ingredients;
create trigger ingredients_after_insert after insert on ingredients
  for each row execute function ingredients_after_insert();

-- วัตถุดิบที่มีประวัติลบไม่ได้ (ประวัติ ledger จะหาย) ใช้ปิดใช้งาน (is_active) แทน
create or replace function ingredients_before_delete()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from restaurants where id = old.restaurant_id)
     and exists (select 1 from stock_movements where ingredient_id = old.id) then
    raise exception 'ingredient_has_history';
  end if;
  return old;
end;
$$;
drop trigger if exists ingredients_before_delete on ingredients;
create trigger ingredients_before_delete before delete on ingredients
  for each row execute function ingredients_before_delete();

-- ===== 10) คำอธิบายรายการบัญชี: เพิ่ม "คืนสต็อก" (เหมือน 0026 ทุกอย่าง ยกเว้นข้อความ) =====
create or replace function acct_ingredient_value()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old numeric := 0;
  v_new numeric := 0;
  v_delta numeric;
  v_rid uuid := coalesce(new.restaurant_id, old.restaurant_id);
  v_ing uuid := coalesce(new.id, old.id);
  v_name text := coalesce(new.name, old.name);
  v_ctx text := nullif(current_setting('plato.stock_ctx', true), '');
  v_receipt text := nullif(current_setting('plato.receipt_ctx', true), '');
  v_src text;
  v_doc uuid;
  v_contra text;
  v_entry uuid;
begin
  if tg_op <> 'INSERT' then
    v_old := round(old.quantity_on_hand * old.cost_per_unit, 2);
  end if;
  if tg_op <> 'DELETE' then
    v_new := round(new.quantity_on_hand * new.cost_per_unit, 2);
  end if;
  v_delta := v_new - v_old;
  if v_delta = 0 or not exists (select 1 from restaurants where id = v_rid) then
    return null;
  end if;

  if v_ctx is not null then
    v_src := split_part(v_ctx, '|', 1);
    v_doc := nullif(split_part(v_ctx, '|', 2), '')::uuid;
    v_contra := nullif(split_part(v_ctx, '|', 3), '');
    if v_contra = '@payment' then
      v_contra := acct_payment_key(v_rid, null);
    end if;
  elsif v_receipt is not null then
    v_src := 'stock_receipt'; v_doc := v_receipt::uuid; v_contra := null;
  elsif tg_op = 'INSERT' then
    v_src := 'opening'; v_doc := v_ing; v_contra := 'equity';
  else
    v_src := 'stock_revalue'; v_doc := v_ing; v_contra := 'variance';
  end if;

  v_entry := acct_tx_entry(v_rid, v_src, v_doc, case v_src
    when 'recipe_deduct' then 'ตัดสต็อกตามสูตร'
    when 'recipe_return' then 'คืนสต็อกจากออเดอร์ที่ยกเลิก'
    when 'stock_receipt' then 'รับวัตถุดิบเข้า'
    when 'waste' then 'ของเสีย'
    when 'count_adjust' then 'ปรับยอดจากการตรวจนับ'
    when 'production' then 'ผลิตของเตรียม'
    when 'opening' then 'ยอดยกมาวัตถุดิบ'
    else 'ปรับมูลค่าสต็อก' end);
  perform acct_line(v_entry, 'stock', v_delta, v_ing, v_name);
  if v_contra is not null then
    perform acct_line(v_entry, v_contra, -v_delta, v_ing, v_name);
  end if;
  return null;
end;
$$;
