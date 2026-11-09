-- Plato — migration 0005: สต็อกแบบ ledger + ล็อต สูตร การนับ ส่วนต่าง yield par และ RLS
-- รวมจาก migration เดิม 0027–0030 (4 ไฟล์) ต่อกันตามลำดับเดิม เนื้อหาไม่เปลี่ยน
-- ไฟล์เดิมเก็บไว้ที่ migrations/archive/ (เลขในคอมเมนต์ด้านล่าง เช่น "0017" หมายถึงไฟล์เดิมเหล่านั้น)

-- ========================================================================
-- เดิม: 0027_stock_ledger.sql
-- ========================================================================

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

-- ========================================================================
-- เดิม: 0028_stock_recipes.sql
-- ========================================================================

-- 0028: สูตรอาหารแบบใหม่ + ตัด/คืนสต็อกตามออเดอร์ (โมดูลสต็อกวัตถุดิบ ตอนที่ 2/4)
--   - recipes + recipe_lines: สูตรมี output_qty (ทำ 1 ครั้งได้เท่าไร) · บรรทัดเป็นวัตถุดิบ หรือสูตรย่อย (สูตรซ้อน) ก็ได้
--     สูตรของเมนู = ผูก menu_item_id (output = จำนวนที่เสิร์ฟ) · สูตรย่อย = ไม่ผูกเมนู เช่น น้ำจิ้ม 1 หม้อ = 5000 ml
--     ปริมาณในบรรทัด = ปริมาณสุทธิที่ใช้จริง (หลังตัดแต่ง/สุก) · ระบบตัดดิบ = สุทธิ ÷ (trim yield x cook yield)
--   - ต้นทุนต่อหน่วยวัตถุดิบ = ราคาซื้อล่าสุด ÷ (trim x cook) · ราคาเปลี่ยน -> คำนวณต้นทุนทุกสูตรที่ใช้ใหม่ รวมสูตรแม่
--   - ตัดสต็อกเมื่อครัวกด "เริ่มทำ" · ยกเลิกออเดอร์ = คืนสต็อกอัตโนมัติ (คืนลงล็อตเดิม)
--   - สต็อกไม่พอ: ตัดไม่ได้ (ไม่ติดลบ) และเมนูที่ทำไม่ได้แล้วปิดอัตโนมัติ · ของกลับมาพอ = เปิดให้อัตโนมัติ
--   - ของเตรียมแบบเดิม (prep_components + ผลิตทีละถัง) ย้ายเป็นสูตรย่อย · สูตรเดิม (recipes) เก็บไว้ที่ legacy_menu_recipes

-- ===== 1) เก็บสูตรเดิม =====
alter table recipes rename to legacy_menu_recipes;
alter index if exists recipes_pkey rename to legacy_menu_recipes_pkey;
drop policy if exists recipes_write on legacy_menu_recipes;
revoke insert, update, delete on legacy_menu_recipes from anon, authenticated;

-- ===== 2) ตารางสูตร =====
create table recipes (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 100),
  menu_item_id uuid unique references menu_items(id) on delete cascade,   -- ว่าง = สูตรย่อย
  output_qty numeric(14,3) not null default 1 check (output_qty > 0),
  output_unit text not null default 'จาน' check (char_length(output_unit) between 1 and 20),
  cost_per_output numeric(16,7) not null default 0,                         -- ต้นทุนต่อ 1 หน่วยที่ได้ (คำนวณให้)
  cost_updated_at timestamptz,
  note text check (char_length(note) <= 300),
  created_at timestamptz not null default now()
);
create index recipes_restaurant_idx on recipes (restaurant_id);

create table recipe_lines (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references recipes(id) on delete cascade,
  ingredient_id uuid references ingredients(id) on delete restrict,
  sub_recipe_id uuid references recipes(id) on delete restrict,
  qty numeric(14,3) not null check (qty > 0),     -- หน่วยฐานของวัตถุดิบ (สุทธิ) หรือหน่วยที่ได้ของสูตรย่อย
  check (num_nonnulls(ingredient_id, sub_recipe_id) = 1),
  check (sub_recipe_id is distinct from recipe_id)
);
create unique index recipe_lines_ingredient_key on recipe_lines (recipe_id, ingredient_id) where ingredient_id is not null;
create unique index recipe_lines_sub_key on recipe_lines (recipe_id, sub_recipe_id) where sub_recipe_id is not null;
create index recipe_lines_ingredient_idx on recipe_lines (ingredient_id) where ingredient_id is not null;
create index recipe_lines_sub_idx on recipe_lines (sub_recipe_id) where sub_recipe_id is not null;

-- บรรทัดต้องเป็นของร้านเดียวกัน · สูตรย่อยต้องไม่ผูกเมนู · ห้ามวนกลับมาที่ตัวเอง (ทางตรง/ทางอ้อม)
create or replace function recipe_lines_check()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rid uuid;
begin
  select restaurant_id into v_rid from recipes where id = new.recipe_id;
  if new.ingredient_id is not null
     and not exists (select 1 from ingredients where id = new.ingredient_id and restaurant_id = v_rid) then
    raise exception 'invalid_ingredient';
  end if;
  if new.sub_recipe_id is not null then
    if not exists (select 1 from recipes where id = new.sub_recipe_id and restaurant_id = v_rid and menu_item_id is null) then
      raise exception 'invalid_sub_recipe';
    end if;
    if exists (
      with recursive d(id, depth) as (
        select new.sub_recipe_id, 1
        union all
        select l.sub_recipe_id, d.depth + 1 from recipe_lines l join d on l.recipe_id = d.id
        where l.sub_recipe_id is not null and d.depth < 20
      )
      select 1 from d where d.id = new.recipe_id
    ) then
      raise exception 'recipe_cycle';
    end if;
  end if;
  return new;
end;
$$;
create trigger recipe_lines_check before insert or update on recipe_lines
  for each row execute function recipe_lines_check();

-- สูตรที่เป็นสูตรย่อยของสูตรอื่นอยู่ ผูกเมนูไม่ได้ · ร้านของเมนูต้องตรงกับร้านของสูตร
create or replace function recipes_check()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.menu_item_id is not null then
    if not exists (select 1 from menu_items where id = new.menu_item_id and restaurant_id = new.restaurant_id) then
      raise exception 'invalid_menu_item';
    end if;
    if tg_op = 'UPDATE' and exists (select 1 from recipe_lines where sub_recipe_id = new.id) then
      raise exception 'sub_recipe_in_use';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.restaurant_id <> old.restaurant_id then
    raise exception 'invalid_restaurant';
  end if;
  new.name := trim(new.name);
  return new;
end;
$$;
create trigger recipes_check before insert or update on recipes
  for each row execute function recipes_check();

-- ===== 3) แตกสูตรเป็นวัตถุดิบ =====
-- p_units = จำนวนหน่วยที่ได้ของสูตรนี้ที่ต้องการ (เมนู: จำนวนจาน) · คืนปริมาณสุทธิ และดิบ (หาร yield)
create or replace function recipe_expand(p_recipe_id uuid, p_units numeric)
returns table (ingredient_id uuid, net_qty numeric, raw_qty numeric)
language sql stable security invoker set search_path = public, pg_temp as $$
  with recursive x(recipe_id, units, depth) as (
    select p_recipe_id, p_units, 0
    union all
    select l.sub_recipe_id, x.units * l.qty / r.output_qty, x.depth + 1
    from x
    join recipes r on r.id = x.recipe_id
    join recipe_lines l on l.recipe_id = x.recipe_id and l.sub_recipe_id is not null
    where x.depth < 20
  )
  select l.ingredient_id,
         sum(x.units * l.qty / r.output_qty),
         sum(x.units * l.qty / r.output_qty * 10000 / (i.trim_yield_pct * i.cook_yield_pct))
  from x
  join recipes r on r.id = x.recipe_id
  join recipe_lines l on l.recipe_id = x.recipe_id and l.ingredient_id is not null
  join ingredients i on i.id = l.ingredient_id
  group by l.ingredient_id;
$$;

-- ต้นทุนต่อ 1 หน่วยที่ได้: Σ ดิบ x ราคาซื้อล่าสุด (= สุทธิ x ราคา ÷ (trim x cook)) ÷ output
create or replace function recipe_unit_cost(p_recipe_id uuid)
returns numeric
language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(sum(e.raw_qty * coalesce(i.last_unit_cost, i.cost_per_unit)), 0) / r.output_qty
  from recipes r
  left join lateral recipe_expand(r.id, r.output_qty) e on true
  left join ingredients i on i.id = e.ingredient_id
  where r.id = p_recipe_id
  group by r.output_qty;
$$;

-- คำนวณต้นทุนใหม่ให้สูตรที่ใช้วัตถุดิบ/สูตรเหล่านี้ และสูตรแม่ทุกชั้น · คืนจำนวนสูตรที่คำนวณ
create or replace function recipes_recost(p_ingredient_ids uuid[], p_recipe_ids uuid[] default '{}')
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  n int;
begin
  with recursive up(id, depth) as (
    select s.id, 0 from (
      select recipe_id as id from recipe_lines where ingredient_id = any(coalesce(p_ingredient_ids, '{}'))
      union
      select unnest(coalesce(p_recipe_ids, '{}'))
    ) s
    union all
    select l.recipe_id, up.depth + 1 from recipe_lines l join up on l.sub_recipe_id = up.id where up.depth < 20
  )
  update recipes r set cost_per_output = round(coalesce(recipe_unit_cost(r.id), 0), 7), cost_updated_at = now()
  where r.id in (select id from up);
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function recipe_lines_recost()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform recipes_recost('{}', array[coalesce(new.recipe_id, old.recipe_id)]);
  return null;
