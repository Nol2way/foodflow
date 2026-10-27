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