end;
$$;
create trigger recipe_lines_recost after insert or update or delete on recipe_lines
  for each row execute function recipe_lines_recost();

create or replace function recipes_output_recost()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform recipes_recost('{}', array[new.id]);
  return null;
end;
$$;
create trigger recipes_output_recost after insert or update of output_qty on recipes
  for each row execute function recipes_output_recost();

-- ราคาซื้อล่าสุด / yield ของวัตถุดิบเปลี่ยน -> ต้นทุนทุกสูตรที่เกี่ยวข้อง
create or replace function ingredients_recost()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (new.last_unit_cost, new.trim_yield_pct, new.cook_yield_pct)
     is distinct from (old.last_unit_cost, old.trim_yield_pct, old.cook_yield_pct) then
    perform recipes_recost(array[new.id]);
  end if;
  return null;
end;
$$;
create trigger ingredients_recost after update of last_unit_cost, trim_yield_pct, cook_yield_pct on ingredients
  for each row execute function ingredients_recost();

-- ===== 4) ย้ายสูตรเดิม =====
-- ของเตรียมที่มีส่วนผสม -> สูตรย่อย (output = ผลิต 1 ถังได้)
create temp table prep_map on commit drop as
select gen_random_uuid() as recipe_id, p.id as prep_id, p.restaurant_id, p.name, p.batch_output_qty, p.unit
from ingredients p
where p.is_prep and p.batch_output_qty is not null and exists (select 1 from prep_components c where c.prep_id = p.id);

alter table recipe_lines disable trigger recipe_lines_recost;
alter table recipes disable trigger recipes_output_recost;

insert into recipes (id, restaurant_id, name, output_qty, output_unit, note)
select recipe_id, restaurant_id, left(name, 100), batch_output_qty, left(unit, 20), 'ย้ายจากของเตรียมเดิม' from prep_map;

insert into recipe_lines (recipe_id, ingredient_id, sub_recipe_id, qty)
select m.recipe_id, case when sub.recipe_id is null then c.ingredient_id end, sub.recipe_id, c.quantity
from prep_map m
join prep_components c on c.prep_id = m.prep_id
left join prep_map sub on sub.prep_id = c.ingredient_id;

-- สูตรเมนูเดิม -> 1 สูตรต่อเมนู (output 1 จาน) · วัตถุดิบที่เป็นของเตรียม -> บรรทัดสูตรย่อย
insert into recipes (restaurant_id, name, menu_item_id, output_qty, output_unit)
select m.restaurant_id, left(m.name, 100), m.id, 1, 'จาน'
from menu_items m where exists (select 1 from legacy_menu_recipes r where r.menu_item_id = m.id);

insert into recipe_lines (recipe_id, ingredient_id, sub_recipe_id, qty)
select rc.id, case when pm.recipe_id is null then lr.ingredient_id end, pm.recipe_id, lr.quantity_used
from legacy_menu_recipes lr
join recipes rc on rc.menu_item_id = lr.menu_item_id
left join prep_map pm on pm.prep_id = lr.ingredient_id;

alter table recipe_lines enable trigger recipe_lines_recost;
alter table recipes enable trigger recipes_output_recost;
select recipes_recost('{}', coalesce(array_agg(id), '{}')) from recipes;

-- ผลิตของเตรียมแยกไม่มีแล้ว (ใช้สูตรย่อย: ตัดวัตถุดิบดิบตอนขาย)
drop policy if exists prep_components_write on prep_components;
revoke insert, update, delete on prep_components from anon, authenticated;
create or replace function produce_prep(p_prep_id uuid, p_output_qty numeric, p_note text default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  raise exception 'prep_production_removed';
end;
$$;

-- ===== 5) ต้นทุนต่อเมนู =====
create view menu_item_costs with (security_invoker = true) as
select m.id as menu_item_id,
       m.restaurant_id,
       m.name,
       m.price,
       coalesce(r.cost_per_output, 0)::numeric(12,2) as unit_cost,
       (select count(*) from recipe_lines l where l.recipe_id = r.id) as ingredient_count
from menu_items m
left join recipes r on r.menu_item_id = m.id;
grant select on menu_item_costs to authenticated;

-- กำไรขั้นต้นต่อเมนู (เหมือน 0026 แต่ต้นทุนจากสูตรแบบใหม่)
create or replace function acct_menu_profit(p_restaurant_id uuid, p_from date, p_to date)
returns table (menu_item_id uuid, name text, quantity numeric, revenue numeric, cost numeric, gross_profit numeric, has_recipe boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_tz text;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'accountant']) then
    raise exception 'forbidden';
  end if;
  select timezone into v_tz from restaurants where id = p_restaurant_id;
  return query
  with c as (
    select m.id, coalesce(r.cost_per_output, 0) as unit_cost, r.id is not null as has_recipe
    from menu_items m
    left join recipes r on r.menu_item_id = m.id
    where m.restaurant_id = p_restaurant_id
  ), s as (
    select m.id, m.name,
           sum(case when m.sold_by_weight then coalesce(oi.weight_g, 0) / 1000 else oi.quantity end) as qty,
           sum(oi.quantity * oi.unit_price) as rev,
           sum(case
                 when m.sold_by_weight and wi.id is not null
                   then coalesce(oi.weight_g, 0) * coalesce(grams_to_unit(wi.unit), 0) * coalesce(wi.last_unit_cost, wi.cost_per_unit)
                        + c.unit_cost * oi.quantity
                 else c.unit_cost * oi.quantity
               end) as cost,
           bool_or(c.has_recipe or wi.id is not null) as has_recipe
    from order_items oi
    join orders o on o.id = oi.order_id
    join menu_items m on m.id = oi.menu_item_id
    join c on c.id = m.id
    left join ingredients wi on wi.id = m.weight_ingredient_id
    where o.restaurant_id = p_restaurant_id and o.status = 'paid'
      and (o.paid_at at time zone v_tz)::date between p_from and p_to
    group by m.id, m.name
  )
  select s.id, s.name, round(s.qty, 3), round(s.rev, 2), round(s.cost, 2), round(s.rev - s.cost, 2), s.has_recipe
  from s
  order by s.rev - s.cost desc, s.name;
end;
$$;

-- ===== 6) ตัด/คืนสต็อกตามออเดอร์ =====
alter table orders add column if not exists stock_returned_at timestamptz;

-- วัตถุดิบดิบที่ออเดอร์ต้องใช้: สูตร (แตกสูตรย่อย) + น้ำหนักจริงของของชั่งขาย (ไม่หาร yield เพราะขายทั้งตัว)
create or replace function order_ingredient_need(p_order_id uuid, p_restaurant_id uuid)
returns table (ingredient_id uuid, qty numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  select x.ingredient_id, sum(x.qty) from (
    select e.ingredient_id, e.raw_qty as qty
    from order_items oi
    join recipes r on r.menu_item_id = oi.menu_item_id and r.restaurant_id = p_restaurant_id
    cross join lateral recipe_expand(r.id, oi.quantity::numeric) e
    where oi.order_id = p_order_id
    union all
    select m.weight_ingredient_id, oi.weight_g * grams_to_unit(i.unit)
    from order_items oi
    join menu_items m on m.id = oi.menu_item_id and m.sold_by_weight
    join ingredients i on i.id = m.weight_ingredient_id and i.restaurant_id = p_restaurant_id
    where oi.order_id = p_order_id and oi.weight_g is not null and grams_to_unit(i.unit) is not null
  ) x
  group by x.ingredient_id;
$$;

-- ครัวกด "เริ่มทำ" (ครั้งแรกที่ออกจาก received): ตัดตามสูตร · ไม่พอ = เริ่มทำไม่ได้ (insufficient_stock: ชื่อวัตถุดิบ)
-- ยกเลิกหลังตัดแล้ว: คืนทุกรายการตัดของออเดอร์นี้ (กลับรายการ ลงล็อตเดิม)
create or replace function deduct_stock_for_order()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.stock_deducted_at is null
     and new.status in ('preparing', 'ready', 'served', 'paid') then
    insert into stock_movements (restaurant_id, ingredient_id, change, type, order_id, note)
    select new.restaurant_id, n.ingredient_id, -round(n.qty, 3), 'recipe_deduct', new.id, 'ตัดตามสูตร'
    from order_ingredient_need(new.id, new.restaurant_id) n
    where round(n.qty, 3) > 0
    order by n.ingredient_id;
    new.stock_deducted_at := now();
  end if;

  if new.status = 'cancelled' and old.status is distinct from 'cancelled'
     and new.stock_deducted_at is not null and new.stock_returned_at is null then
    insert into stock_movements (restaurant_id, ingredient_id, change, type, order_id, reverses_id, note)
    select m.restaurant_id, m.ingredient_id, -m.change, 'recipe_return', new.id, m.id, 'คืนสต็อก: ยกเลิกออเดอร์'
    from stock_movements m
    where m.order_id = new.id and m.type = 'recipe_deduct'
      and not exists (select 1 from stock_movements x where x.reverses_id = m.id)
    order by m.ingredient_id;
    new.stock_returned_at := now();
  end if;
  return new;
end;
$$;

-- บัญชีของออเดอร์ (เหมือน 0026) ยกเว้นตอนยกเลิก: สต็อกถูกคืนแล้ว รายการคืนสต็อกกลับต้นทุนขายให้เอง
-- จึงไม่ต้องย้ายต้นทุนขายไปส่วนต่างสต็อกอีก
create or replace function orders_accounting()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bill uuid;
begin
  if new.import_batch is not null or new.is_demo then
    return null;
  end if;

  if new.status = 'paid' and old.status <> 'paid' then
    perform acct_post_bill(new);
  end if;

  if new.status = 'cancelled' and old.status <> 'cancelled' and old.status = 'paid' then
    select id into v_bill from journal_entries
    where restaurant_id = new.restaurant_id and source_type = 'bill' and source_id = new.id
      and not exists (select 1 from journal_entries x where x.reverses_entry_id = journal_entries.id)
    limit 1;
    if v_bill is not null then
      perform acct_reverse_internal(v_bill, coalesce(new.cancel_reason, 'ยกเลิกบิล'));
    end if;
  end if;
  return null;
end;
$$;

-- ===== 7) ปิด/เปิดเมนูตามสต็อก =====
-- stock_disabled = ระบบปิดให้เพราะของไม่พอ (เปิดคืนเองเมื่อของพอ) · ปิดเองด้วยมือ ระบบไม่ไปเปิดให้
alter table menu_items add column if not exists stock_disabled boolean not null default false;

-- เมนูทำได้อย่างน้อย 1 ที่ไหม (ทุกวัตถุดิบดิบตามสูตรต้องพอ · ขายตามน้ำหนักต้องมีของเหลือ)
create or replace function menu_item_in_stock(p_menu_item_id uuid)
returns boolean
language sql stable security invoker set search_path = public, pg_temp as $$
  select not exists (
           select 1 from recipes r
           cross join lateral recipe_expand(r.id, 1) e
           join ingredients i on i.id = e.ingredient_id
           where r.menu_item_id = p_menu_item_id and round(e.raw_qty, 3) > i.quantity_on_hand
         )
     and not exists (
           select 1 from menu_items m join ingredients wi on wi.id = m.weight_ingredient_id
           where m.id = p_menu_item_id and m.sold_by_weight and wi.quantity_on_hand <= 0
         );
$$;

create or replace function stock_sync_menus(p_ingredient_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  with recursive up(recipe_id, depth) as (
    select recipe_id, 0 from recipe_lines where ingredient_id = p_ingredient_id
    union all
    select l.recipe_id, up.depth + 1 from recipe_lines l join up on l.sub_recipe_id = up.recipe_id where up.depth < 20
  ),
  menus as (
    select r.menu_item_id as id from recipes r join up on up.recipe_id = r.id where r.menu_item_id is not null
    union
    select id from menu_items where weight_ingredient_id = p_ingredient_id and sold_by_weight
  ),
  chk as (
    select m.id, menu_item_in_stock(m.id) as ok
    from menu_items m where m.id in (select id from menus) and (m.is_available or m.stock_disabled)
  )
  update menu_items m
     set is_available = chk.ok, stock_disabled = not chk.ok
    from chk
   where m.id = chk.id and (m.is_available <> chk.ok);
end;
$$;

create or replace function stock_movements_sync_menus()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform stock_sync_menus(new.ingredient_id);
  return null;
end;
$$;
drop trigger if exists stock_movements_sync_menus on stock_movements;
create trigger stock_movements_sync_menus after insert on stock_movements
  for each row execute function stock_movements_sync_menus();

-- สลับสถานะเองด้วยมือ = ไม่ใช่ระบบปิด
create or replace function set_menu_availability(p_item_id uuid, p_available boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rid uuid;
begin
  select restaurant_id into v_rid from menu_items where id = p_item_id;
  if v_rid is null or not has_role(v_rid, array['owner', 'manager', 'staff', 'kitchen', 'stock']) then
    raise exception 'forbidden';
  end if;
  update menu_items set is_available = p_available, stock_disabled = false where id = p_item_id;
end;
$$;

revoke execute on function recipe_expand(uuid, numeric) from public, anon;
revoke execute on function recipe_unit_cost(uuid) from public, anon;
revoke execute on function recipes_recost(uuid[], uuid[]) from public, anon, authenticated;
revoke execute on function order_ingredient_need(uuid, uuid) from public, anon, authenticated;
revoke execute on function stock_sync_menus(uuid) from public, anon, authenticated;
revoke execute on function menu_item_in_stock(uuid) from public, anon;
grant execute on function recipe_expand(uuid, numeric) to authenticated;
grant execute on function recipe_unit_cost(uuid) to authenticated;
grant execute on function menu_item_in_stock(uuid) to authenticated;

-- ========================================================================
-- เดิม: 0029_stock_operations.sql
-- ========================================================================

-- 0029: งานประจำวันของสต็อก (โมดูลสต็อกวัตถุดิบ ตอนที่ 3/4)
--   - รับเข้า: เลือกผู้ขาย จำนวน ราคา ขนาดบรรจุ วันหมดอายุ -> สร้างล็อต · เตือนเมื่อราคา/ขนาดบรรจุเปลี่ยนจากครั้งก่อน
--     ราคาเปลี่ยน -> ราคาซื้อล่าสุดของวัตถุดิบเปลี่ยน -> คำนวณต้นทุนทุกสูตรที่ใช้ใหม่ (0028)
--   - นับสต็อก (Actual vs Theoretical):
--       ยอดที่ควรเหลือ = นับรอบก่อน + นำเข้า − ตัดตามสูตร   (= ยอดใน ledger ตอนนับ)
--       ส่วนต่าง = นับจริง − ยอดที่ควรเหลือ   (ติดลบ = ของหายไม่ทราบสาเหตุ)
--       สี: เขียว |%| < 2 · เหลือง 2-5 · แดง > 5 ของยอดที่ควรเหลือ · ติดลบต่อเนื่อง 3 รอบ = สูตรหรือ yield อาจไม่ตรง
--     นับแบบ blind: ใบนับไม่มียอดในระบบ · บันทึกแล้วปรับยอดทันที (count_adjust) · ผู้ตรวจ (เจ้าของ/ผู้จัดการ) เซ็นรับรองภายหลัง
--   - Yield test: ชั่งก่อน-หลัง 3 ครั้ง บันทึกค่าเฉลี่ย (เลือกนำไปใช้กับวัตถุดิบได้)
--   - Par = ใช้ต่อวัน x (lead time + รอบสั่ง) + safety stock · แนะนำสั่ง = par − คงเหลือ
--   - ภาพรวม ประวัติ และการกลับรายการ

-- ===== 1) ใบรับของ =====
alter table stock_receipt_lines add column if not exists pack_qty numeric(14,3) check (pack_qty > 0);       -- จำนวนแพ็ค/ลัง
alter table stock_receipt_lines add column if not exists pack_size numeric(14,3) check (pack_size > 0);     -- 1 แพ็ค = ? หน่วยฐาน
alter table stock_receipt_lines add column if not exists pack_price numeric(14,4) check (pack_price >= 0);  -- ราคาต่อแพ็ค
alter table stock_receipt_lines add column if not exists expiry_date date;
alter table stock_receipt_lines add column if not exists prev_pack_size numeric(14,3);
alter table stock_receipt_lines add column if not exists price_change_pct numeric(8,2);     -- เทียบราคาต่อหน่วยฐานครั้งก่อน
alter table stock_receipt_lines add column if not exists pack_changed boolean not null default false;

-- p_lines: [{
--   "ingredient_id": "...",
--   "pack_qty": 3, "pack_size": 1000, "pack_price": 180,   แบบแพ็ค: 3 ถุง x 1000 g @ 180 บาท/ถุง
--   "quantity": 3000, "unit_cost": 0.18,                    หรือกรอกเป็นหน่วยฐานตรงๆ (รับจริง)
--   "expiry_date": "2026-11-02",
--   "invoice_qty", "invoice_unit", "invoice_unit_qty", "gross_qty", "entered_*", "note"   ตรวจรับเทียบบิล (0025)
-- }]
drop function if exists submit_stock_receipt(uuid, jsonb, text, text, date, text, boolean);
create function submit_stock_receipt(
  p_restaurant_id uuid,
  p_lines jsonb,
  p_supplier text default null,
  p_invoice_no text default null,
  p_received_on date default null,
  p_note text default null,
  p_record_expense boolean default true,
  p_supplier_id uuid default null
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
  v_on date := coalesce(p_received_on, current_date);
  v_qty numeric;
  v_cost numeric;
  v_inv numeric;
  v_status text;
  v_claim numeric;
  v_prev record;
  v_diff_unit boolean;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock']) then
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
  if v_on > current_date + 1 then
    raise exception 'invalid_date';
  end if;
  if p_supplier_id is not null then
    select name into v_supplier from suppliers where id = p_supplier_id and restaurant_id = p_restaurant_id;
    if v_supplier is null then
      raise exception 'invalid_supplier';
    end if;
  end if;

  select coalesce((select receive_tolerance_pct from shop_settings where restaurant_id = p_restaurant_id), 2) into v_tol;
  select coalesce(display_name, email) into v_name from app_users where id = auth.uid();
  insert into stock_receipts (restaurant_id, supplier, supplier_id, invoice_no, received_on, note, received_by, received_by_name)
  values (p_restaurant_id, v_supplier, p_supplier_id, nullif(left(trim(p_invoice_no), 50), ''),
          v_on, nullif(left(trim(p_note), 300), ''), auth.uid(), v_name)
  returning id into v_id;
  v_label := 'รับของ' || coalesce(' ' || v_supplier, '') || coalesce(' บิล ' || nullif(trim(p_invoice_no), ''), '');

  for l in
    select i.id, i.name, i.unit, i.last_unit_cost,
           (e->>'quantity')::numeric as qty, (e->>'unit_cost')::numeric as cost,
           (e->>'pack_qty')::numeric as pack_qty, (e->>'pack_size')::numeric as pack_size,
           (e->>'pack_price')::numeric as pack_price, (e->>'expiry_date')::date as expiry,
           (e->>'invoice_qty')::numeric as inv_qty,
           nullif(left(trim(e->>'invoice_unit'), 30), '') as inv_unit,
           (e->>'invoice_unit_qty')::numeric as inv_unit_qty,
           (e->>'gross_qty')::numeric as gross,
           nullif(left(trim(e->>'entered_unit'), 30), '') as e_unit,
           (e->>'entered_qty')::numeric as e_qty, (e->>'entered_unit_cost')::numeric as e_cost,
           nullif(left(trim(e->>'note'), 200), '') as line_note
    from jsonb_array_elements(p_lines) e
    join ingredients i on i.id = (e->>'ingredient_id')::uuid and i.restaurant_id = p_restaurant_id
    order by i.id
  loop
    -- แบบแพ็ค -> หน่วยฐาน
    if l.pack_size is not null and (l.pack_size <= 0 or l.pack_size > 1000000) then raise exception 'invalid_pack_size'; end if;
    if l.pack_qty is not null and l.pack_qty < 0 then raise exception 'invalid_quantity'; end if;
    if l.pack_price is not null and l.pack_price < 0 then raise exception 'invalid_cost'; end if;
    v_qty := coalesce(l.qty, l.pack_qty * l.pack_size);
    v_cost := coalesce(l.cost, l.pack_price / l.pack_size);
    if v_qty is null or v_qty < 0 or v_qty > 100000000 then raise exception 'invalid_quantity'; end if;
    if v_cost is null or v_cost < 0 then raise exception 'invalid_cost'; end if;
    if l.inv_qty is not null and (l.inv_qty < 0 or l.inv_qty > 100000000) then raise exception 'invalid_quantity'; end if;
    if l.gross is not null and l.gross < v_qty then raise exception 'gross_less_than_net: %', l.name; end if;
    if l.expiry is not null and l.expiry < v_on then raise exception 'invalid_expiry: %', l.name; end if;
    v_inv := coalesce(l.inv_qty, v_qty);
    if v_inv = 0 and v_qty = 0 then raise exception 'invalid_quantity'; end if;

    -- ผลตรวจรับ: ห่างจากบิลเกินเกณฑ์ % = ขาด/เกิน · รับ 0 = ตีกลับ
    v_status := case
      when v_qty = 0 then 'rejected'
      when v_qty < v_inv * (1 - v_tol / 100) then 'short'
      when v_qty > v_inv * (1 + v_tol / 100) then 'over'
      else 'ok'
    end;
    v_claim := case when v_status in ('short', 'rejected') then round((v_inv - v_qty) * v_cost, 2) else 0 end;

    -- ครั้งก่อน: ผู้ขายเดียวกันก่อน แล้วจึงผู้ขายใดก็ได้
    select rl.unit_cost, rl.pack_size into v_prev
    from stock_receipt_lines rl join stock_receipts r on r.id = rl.receipt_id
    where rl.ingredient_id = l.id and r.id <> v_id and r.restaurant_id = p_restaurant_id and rl.quantity > 0
    order by (r.supplier_id is not distinct from p_supplier_id and (p_supplier_id is not null or r.supplier is not distinct from v_supplier)) desc,
             r.created_at desc
    limit 1;

    v_diff_unit := l.e_unit is not null and l.e_unit <> l.unit;
    insert into stock_receipt_lines (receipt_id, ingredient_id, ingredient_name, unit, quantity, unit_cost, line_total,
                                     entered_unit, entered_qty, entered_unit_cost,
                                     invoice_qty, invoice_unit, invoice_unit_qty, gross_qty,
                                     status, claim_value, claim_status, prev_unit_cost, line_note,
                                     pack_qty, pack_size, pack_price, expiry_date, prev_pack_size, price_change_pct, pack_changed)
    values (v_id, l.id, l.name, l.unit, round(v_qty, 3), round(v_cost, 7), round(v_qty * v_cost, 2),
            case when v_diff_unit then l.e_unit end, case when v_diff_unit then round(l.e_qty, 3) end,
            case when v_diff_unit then round(l.e_cost, 4) end,
            round(v_inv, 3), l.inv_unit, round(l.inv_unit_qty, 3), round(l.gross, 3),
            v_status, v_claim, case when v_claim > 0 then 'pending' else 'none' end, v_prev.unit_cost, l.line_note,
            l.pack_qty, l.pack_size, l.pack_price, l.expiry, v_prev.pack_size,
            case when v_prev.unit_cost > 0 then round((v_cost - v_prev.unit_cost) / v_prev.unit_cost * 100, 2) end,
            coalesce(l.pack_size <> v_prev.pack_size, false));

    if v_qty > 0 then
      insert into stock_movements (restaurant_id, ingredient_id, change, type, unit_cost, expiry_date, note, receipt_id)
      values (p_restaurant_id, l.id, round(v_qty, 3), 'receive', round(v_cost, 7), l.expiry, v_label, v_id);
      -- ราคาซื้อล่าสุด (ใช้คิดต้นทุนสูตร) เปลี่ยน -> trigger คำนวณสูตรที่เกี่ยวข้องใหม่
      if l.last_unit_cost is distinct from round(v_cost, 7) then
        perform set_config('plato.ledger', 'on', true);
        update ingredients set last_unit_cost = round(v_cost, 7) where id = l.id;
        perform set_config('plato.ledger', '', true);
      end if;
    end if;

    v_received_total := v_received_total + round(v_qty * v_cost, 2);
    v_invoice_total := v_invoice_total + round(v_inv * v_cost, 2);
    v_claim_total := v_claim_total + v_claim;
    v_items := v_items + 1;
  end loop;

  if p_record_expense and v_invoice_total > 0 then
    insert into expenses (restaurant_id, category, amount, spent_on, note)
    values (p_restaurant_id, 'ingredients', v_invoice_total, v_on, left(v_label, 200))
    returning id into v_expense;
  end if;

  update stock_receipts
     set item_count = v_items, total_cost = v_received_total, invoice_total = v_invoice_total,
         claim_total = v_claim_total, expense_id = v_expense
   where id = v_id;
  return v_id;
end;
$$;
revoke execute on function submit_stock_receipt(uuid, jsonb, text, text, date, text, boolean, uuid) from public, anon;
grant execute on function submit_stock_receipt(uuid, jsonb, text, text, date, text, boolean, uuid) to authenticated;

-- รับเข้า + สรุปคำเตือน: ราคา/ขนาดบรรจุเปลี่ยน และจำนวนสูตรที่คำนวณต้นทุนใหม่
create or replace function stock_receive(
  p_restaurant_id uuid,
  p_supplier_id uuid,
  p_lines jsonb,
  p_invoice_no text default null,
  p_received_on date default null,
  p_note text default null,
  p_record_expense boolean default true
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_before jsonb;
  v_changed uuid[];
begin
  -- ราคาซื้อล่าสุดก่อนรับ: ตัวที่เปลี่ยน = สูตรที่ใช้ถูกคำนวณใหม่ (trigger ใน 0028)
  select coalesce(jsonb_object_agg(i.id, i.last_unit_cost), '{}') into v_before
  from ingredients i
  where i.restaurant_id = p_restaurant_id
    and i.id in (select (e->>'ingredient_id')::uuid from jsonb_array_elements(p_lines) e);
  v_id := submit_stock_receipt(p_restaurant_id, p_lines, null, p_invoice_no, p_received_on, p_note, p_record_expense, p_supplier_id);
  select coalesce(array_agg(i.id), '{}') into v_changed
  from ingredients i
  where v_before ? i.id::text and i.last_unit_cost is distinct from (v_before->>i.id::text)::numeric;
  return jsonb_build_object(
    'receipt_id', v_id,
    'warnings', coalesce((
      select jsonb_agg(jsonb_build_object(
               'ingredient_id', ingredient_id, 'ingredient_name', ingredient_name,
               'price_change_pct', price_change_pct, 'prev_unit_cost', prev_unit_cost, 'unit_cost', unit_cost,
               'pack_changed', pack_changed, 'prev_pack_size', prev_pack_size, 'pack_size', pack_size)
             order by ingredient_name)
      from stock_receipt_lines
      where receipt_id = v_id and (coalesce(price_change_pct, 0) <> 0 or pack_changed)
    ), '[]'::jsonb),
    'recosted_recipes', (
      with recursive up(id, depth) as (
        select recipe_id, 0 from recipe_lines where ingredient_id = any(v_changed)
        union all
        select l.recipe_id, up.depth + 1 from recipe_lines l join up on l.sub_recipe_id = up.id where up.depth < 20
      )
      select count(distinct id) from up
    )
  );
end;
$$;
revoke execute on function stock_receive(uuid, uuid, jsonb, text, date, text, boolean) from public, anon;
grant execute on function stock_receive(uuid, uuid, jsonb, text, date, text, boolean) to authenticated;

-- ราคา/ขนาดบรรจุครั้งล่าสุดต่อวัตถุดิบ (หน้ารับเข้าเตือนได้ตั้งแต่ก่อนบันทึก) · ผู้ขายเดียวกันก่อน
create or replace function stock_last_purchases(p_restaurant_id uuid, p_supplier_id uuid default null)
returns table (ingredient_id uuid, unit_cost numeric, pack_size numeric, pack_price numeric, supplier_id uuid, supplier text, received_on date)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;
  return query
  select distinct on (rl.ingredient_id) rl.ingredient_id, rl.unit_cost, rl.pack_size, rl.pack_price, r.supplier_id, r.supplier, r.received_on
  from stock_receipt_lines rl join stock_receipts r on r.id = rl.receipt_id
  where r.restaurant_id = p_restaurant_id and rl.quantity > 0
  order by rl.ingredient_id, (p_supplier_id is not null and r.supplier_id = p_supplier_id) desc, r.created_at desc;
end;
$$;
revoke execute on function stock_last_purchases(uuid, uuid) from public, anon;
grant execute on function stock_last_purchases(uuid, uuid) to authenticated;

-- ===== 2) กลับรายการ (ledger แก้ย้อนหลังไม่ได้) =====
-- รับเข้าผิด/นับผิด -> สร้างรายการตรงข้ามที่อ้างรายการเดิม · ตัด/คืนตามสูตรกลับได้ด้วยการยกเลิกออเดอร์เท่านั้น
create or replace function stock_reverse_movement(p_movement_id uuid, p_reason text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m stock_movements;
  v_id uuid;
begin
  select * into m from stock_movements where id = p_movement_id;
  if m.id is null or not has_role(m.restaurant_id, array['owner', 'manager']) then
    raise exception 'forbidden';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'reason_required';
  end if;
  if m.type not in ('receive', 'count_adjust') or m.reverses_id is not null then
    raise exception 'reverse_not_allowed: %', m.type;
  end if;
  if exists (select 1 from stock_movements where reverses_id = m.id) then
    raise exception 'already_reversed';
  end if;
  insert into stock_movements (restaurant_id, ingredient_id, change, type, reverses_id, receipt_id, count_id, note)
  values (m.restaurant_id, m.ingredient_id, -m.change, m.type, m.id, m.receipt_id, m.count_id,
          left('กลับรายการ: ' || trim(p_reason), 200))
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function stock_reverse_movement(uuid, text) from public, anon;
grant execute on function stock_reverse_movement(uuid, text) to authenticated;

-- ===== 3) นับสต็อก =====
alter table stock_counts drop constraint if exists stock_counts_count_type_check;
alter table stock_counts add constraint stock_counts_count_type_check check (count_type in ('daily', 'weekly', 'monthly', 'spot'));
alter table stock_counts add column if not exists period text generated always as (count_type) stored;    -- ชื่อตามสเปก
alter table stock_counts add column if not exists verified_by uuid references app_users(id) on delete set null;
alter table stock_counts add column if not exists verified_by_name text;
alter table stock_counts add column if not exists verified_at timestamptz;

alter table stock_count_lines add column if not exists opening_qty numeric(14,3);    -- นับรอบก่อน
alter table stock_count_lines add column if not exists received_qty numeric(14,3);   -- นำเข้าระหว่างรอบ
alter table stock_count_lines add column if not exists deducted_qty numeric(14,3);   -- ตัดตามสูตรสุทธิ (หักคืนแล้ว)
alter table stock_count_lines add column if not exists note text check (char_length(note) <= 200);   -- เหตุผล (ไม่บังคับ)
alter table stock_count_lines alter column system_qty type numeric(14,3);
alter table stock_count_lines alter column counted_qty type numeric(14,3);
alter table stock_count_lines alter column diff type numeric(14,3);
alter table stock_count_lines add column if not exists expected_qty numeric(14,3) generated always as (system_qty) stored;
alter table stock_count_lines add column if not exists variance_qty numeric(14,3) generated always as (diff) stored;
alter table stock_count_lines add column if not exists variance_value numeric(14,2) generated always as (round(diff * unit_cost, 2)) stored;
alter table stock_count_lines add column if not exists variance_pct numeric(10,2)
  generated always as (case when system_qty > 0 then round(diff / system_qty * 100, 2) end) stored;

-- สีของส่วนต่าง (ใช้ทั้งฐานข้อมูลและหน้าเว็บ: frontend/src/lib/stockMath.ts)
create or replace function stock_variance_color(p_expected numeric, p_variance numeric)
returns text
language sql immutable set search_path = public, pg_temp as $$
  select case
    when coalesce(p_expected, 0) <= 0 then case when coalesce(p_variance, 0) = 0 then 'green' else 'red' end
    when abs(p_variance) / p_expected * 100 < 2 then 'green'
    when abs(p_variance) / p_expected * 100 <= 5 then 'yellow'
    else 'red'
  end;
$$;

-- p_lines: [{ "ingredient_id": "...", "counted_qty": 1250, "entered_text": "2 ถุง + 250 g", "note": "..." }] (หน่วยฐาน)
drop function if exists submit_stock_count(uuid, jsonb, text, text);
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
  v_counted numeric;
  v_from timestamptz;
  v_recv numeric;
  v_used numeric;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock']) then
    raise exception 'forbidden';
  end if;
  if coalesce(p_count_type, 'spot') not in ('daily', 'weekly', 'monthly', 'spot') then
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
    where not exists (select 1 from ingredients i where i.id = (e->>'ingredient_id')::uuid and i.restaurant_id = p_restaurant_id)
  ) then
    raise exception 'invalid_ingredient';
  end if;

  select coalesce(display_name, email) into v_name from app_users where id = auth.uid();
  insert into stock_counts (restaurant_id, counted_by, counted_by_name, note, count_type)
  values (p_restaurant_id, auth.uid(), v_name, nullif(left(trim(p_note), 300), ''), coalesce(p_count_type, 'spot'))
  returning id into v_id;

  for l in
    select i.id, i.name, i.unit, i.quantity_on_hand, i.cost_per_unit,
           (e->>'counted_qty')::numeric as counted, e->>'entered_text' as entered, e->>'note' as line_note
    from jsonb_array_elements(p_lines) e
    join ingredients i on i.id = (e->>'ingredient_id')::uuid and i.restaurant_id = p_restaurant_id
    order by i.id
    for update of i
  loop
    if l.counted is null or l.counted < 0 or l.counted > 100000000 then
      raise exception 'invalid_quantity';
    end if;
    v_counted := round(l.counted, 3);

    -- รอบนี้เริ่มจากการนับครั้งก่อนของวัตถุดิบนี้
    select max(c.created_at) into v_from
    from stock_count_lines cl join stock_counts c on c.id = cl.count_id
    where cl.ingredient_id = l.id and c.id <> v_id;
    select coalesce(sum(change) filter (where type = 'receive'), 0),
           coalesce(-sum(change) filter (where type in ('recipe_deduct', 'recipe_return')), 0)
      into v_recv, v_used
    from stock_movements
    where ingredient_id = l.id and (v_from is null or created_at > v_from);

    insert into stock_count_lines (count_id, ingredient_id, ingredient_name, unit, system_qty, counted_qty, diff, unit_cost,
                                   entered_text, opening_qty, received_qty, deducted_qty, note)
    values (v_id, l.id, l.name, l.unit, l.quantity_on_hand, v_counted, v_counted - l.quantity_on_hand, l.cost_per_unit,
            nullif(left(trim(l.entered), 100), ''), l.quantity_on_hand - v_recv + v_used, v_recv, v_used,
            nullif(left(trim(l.line_note), 200), ''));

    v_items := v_items + 1;
    if v_counted <> l.quantity_on_hand then
      v_diffs := v_diffs + 1;
      v_value := v_value + (v_counted - l.quantity_on_hand) * l.cost_per_unit;
      insert into stock_movements (restaurant_id, ingredient_id, change, type, note, count_id)
      values (p_restaurant_id, l.id, v_counted - l.quantity_on_hand, 'count_adjust', 'นับสต็อก', v_id);
    end if;
  end loop;

  update stock_counts set item_count = v_items, diff_count = v_diffs, diff_value = round(v_value, 2) where id = v_id;
  return v_id;
end;
$$;
revoke execute on function submit_stock_count(uuid, jsonb, text, text) from public, anon;
grant execute on function submit_stock_count(uuid, jsonb, text, text) to authenticated;

-- ผู้ตรวจรับรองใบนับ: เจ้าของ/ผู้จัดการ · ผู้จัดการรับรองใบที่ตัวเองนับไม่ได้ (เจ้าของทำได้ เผื่อร้านคนเดียว)
create or replace function verify_stock_count(p_count_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c stock_counts;
begin
  select * into c from stock_counts where id = p_count_id;
  if c.id is null or not has_role(c.restaurant_id, array['owner', 'manager']) then
    raise exception 'forbidden';
  end if;
  if c.verified_at is not null then
    raise exception 'already_verified';
  end if;
  if c.counted_by = auth.uid() and not has_role(c.restaurant_id, array['owner']) then
    raise exception 'cannot_verify_own_count';
  end if;
  update stock_counts
     set verified_by = auth.uid(), verified_at = now(),
         verified_by_name = (select coalesce(display_name, email) from app_users where id = auth.uid())
   where id = p_count_id;
end;
$$;
revoke execute on function verify_stock_count(uuid) from public, anon;
grant execute on function verify_stock_count(uuid) to authenticated;

-- ใบนับแบบ blind: ไม่มียอดในระบบ · เรียงตามตำแหน่งจัดเก็บ (shelf-to-sheet) · กรองคลาส ABC ได้
create or replace function stock_count_sheet(p_restaurant_id uuid, p_abc text[] default null)
returns table (ingredient_id uuid, name text, recipe_unit text, unit text, display_unit text, display_factor numeric,
               purchase_unit text, conversion_factor numeric, abc_class text, storage_location text, shelf_order int)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock']) then
    raise exception 'forbidden';
  end if;
  return query
  select i.id, i.name, i.recipe_unit, i.unit, i.display_unit, i.display_factor, i.purchase_unit, i.conversion_factor,
         i.abc_class, i.storage_location, i.shelf_order
  from ingredients i
  where i.restaurant_id = p_restaurant_id and i.is_active
    and (p_abc is null or cardinality(p_abc) = 0 or i.abc_class = any(p_abc))
  order by i.storage_location nulls last, i.shelf_order, i.name;
end;
$$;
revoke execute on function stock_count_sheet(uuid, text[]) from public, anon;
grant execute on function stock_count_sheet(uuid, text[]) to authenticated;

-- ติดลบต่อเนื่องกี่รอบ นับจากใบล่าสุดย้อนไป (ณ เวลา p_until) · >= 3 = สูตรหรือ yield อาจไม่ตรง
create or replace function stock_negative_streaks(p_restaurant_id uuid, p_until timestamptz default null)
returns table (ingredient_id uuid, streak int)
language sql stable security definer set search_path = public, pg_temp as $$
  with l as (
    select cl.ingredient_id, cl.diff,
           row_number() over (partition by cl.ingredient_id order by c.created_at desc, c.id) as rn
    from stock_count_lines cl join stock_counts c on c.id = cl.count_id
    where c.restaurant_id = p_restaurant_id and (p_until is null or c.created_at <= p_until)
  )
  select ingredient_id, (coalesce(min(rn) filter (where diff >= 0), max(rn) + 1) - 1)::int
  from l group by ingredient_id;
$$;
revoke execute on function stock_negative_streaks(uuid, timestamptz) from public, anon, authenticated;

-- ===== 4) รายงานส่วนต่างของใบนับ: เรียงตามมูลค่า แสดงหน่วย / บาท / % =====
drop function if exists stock_variance(uuid, uuid, uuid);
drop function if exists theoretical_usage(uuid, timestamptz, timestamptz);
create or replace function stock_variance_report(p_restaurant_id uuid, p_count_id uuid)
returns table (
  ingredient_id uuid, ingredient_name text, unit text, display_unit text, display_factor numeric, abc_class text,
  opening_qty numeric, received_qty numeric, deducted_qty numeric, expected_qty numeric, counted_qty numeric,
  variance_qty numeric, variance_value numeric, variance_pct numeric, color text, negative_streak int, recipe_alert boolean,
  note text, entered_text text
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_at timestamptz;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;
  select created_at into v_at from stock_counts where id = p_count_id and restaurant_id = p_restaurant_id;
  if v_at is null then
    raise exception 'invalid_count';
  end if;
  return query
  select cl.ingredient_id, cl.ingredient_name, cl.unit, i.display_unit, i.display_factor, i.abc_class,
         cl.opening_qty, cl.received_qty, cl.deducted_qty, cl.expected_qty, cl.counted_qty,
         cl.variance_qty, cl.variance_value, cl.variance_pct,
         stock_variance_color(cl.expected_qty, cl.variance_qty),
         coalesce(s.streak, 0), coalesce(s.streak, 0) >= 3,
         cl.note, cl.entered_text
  from stock_count_lines cl
  left join ingredients i on i.id = cl.ingredient_id
  left join stock_negative_streaks(p_restaurant_id, v_at) s on s.ingredient_id = cl.ingredient_id
  where cl.count_id = p_count_id
  order by abs(cl.variance_value) desc, cl.ingredient_name;
end;
$$;
revoke execute on function stock_variance_report(uuid, uuid) from public, anon;
grant execute on function stock_variance_report(uuid, uuid) to authenticated;

-- ===== 5) Yield test =====
create table if not exists yield_tests (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  ingredient_id uuid not null references ingredients(id) on delete cascade,
  kind text not null check (kind in ('trim', 'cook')),
  trials jsonb not null,                     -- [{ "before": 1000, "after": 620 }, ...] 3 ครั้ง (หน่วยฐาน)
  avg_pct numeric(6,2) not null check (avg_pct > 0),
  applied boolean not null default false,    -- นำค่าเฉลี่ยไปตั้งเป็น yield ของวัตถุดิบแล้ว
  note text check (char_length(note) <= 200),
  tested_by uuid references app_users(id) on delete set null,
  tested_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists yield_tests_ingredient_idx on yield_tests (ingredient_id, created_at desc);

-- ค่าเฉลี่ย = เฉลี่ยของ (หลัง ÷ ก่อน x 100) ทั้ง 3 ครั้ง (frontend/src/lib/stockMath.ts ใช้สูตรเดียวกัน)
create or replace function record_yield_test(
  p_restaurant_id uuid, p_ingredient_id uuid, p_kind text, p_trials jsonb, p_apply boolean default false, p_note text default null
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_avg numeric;
  v_id uuid;
  v_bad boolean;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock']) then
    raise exception 'forbidden';
  end if;
  if not exists (select 1 from ingredients where id = p_ingredient_id and restaurant_id = p_restaurant_id) then
    raise exception 'invalid_ingredient';
  end if;
  if p_kind not in ('trim', 'cook') then
    raise exception 'invalid_kind';
  end if;
  if p_trials is null or jsonb_typeof(p_trials) <> 'array' or jsonb_array_length(p_trials) <> 3 then
    raise exception 'three_trials_required';
  end if;
  select bool_or(
           (t->>'before')::numeric is null or (t->>'after')::numeric is null
           or (t->>'before')::numeric <= 0 or (t->>'after')::numeric <= 0
           or (p_kind = 'trim' and (t->>'after')::numeric > (t->>'before')::numeric)
           or (t->>'after')::numeric > (t->>'before')::numeric * 4),
         round(avg((t->>'after')::numeric / (t->>'before')::numeric * 100), 2)
    into v_bad, v_avg
  from jsonb_array_elements(p_trials) t;
  if v_bad then
    raise exception 'invalid_trial';
  end if;

  insert into yield_tests (restaurant_id, ingredient_id, kind, trials, avg_pct, applied, note, tested_by, tested_by_name)
  values (p_restaurant_id, p_ingredient_id, p_kind,
          (select jsonb_agg(jsonb_build_object('before', (t->>'before')::numeric, 'after', (t->>'after')::numeric)) from jsonb_array_elements(p_trials) t),
          v_avg, coalesce(p_apply, false), nullif(left(trim(p_note), 200), ''), auth.uid(),
          (select coalesce(display_name, email) from app_users where id = auth.uid()))
  returning id into v_id;

  -- นำไปใช้: ตั้ง yield ของวัตถุดิบ -> ต้นทุนสูตรที่เกี่ยวข้องคำนวณใหม่ (0028)
  if p_apply then
    if p_kind = 'trim' then
      update ingredients set trim_yield_pct = v_avg where id = p_ingredient_id;
    else
      update ingredients set cook_yield_pct = v_avg where id = p_ingredient_id;
    end if;
  end if;
  return jsonb_build_object('id', v_id, 'avg_pct', v_avg, 'applied', coalesce(p_apply, false));
end;
$$;
revoke execute on function record_yield_test(uuid, uuid, text, jsonb, boolean, text) from public, anon;
grant execute on function record_yield_test(uuid, uuid, text, jsonb, boolean, text) to authenticated;

-- ===== 6) Par และจำนวนแนะนำสั่ง =====
-- ใช้ต่อวัน = ของที่ออกจริงย้อนหลัง p_days วัน (ตัดตามสูตรสุทธิ + ส่วนต่างติดลบจากการนับ) ÷ p_days
-- รอบสั่ง = 7 ÷ จำนวนวันที่ผู้ขายมาส่งต่อสัปดาห์ · ไม่มีผู้ขาย: lead time 1 วัน รอบสั่ง 7 วัน
-- par_level ที่ตั้งเองมาก่อนค่าที่คำนวณ
create or replace function stock_reorder_suggestions(p_restaurant_id uuid, p_days int default 28)
returns table (
  ingredient_id uuid, name text, unit text, on_hand numeric, daily_usage numeric,
  lead_time_days int, cycle_days numeric, safety_stock numeric, par numeric, par_source text,
  suggested_qty numeric, purchase_unit text, conversion_factor numeric, suggested_purchase_qty numeric,
  supplier_id uuid, supplier_name text, order_today boolean, next_delivery date
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_days int := least(greatest(coalesce(p_days, 28), 1), 365);
  v_today date;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;
  select (now() at time zone timezone)::date into v_today from restaurants where id = p_restaurant_id;
  return query
  with usage as (
    select m.ingredient_id,
           coalesce(-sum(m.change) filter (where m.type in ('recipe_deduct', 'recipe_return')), 0)
           + coalesce(-sum(m.change) filter (where m.type = 'count_adjust' and m.change < 0 and m.reverses_id is null), 0) as used
    from stock_movements m
    where m.restaurant_id = p_restaurant_id and m.created_at >= now() - make_interval(days => v_days)
    group by m.ingredient_id
  ),
  base as (
    select i.*, s.id as sup_id, s.name as sup_name,
           coalesce(s.lead_time_days, 1) as lead,
           case when s.id is null then 7.0 else 7.0 / cardinality(s.delivery_days) end as cycle,
           coalesce(u.used, 0) / v_days as daily
    from ingredients i
    left join suppliers s on s.id = i.supplier_id
    left join usage u on u.ingredient_id = i.id
    where i.restaurant_id = p_restaurant_id and i.is_active
  ),
  calc as (
    select b.*, coalesce(b.par_level, round(b.daily * (b.lead + b.cycle) + b.safety_stock, 3)) as par_v
    from base b
  )
  select c.id, c.name, c.unit, c.quantity_on_hand, round(c.daily, 3), c.lead, round(c.cycle, 2), c.safety_stock,
         c.par_v, case when c.par_level is null then 'auto' else 'manual' end,
         greatest(round(c.par_v - c.quantity_on_hand, 3), 0),
         c.purchase_unit, c.conversion_factor,
         ceil(greatest(c.par_v - c.quantity_on_hand, 0) / c.conversion_factor),
         c.sup_id, c.sup_name,
         c.sup_id is null or exists (
           select 1 from suppliers s where s.id = c.sup_id
             and extract(dow from v_today + c.lead)::int = any(s.delivery_days)),
         (select v_today + c.lead + g from generate_series(0, 6) g, suppliers s
           where c.sup_id is not null and s.id = c.sup_id and extract(dow from v_today + c.lead + g)::int = any(s.delivery_days)
           order by g limit 1)
  from calc c
  order by greatest(c.par_v - c.quantity_on_hand, 0) * c.cost_per_unit desc, c.name;
end;
$$;
revoke execute on function stock_reorder_suggestions(uuid, int) from public, anon;
grant execute on function stock_reorder_suggestions(uuid, int) to authenticated;

-- ===== 7) ภาพรวม =====
create or replace function stock_overview(p_restaurant_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_today date;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;
  select (now() at time zone timezone)::date into v_today from restaurants where id = p_restaurant_id;
  return jsonb_build_object(
    'today', v_today,
    'stock_value', (select coalesce(round(sum(fifo_remaining * raw_unit_cost), 2), 0) from stock_lots where restaurant_id = p_restaurant_id),
    'ingredient_count', (select count(*) from ingredients where restaurant_id = p_restaurant_id and is_active),
    'out', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'unit', unit) order by name)
      from ingredients where restaurant_id = p_restaurant_id and is_active and quantity_on_hand <= 0), '[]'::jsonb),
    'low', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'unit', unit, 'on_hand', quantity_on_hand,
                                          'threshold', t, 'display_unit', display_unit, 'display_factor', display_factor)
                       order by quantity_on_hand / t, name)
      from (select *, case when reorder_level > 0 then reorder_level else safety_stock end as t
            from ingredients where restaurant_id = p_restaurant_id and is_active) x
      where t > 0 and quantity_on_hand > 0 and quantity_on_hand <= t), '[]'::jsonb),
    'expiring', coalesce((
      select jsonb_agg(jsonb_build_object('lot_id', l.id, 'ingredient_id', i.id, 'name', i.name, 'unit', i.unit,
                                          'qty', l.qty_remaining, 'expiry_date', l.expiry_date,
                                          'days_left', l.expiry_date - v_today,
                                          'value', round(l.qty_remaining * l.raw_unit_cost, 2))
                       order by l.expiry_date, i.name)
      from stock_lots l join ingredients i on i.id = l.ingredient_id
      where l.restaurant_id = p_restaurant_id and l.qty_remaining > 0 and l.expiry_date <= v_today + 3), '[]'::jsonb),
    'reorder_today', coalesce((
      select jsonb_agg(to_jsonb(s)) from stock_reorder_suggestions(p_restaurant_id) s
      where s.suggested_qty > 0 and s.order_today), '[]'::jsonb),
    'recipe_alerts', coalesce((
      select jsonb_agg(jsonb_build_object('ingredient_id', i.id, 'name', i.name, 'streak', s.streak) order by s.streak desc, i.name)
      from stock_negative_streaks(p_restaurant_id) s join ingredients i on i.id = s.ingredient_id
      where s.streak >= 3), '[]'::jsonb),
    'stock_disabled_menus', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name)
      from menu_items where restaurant_id = p_restaurant_id and stock_disabled), '[]'::jsonb),
    'last_count', (
      select jsonb_build_object('id', id, 'created_at', created_at, 'count_type', count_type,
                                'counted_by_name', counted_by_name, 'verified_at', verified_at, 'diff_value', diff_value)
      from stock_counts where restaurant_id = p_restaurant_id order by created_at desc limit 1)
  );
end;
$$;
revoke execute on function stock_overview(uuid) from public, anon;
grant execute on function stock_overview(uuid) to authenticated;

-- ===== 8) ประวัติ: กรองตามวัตถุดิบ วันที่ ผู้ทำรายการ ประเภท =====
drop function if exists stock_history(uuid, timestamptz, timestamptz, uuid, stock_reason, int);
create function stock_history(
  p_restaurant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_ingredient_id uuid default null,
  p_actor_id uuid default null,
  p_type text default null,
  p_limit int default 200
)
returns table (
  id uuid, created_at timestamptz, ingredient_id uuid, ingredient_name text, unit text,
  type text, change numeric, balance_after numeric, cost numeric, unit_cost numeric, note text,
  actor_id uuid, actor_name text, ref_id uuid, order_label text, reverses_id uuid, reversed_by uuid
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;
  return query
  select sm.id, sm.created_at, sm.ingredient_id, i.name, i.unit, sm.type, sm.change, sm.balance_after,
         sm.cost, sm.unit_cost, sm.note, sm.created_by, coalesce(u.display_name, u.email),
         sm.ref_id,
         case
           when o.id is null then null
           when o.order_type = 'takeaway' then coalesce('กลับบ้าน · ' || o.customer_label, 'กลับบ้าน')
           else coalesce(t.label, 'ไม่ระบุโต๊ะ')
         end,
         sm.reverses_id,
         (select x.id from stock_movements x where x.reverses_id = sm.id)
  from stock_movements sm
  join ingredients i on i.id = sm.ingredient_id
  left join app_users u on u.id = sm.created_by
  left join orders o on o.id = sm.order_id
  left join dining_tables t on t.id = o.table_id
  where sm.restaurant_id = p_restaurant_id
    and sm.created_at >= p_from and sm.created_at < p_to
    and (p_ingredient_id is null or sm.ingredient_id = p_ingredient_id)
    and (p_actor_id is null or sm.created_by = p_actor_id)
    and (p_type is null or sm.type = p_type)
  order by sm.created_at desc, sm.id
  limit least(greatest(p_limit, 1), 1000);
end;
$$;
revoke execute on function stock_history(uuid, timestamptz, timestamptz, uuid, uuid, text, int) from public, anon;
grant execute on function stock_history(uuid, timestamptz, timestamptz, uuid, uuid, text, int) to authenticated;

-- ===== 9) สูตร: บันทึกทั้งสูตรในธุรกรรมเดียว (หัวสูตร + แทนที่ทุกบรรทัด) =====
-- p_lines: [{ "ingredient_id": "..." } หรือ { "sub_recipe_id": "..." }, "qty": 120 }] · ปริมาณสุทธิ (หน่วยฐาน / หน่วยที่ได้ของสูตรย่อย)
create or replace function stock_save_recipe(
  p_restaurant_id uuid, p_id uuid, p_name text, p_menu_item_id uuid, p_output_qty numeric, p_output_unit text,
  p_lines jsonb, p_note text default null
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid := p_id;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock']) then
    raise exception 'forbidden';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 100 then
    raise exception 'invalid_lines';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) e
             where coalesce((e->>'qty')::numeric, 0) <= 0
                or num_nonnulls(e->>'ingredient_id', e->>'sub_recipe_id') <> 1) then
    raise exception 'invalid_lines';
  end if;
  if v_id is null then
    insert into recipes (restaurant_id, name, menu_item_id, output_qty, output_unit, note)
    values (p_restaurant_id, p_name, p_menu_item_id, p_output_qty, coalesce(nullif(trim(p_output_unit), ''), 'จาน'), nullif(left(trim(p_note), 300), ''))
    returning id into v_id;
  else
    update recipes set name = p_name, menu_item_id = p_menu_item_id, output_qty = p_output_qty,
                       output_unit = coalesce(nullif(trim(p_output_unit), ''), 'จาน'), note = nullif(left(trim(p_note), 300), '')
     where id = v_id and restaurant_id = p_restaurant_id;
    if not found then
      raise exception 'not_found';
    end if;
    delete from recipe_lines where recipe_id = v_id;
  end if;
  insert into recipe_lines (recipe_id, ingredient_id, sub_recipe_id, qty)
  select v_id, (e->>'ingredient_id')::uuid, (e->>'sub_recipe_id')::uuid, round((e->>'qty')::numeric, 3)
  from jsonb_array_elements(p_lines) e;
  perform recipes_recost('{}', array[v_id]);
  -- เมนูที่ผูก: สถานะพร้อมขายตามสต็อกใหม่
  perform stock_sync_menus(l.ingredient_id) from recipe_lines l where l.recipe_id = v_id and l.ingredient_id is not null;
  return v_id;
end;
$$;
revoke execute on function stock_save_recipe(uuid, uuid, text, uuid, numeric, text, jsonb, text) from public, anon;
grant execute on function stock_save_recipe(uuid, uuid, text, uuid, numeric, text, jsonb, text) to authenticated;

-- เมนูทั้งหมดของร้าน (รวมที่ปิดอยู่) สำหรับผูกสูตร · พนักงานสต็อกอ่าน menu_items ตรงได้เฉพาะที่เปิดขาย
create or replace function stock_menu_items(p_restaurant_id uuid)
returns table (id uuid, name text, is_available boolean, stock_disabled boolean, sold_by_weight boolean, recipe_id uuid)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock', 'accountant']) then
    raise exception 'forbidden';
  end if;
  return query
  select m.id, m.name, m.is_available, m.stock_disabled, m.sold_by_weight, r.id
  from menu_items m left join recipes r on r.menu_item_id = m.id
  where m.restaurant_id = p_restaurant_id
  order by m.name;
end;
$$;
revoke execute on function stock_menu_items(uuid) from public, anon;
grant execute on function stock_menu_items(uuid) to authenticated;

-- ========================================================================
-- เดิม: 0030_stock_rls.sql
-- ========================================================================

-- 0030: สิทธิ์ของโมดูลสต็อกวัตถุดิบ (ตอนที่ 4/4)
--   - แยกข้อมูลรายร้าน: ทุก policy ตรวจ has_role(restaurant_id, ...) ของร้านนั้น
--   - จัดการสต็อกได้เฉพาะ เจ้าของ (owner) · ผู้จัดการ (manager) · พนักงานสต็อก (stock = stock_staff ในสเปก)
--   - พนักงานบัญชีอ่านอย่างเดียว (มูลค่าสต็อก/ต้นทุนใช้ในงบการเงิน) · หน้าร้าน/ครัวไม่เห็นข้อมูลสต็อก
--     ครัวยังตัดสต็อกได้ตามปกติผ่านการกด "เริ่มทำ" (trigger security definer)
--   - ledger ล็อต ใบรับ ใบนับ yield test: อ่านได้ · เขียนผ่านฟังก์ชันเท่านั้น (ตรวจกฎครบในธุรกรรมเดียว)

create or replace function stock_can_read(rid uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select has_role(rid, array['owner', 'manager', 'stock', 'accountant']);
$$;
create or replace function stock_can_write(rid uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select has_role(rid, array['owner', 'manager', 'stock']);
$$;
revoke execute on function stock_can_read(uuid) from public, anon;
revoke execute on function stock_can_write(uuid) from public, anon;
grant execute on function stock_can_read(uuid) to authenticated;
grant execute on function stock_can_write(uuid) to authenticated;

-- ===== วัตถุดิบ =====
drop policy if exists ingredients_read on ingredients;
drop policy if exists ingredients_write on ingredients;
drop policy if exists ingredients_manager_read on ingredients;
create policy ingredients_read on ingredients for select using (stock_can_read(restaurant_id));
create policy ingredients_insert on ingredients for insert with check (stock_can_write(restaurant_id));
create policy ingredients_update on ingredients for update using (stock_can_write(restaurant_id)) with check (stock_can_write(restaurant_id));
create policy ingredients_delete on ingredients for delete using (stock_can_write(restaurant_id));

-- ยอด/ต้นทุนแก้ตรงไม่ได้ (ledger + trigger ตรวจซ้ำ) · แก้ได้เฉพาะข้อมูลตั้งค่า
revoke update on ingredients from anon, authenticated;
grant update (name, unit, reorder_level, yield_pct, variance_threshold_pct, category, count_weekly,
              recipe_unit, purchase_unit, conversion_factor, display_unit, display_factor,
              trim_yield_pct, cook_yield_pct, abc_class, storage_location, shelf_order,
              par_level, safety_stock, supplier_id, is_active) on ingredients to authenticated;
revoke insert on ingredients from anon, authenticated;
grant insert (restaurant_id, name, unit, quantity_on_hand, reorder_level, cost_per_unit, yield_pct, variance_threshold_pct,
              category, count_weekly, recipe_unit, purchase_unit, conversion_factor, display_unit, display_factor,
              trim_yield_pct, cook_yield_pct, abc_class, storage_location, shelf_order, par_level, safety_stock,
              supplier_id, is_active) on ingredients to authenticated;

-- ===== ผู้ขาย =====
alter table suppliers enable row level security;
create policy suppliers_read on suppliers for select using (stock_can_read(restaurant_id));
create policy suppliers_write on suppliers for all using (stock_can_write(restaurant_id)) with check (stock_can_write(restaurant_id));

-- ผู้ขายของวัตถุดิบต้องอยู่ร้านเดียวกัน
create or replace function ingredients_check_supplier()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.supplier_id is not null
     and not exists (select 1 from suppliers where id = new.supplier_id and restaurant_id = new.restaurant_id) then
    raise exception 'invalid_supplier';
  end if;
  return new;
end;
$$;
drop trigger if exists ingredients_check_supplier on ingredients;
create trigger ingredients_check_supplier before insert or update of supplier_id on ingredients
  for each row execute function ingredients_check_supplier();

-- ===== ledger และล็อต: อ่านอย่างเดียว =====
drop policy if exists stock_movements_read on stock_movements;
drop policy if exists stock_movements_insert on stock_movements;
create policy stock_movements_read on stock_movements for select using (stock_can_read(restaurant_id));
revoke insert, update, delete on stock_movements from anon, authenticated;

alter table stock_lots enable row level security;
create policy stock_lots_read on stock_lots for select using (stock_can_read(restaurant_id));
revoke insert, update, delete on stock_lots from anon, authenticated;

alter table stock_movement_lots enable row level security;
create policy stock_movement_lots_read on stock_movement_lots for select
  using (exists (select 1 from stock_movements m where m.id = movement_id and stock_can_read(m.restaurant_id)));
revoke insert, update, delete on stock_movement_lots from anon, authenticated;

-- ===== สูตร =====
alter table recipes enable row level security;
create policy recipes_read on recipes for select using (stock_can_read(restaurant_id));
create policy recipes_write on recipes for all using (stock_can_write(restaurant_id)) with check (stock_can_write(restaurant_id));
revoke update (cost_per_output, cost_updated_at) on recipes from anon, authenticated;
revoke update on recipes from anon, authenticated;
grant update (name, menu_item_id, output_qty, output_unit, note) on recipes to authenticated;

alter table recipe_lines enable row level security;
create policy recipe_lines_read on recipe_lines for select
  using (exists (select 1 from recipes r where r.id = recipe_id and stock_can_read(r.restaurant_id)));
create policy recipe_lines_write on recipe_lines for all
  using (exists (select 1 from recipes r where r.id = recipe_id and stock_can_write(r.restaurant_id)))
  with check (exists (select 1 from recipes r where r.id = recipe_id and stock_can_write(r.restaurant_id)));

-- สูตรเดิม/ของเตรียมเดิม: อ่านย้อนหลังได้
drop policy if exists recipes_read on legacy_menu_recipes;
drop policy if exists recipes_manager_read on legacy_menu_recipes;
create policy legacy_menu_recipes_read on legacy_menu_recipes for select
  using (exists (select 1 from menu_items m where m.id = menu_item_id and stock_can_read(m.restaurant_id)));
drop policy if exists prep_components_read on prep_components;
create policy prep_components_read on prep_components for select
  using (exists (select 1 from ingredients p where p.id = prep_id and stock_can_read(p.restaurant_id)));
drop policy if exists prep_batches_read on prep_batches;
create policy prep_batches_read on prep_batches for select using (stock_can_read(restaurant_id));

-- ===== ใบรับของ ใบนับ yield test: อ่านได้ เขียนผ่านฟังก์ชัน =====
drop policy if exists stock_receipts_read on stock_receipts;
create policy stock_receipts_read on stock_receipts for select using (stock_can_read(restaurant_id));
drop policy if exists stock_receipt_lines_read on stock_receipt_lines;
create policy stock_receipt_lines_read on stock_receipt_lines for select
  using (exists (select 1 from stock_receipts r where r.id = receipt_id and stock_can_read(r.restaurant_id)));

drop policy if exists stock_counts_read on stock_counts;
create policy stock_counts_read on stock_counts for select using (stock_can_read(restaurant_id));
drop policy if exists stock_count_lines_read on stock_count_lines;
create policy stock_count_lines_read on stock_count_lines for select
  using (exists (select 1 from stock_counts c where c.id = count_id and stock_can_read(c.restaurant_id)));

alter table yield_tests enable row level security;
create policy yield_tests_read on yield_tests for select using (stock_can_read(restaurant_id));
revoke insert, update, delete on yield_tests from anon, authenticated;

-- ===== หน่วยนับ =====
drop policy if exists units_read on units;
drop policy if exists units_write on units;
create policy units_read on units for select using (stock_can_read(restaurant_id));
create policy units_write on units for all using (stock_can_write(restaurant_id)) with check (stock_can_write(restaurant_id));

drop policy if exists ingredient_units_read on ingredient_units;
drop policy if exists ingredient_units_write on ingredient_units;
create policy ingredient_units_read on ingredient_units for select
  using (exists (select 1 from ingredients i where i.id = ingredient_id and stock_can_read(i.restaurant_id)));
-- หน่วยแปลงต้องไม่ซ้ำกับหน่วยหลัก (เหมือน 0024)
create policy ingredient_units_write on ingredient_units for all
  using (exists (select 1 from ingredients i where i.id = ingredient_id and stock_can_write(i.restaurant_id)))
  with check (exists (select 1 from ingredients i where i.id = ingredient_id and stock_can_write(i.restaurant_id)
                      and lower(trim(i.unit)) <> lower(trim(unit_name))));

-- ===== ผู้จัดการทำงานสต็อกได้ครบ: ทวงของขาด และรายงานผู้ขาย (เหมือน 0025 ยกเว้นเพิ่ม manager) =====
create or replace function set_receipt_claim(p_receipt_id uuid, p_ingredient_id uuid, p_status text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rid uuid;
  v_expense uuid;
  v_invoice numeric;
begin
  select restaurant_id, expense_id, invoice_total into v_rid, v_expense, v_invoice from stock_receipts where id = p_receipt_id;
  if v_rid is null or not has_role(v_rid, array['owner', 'manager', 'stock', 'accountant']) then
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
  if not has_role(p_restaurant_id, array['owner', 'manager', 'stock', 'accountant']) then
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
