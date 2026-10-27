-- 0026: โมดูลบัญชี (บัญชีคู่ double-entry เชื่อมกับโมดูลสต็อก)
--   หลักการ
--   - ทุกเหตุการณ์ลงสมุดรายวัน (journal_entries + journal_lines) อัตโนมัติ เดบิต = เครดิต ทุกรายการ
--     ตรวจตอน commit ด้วย constraint trigger (deferred) · รายการที่ลงแล้วแก้/ลบไม่ได้ ต้องกลับรายการ (reversal)
--   - สต็อกแบบ perpetual: ซื้อเข้า = สินทรัพย์ · ตัดตามสูตร = ต้นทุนขาย · นับ/ของเสีย/ผลิต = ส่วนต่างสต็อก
--     มูลค่าสต็อกต่อวัตถุดิบ = round(คงเหลือ x ต้นทุนต่อหน่วย, 2) ทุกครั้งที่มูลค่าเปลี่ยน ลงบัญชีด้วยผลต่างนั้น
--     บัญชีสต็อกจึงเท่ากับมูลค่าในโมดูลสต็อกเสมอ (acct_stock_reconcile ตรวจซ้ำ ไม่เท่า = แจ้งเตือน)
--   - ต้นทุนขายจริง = ต้นทุนตามสูตร (5010) + ส่วนต่างสต็อก (5020) = ต้นงวด + รับเข้า - ปลายงวด
--   - ปิดวันแล้ว: ห้ามลงรายการใหม่ในวันนั้น · รายการอัตโนมัติที่เกิดหลังปิดวันเข้าวันถัดไป
--   - ไม่ลงย้อนหลังให้ออเดอร์นำเข้า (import_batch) และข้อมูลทดลอง (is_demo) · ยอดสต็อกเดิมลงเป็นยอดยกมา
--   หมายเหตุ: ระบบนี้ไม่ใช่เครื่องมือยื่นภาษีอย่างเป็นทางการ ควรให้นักบัญชีตรวจ

-- ===== 1) ผังบัญชี =====
create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  code text not null check (code ~ '^[0-9]{4}$'),
  name text not null check (char_length(trim(name)) between 1 and 80),
  type text not null check (type in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  -- กลุ่มสำหรับรายงาน: เงินสด/ธนาคาร (โหมดง่าย) ยอดขาย/ส่วนลด ต้นทุนอาหาร/ค่าแรง/ค่าใช้จ่ายดำเนินงาน (Food/Prime Cost)
  grp text not null check (grp in ('cash', 'bank', 'stock', 'claim', 'vat_in', 'other_asset',
                                   'ap', 'vat_out', 'other_liability', 'equity',
                                   'sales', 'discount', 'other_income',
                                   'food_cost', 'labor', 'opex')),
  system_key text,                                -- บัญชีที่ระบบใช้ลงอัตโนมัติ (ลบ/เปลี่ยนกลุ่มไม่ได้)
  is_active boolean not null default true,
  legacy_category expense_category,               -- หมวดรายจ่ายแบบเดิม (0001) ที่ตรงกับบัญชีนี้
  created_at timestamptz not null default now(),
  unique (restaurant_id, code),
  unique (restaurant_id, system_key),
  check (
    (type = 'asset' and grp in ('cash', 'bank', 'stock', 'claim', 'vat_in', 'other_asset'))
    or (type = 'liability' and grp in ('ap', 'vat_out', 'other_liability'))
    or (type = 'equity' and grp = 'equity')
    or (type = 'revenue' and grp in ('sales', 'discount', 'other_income'))
    or (type = 'expense' and grp in ('food_cost', 'labor', 'opex'))
  )
);

create or replace function acct_seed_accounts(p_restaurant_id uuid)
returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into accounts (restaurant_id, code, name, type, grp, system_key, legacy_category)
  select p_restaurant_id, a.code, a.name, a.type, a.grp, a.key, a.legacy::expense_category
  from (values
    ('1010', 'เงินสด',                       'asset',     'cash',         'cash',            null),
    ('1020', 'ธนาคาร / QR พร้อมเพย์',          'asset',     'bank',         'bank',            null),
    ('1130', 'สต็อกวัตถุดิบ',                  'asset',     'stock',        'stock',           null),
    ('1140', 'ลูกหนี้ผู้ขาย (ของขาด รอทวง)',     'asset',     'claim',        'claim',           null),
    ('1150', 'ภาษีซื้อ',                       'asset',     'vat_in',       'vat_in',          null),
    ('2010', 'เจ้าหนี้การค้า',                  'liability', 'ap',           'ap',              null),
    ('2030', 'ภาษีขาย',                        'liability', 'vat_out',      'vat_out',         null),
    ('3010', 'ทุนเจ้าของ',                     'equity',    'equity',       'equity',          null),
    ('4010', 'รายได้ขายอาหาร',                 'revenue',   'sales',        'rev_food',        null),
    ('4020', 'รายได้เครื่องดื่ม',                'revenue',   'sales',        'rev_drink',       null),
    ('4110', 'ส่วนลดโปรโมชัน',                 'revenue',   'discount',     'disc_promo',      null),
    ('4120', 'ส่วนลดจากแต้มสมาชิก',             'revenue',   'discount',     'disc_points',     null),
    ('5010', 'ต้นทุนขาย (ตามสูตร)',             'expense',   'food_cost',    'cogs',            null),
    ('5020', 'ส่วนต่างสต็อก',                  'expense',   'food_cost',    'variance',        null),
    ('5030', 'วัตถุดิบนอกสต็อก',                'expense',   'food_cost',    'cogs_direct',     'ingredients'),
    ('5040', 'ส่วนต่างรับสินค้า',                'expense',   'food_cost',    'recv_variance',   null),
    ('5110', 'ค่าแรง',                         'expense',   'labor',        'labor',           'labor'),
    ('5210', 'ค่าเช่า',                        'expense',   'opex',         'rent',            'rent'),
    ('5220', 'ค่าน้ำไฟ',                       'expense',   'opex',         'utilities',       'utilities'),
    ('5230', 'ค่าการตลาด',                     'expense',   'opex',         'marketing',       null),
    ('5240', 'ค่า GP เดลิเวอรี่',               'expense',   'opex',         'delivery_gp',     null),
    ('5250', 'ค่าแพ็กเกจจิ้ง',                  'expense',   'opex',         'packaging',       null),
    ('5260', 'เงินสดขาด/เกิน',                 'expense',   'opex',         'cash_over_short', null),
    ('5290', 'ค่าใช้จ่ายอื่น',                   'expense',   'opex',         'other_exp',       'other')
  ) as a(code, name, type, grp, key, legacy)
  on conflict do nothing;
$$;
revoke execute on function acct_seed_accounts(uuid) from public, anon, authenticated;

select acct_seed_accounts(id) from restaurants;

create or replace function restaurants_seed_accounts()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform acct_seed_accounts(new.id);
  return new;
end;
$$;
drop trigger if exists restaurants_seed_accounts on restaurants;
create trigger restaurants_seed_accounts after insert on restaurants
  for each row execute function restaurants_seed_accounts();

-- บัญชีระบบ: เปลี่ยนรหัส/กลุ่ม/ปิดใช้งานไม่ได้ (แก้ชื่อได้) · บัญชีที่มีรายการแล้วลบไม่ได้ (foreign key)
create or replace function accounts_guard()
returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if old.system_key is not null and exists (select 1 from restaurants where id = old.restaurant_id) then
      raise exception 'system_account';
    end if;
    return old;
  end if;
  if old.system_key is not null and (new.code <> old.code or new.type <> old.type or new.grp <> old.grp
                                     or new.system_key is distinct from old.system_key or not new.is_active) then
    raise exception 'system_account';
  end if;
  if new.restaurant_id <> old.restaurant_id then
    raise exception 'invalid_request';
  end if;
  return new;
end;
$$;
drop trigger if exists accounts_guard on accounts;
create trigger accounts_guard before update or delete on accounts
  for each row execute function accounts_guard();

alter table accounts enable row level security;
drop policy if exists accounts_read on accounts;
create policy accounts_read on accounts for select
  using (has_role(restaurant_id, array['owner', 'manager', 'accountant']));
-- ร้านเพิ่มหมวดเองได้ (เจ้าของ + พนักงานบัญชี) · บัญชีระบบสร้างโดยระบบเท่านั้น
drop policy if exists accounts_write on accounts;
create policy accounts_write on accounts for all
  using (has_role(restaurant_id, array['owner', 'accountant']))
  with check (has_role(restaurant_id, array['owner', 'accountant']));  -- system_key ไม่อยู่ในสิทธิ์คอลัมน์ ผู้ใช้ตั้งเองไม่ได้
revoke insert, update, delete on accounts from anon, authenticated;
grant insert (restaurant_id, code, name, type, grp, is_active) on accounts to authenticated;
grant update (name, is_active) on accounts to authenticated;
grant delete on accounts to authenticated;

create or replace function acct_account(p_restaurant_id uuid, p_key text)
returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v uuid;
begin
  select id into v from accounts where restaurant_id = p_restaurant_id and system_key = p_key;
  if v is null then
    raise exception 'account_missing: %', p_key;
  end if;
  return v;
end;
$$;
revoke execute on function acct_account(uuid, text) from public, anon, authenticated;

-- ===== 2) สมุดรายวัน =====
create table if not exists journal_entries (
  id uuid primary key default gen_random_uuid(),
  entry_no bigint generated always as identity,
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  entry_date date not null,
  source_type text not null check (source_type in (
    'bill', 'stock_receipt', 'recipe_deduct', 'count_adjust', 'expense', 'reversal', 'day_close',
    'waste', 'production', 'stock_revalue', 'supplier_claim', 'supplier_payment', 'opening')),
  source_id uuid,
  memo text check (char_length(memo) <= 300),
  reverses_entry_id uuid references journal_entries(id),
  reason text check (char_length(reason) <= 300),
  created_by uuid,                                 -- ไม่ผูก FK: ลบผู้ใช้แล้วรายการยังต้องอยู่ครบ (แก้รายการไม่ได้)
  created_at timestamptz not null default now(),
  created_txid bigint not null default txid_current()
);
create index if not exists journal_entries_restaurant_date_idx on journal_entries (restaurant_id, entry_date);
create index if not exists journal_entries_source_idx on journal_entries (restaurant_id, source_type, source_id);
create unique index if not exists journal_entries_reverses_key on journal_entries (reverses_entry_id) where reverses_entry_id is not null;

create table if not exists journal_lines (
  id bigint generated always as identity primary key,
  entry_id uuid not null references journal_entries(id) on delete cascade,
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  account_id uuid not null references accounts(id),
  debit numeric(14,2) not null default 0 check (debit >= 0),
  credit numeric(14,2) not null default 0 check (credit >= 0),
  ingredient_id uuid,                              -- รายละเอียดสต็อก (ไม่ผูก FK: ลบวัตถุดิบแล้วประวัติยังอยู่)
  memo text check (char_length(memo) <= 200),
  check ((debit > 0) <> (credit > 0))              -- 1 บรรทัด = เดบิตหรือเครดิตอย่างใดอย่างหนึ่ง
);
create index if not exists journal_lines_entry_idx on journal_lines (entry_id);
create index if not exists journal_lines_account_idx on journal_lines (restaurant_id, account_id);

-- ลงแล้วแก้/ลบไม่ได้ (ยกเว้นลบทั้งร้าน) · เพิ่มบรรทัดได้เฉพาะรายการที่สร้างในธุรกรรมเดียวกัน
create or replace function journal_immutable()
returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from journal_entries where id = new.entry_id and created_txid = txid_current()) then
      raise exception 'journal_immutable';
    end if;
    if new.restaurant_id <> (select restaurant_id from journal_entries where id = new.entry_id) then
      raise exception 'invalid_request';
    end if;
    if not exists (select 1 from accounts where id = new.account_id and restaurant_id = new.restaurant_id) then
      raise exception 'invalid_account';
    end if;
    return new;
  end if;
  if exists (select 1 from restaurants where id = old.restaurant_id) then
    raise exception 'journal_immutable';
  end if;
  return old;
end;
$$;
drop trigger if exists journal_lines_immutable on journal_lines;
create trigger journal_lines_immutable before insert or update or delete on journal_lines
  for each row execute function journal_immutable();
drop trigger if exists journal_entries_immutable on journal_entries;
create trigger journal_entries_immutable before update or delete on journal_entries
  for each row execute function journal_immutable();

-- เดบิต = เครดิต ต่อรายการ (ตรวจตอน commit ให้ฟังก์ชันเพิ่มบรรทัดทีละบรรทัดได้)
-- ตรวจทั้งตอนสร้างรายการ (ต้องมีอย่างน้อย 2 บรรทัด) และทุกบรรทัดที่เพิ่ม
create or replace function journal_check_balanced()
returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_entry uuid := case when tg_table_name = 'journal_entries' then new.id::text else to_jsonb(new)->>'entry_id' end;
  v_dr numeric;
  v_cr numeric;
  v_n int;
begin
  if not exists (select 1 from journal_entries where id = v_entry) then
    return null;
  end if;
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*) into v_dr, v_cr, v_n
  from journal_lines where entry_id = v_entry;
  if v_n < 2 or v_dr <> v_cr then
    raise exception 'journal_unbalanced: entry % debit % credit % lines %', v_entry, v_dr, v_cr, v_n;
  end if;
  return null;
end;
$$;
drop trigger if exists journal_entries_balanced on journal_entries;
create constraint trigger journal_entries_balanced after insert on journal_entries
  deferrable initially deferred
  for each row execute function journal_check_balanced();
drop trigger if exists journal_lines_balanced on journal_lines;
create constraint trigger journal_lines_balanced after insert on journal_lines
  deferrable initially deferred
  for each row execute function journal_check_balanced();

alter table journal_entries enable row level security;
alter table journal_lines enable row level security;
drop policy if exists journal_entries_read on journal_entries;
create policy journal_entries_read on journal_entries for select
  using (has_role(restaurant_id, array['owner', 'manager', 'accountant']));
drop policy if exists journal_lines_read on journal_lines;
create policy journal_lines_read on journal_lines for select
  using (has_role(restaurant_id, array['owner', 'manager', 'accountant']));
revoke insert, update, delete on journal_entries, journal_lines from anon, authenticated;

-- ===== 3) ตั้งค่าบัญชีของร้าน =====
alter table shop_settings add column if not exists accounting_mode text not null default 'standard'
  check (accounting_mode in ('simple', 'standard', 'pro'));
alter table shop_settings add column if not exists business_type text not null default 'individual'
  check (business_type in ('individual', 'company'));
alter table shop_settings add column if not exists vat_registered boolean not null default false;
alter table shop_settings add column if not exists vat_rate numeric(5,2) not null default 7
  check (vat_rate >= 0 and vat_rate <= 30);
alter table shop_settings add column if not exists receipt_payment_default text not null default 'cash'
  check (receipt_payment_default in ('cash', 'bank', 'credit'));       -- ใบรับของจ่ายด้วยอะไร (credit = ค้างเจ้าหนี้)
alter table shop_settings add column if not exists food_cost_target_min numeric(5,2) not null default 28;
alter table shop_settings add column if not exists food_cost_target_max numeric(5,2) not null default 35;
alter table shop_settings add column if not exists prime_cost_target_min numeric(5,2) not null default 60;
alter table shop_settings add column if not exists prime_cost_target_max numeric(5,2) not null default 65;
alter table shop_settings add column if not exists accounting_onboarded_at timestamptz;
alter table shop_settings drop constraint if exists shop_settings_cost_targets_check;
alter table shop_settings add constraint shop_settings_cost_targets_check check (
  food_cost_target_min between 0 and 100 and food_cost_target_max between food_cost_target_min and 100
  and prime_cost_target_min between 0 and 100 and prime_cost_target_max between prime_cost_target_min and 100);

-- รายได้แยกตามหมวดเมนู (ว่าง = รายได้ขายอาหาร)
alter table menu_categories add column if not exists revenue_account_id uuid references accounts(id) on delete set null;
update menu_categories c set revenue_account_id = a.id
from accounts a
where a.restaurant_id = c.restaurant_id and a.system_key = 'rev_drink' and c.revenue_account_id is null
  and c.name ~* '(เครื่องดื่ม|drink|beverage|กาแฟ|coffee)';

create or replace function menu_categories_check_revenue_account()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- หมวดใหม่ชื่อแนวเครื่องดื่ม: ผูกรายได้เครื่องดื่มให้ (เปลี่ยนได้ที่หน้าตั้งค่าบัญชี)
  if tg_op = 'INSERT' and new.revenue_account_id is null and new.name ~* '(เครื่องดื่ม|drink|beverage|กาแฟ|coffee)' then
    select id into new.revenue_account_id from accounts where restaurant_id = new.restaurant_id and system_key = 'rev_drink';
  end if;
  if new.revenue_account_id is not null and not exists (
    select 1 from accounts where id = new.revenue_account_id and restaurant_id = new.restaurant_id and grp = 'sales'
  ) then
    raise exception 'invalid_account';
  end if;
  return new;
end;
$$;
drop trigger if exists menu_categories_revenue_account on menu_categories;
create trigger menu_categories_revenue_account before insert or update of revenue_account_id on menu_categories
  for each row execute function menu_categories_check_revenue_account();

-- ===== 4) วันที่ลงบัญชี + ปิดวัน =====
create table if not exists day_closes (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  close_date date not null,
  system_cash numeric(14,2) not null,              -- ยอดเงินสดตามบัญชี ณ สิ้นวัน
  counted_cash numeric(14,2) not null check (counted_cash >= 0),
  difference numeric(14,2) not null,               -- นับจริง - ระบบ (+ เกิน / - ขาด)
  summary jsonb not null default '{}',
  note text check (char_length(note) <= 300),
  confirmed_by uuid references app_users(id) on delete set null,
  confirmed_by_name text,
  created_at timestamptz not null default now(),
  unique (restaurant_id, close_date)
);
alter table day_closes enable row level security;
drop policy if exists day_closes_read on day_closes;
create policy day_closes_read on day_closes for select
  using (has_role(restaurant_id, array['owner', 'manager', 'accountant']));
revoke insert, update, delete on day_closes from anon, authenticated;

create or replace function acct_today(p_restaurant_id uuid)
returns date
language sql stable security definer set search_path = public, pg_temp as $$
  select (now() at time zone coalesce((select timezone from restaurants where id = p_restaurant_id), 'Asia/Bangkok'))::date;
$$;

-- วันที่ยังไม่ปิดวันแรกที่ >= p_date (รายการอัตโนมัติหลังปิดวันเข้าวันถัดไป)
create or replace function acct_open_date(p_restaurant_id uuid, p_date date)
returns date
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v date := p_date;
begin
  while exists (select 1 from day_closes where restaurant_id = p_restaurant_id and close_date = v) loop
    v := v + 1;
  end loop;
  return v;
end;
$$;

create or replace function journal_entries_check_date()
returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if exists (select 1 from day_closes where restaurant_id = new.restaurant_id and close_date = new.entry_date) then
    raise exception 'day_closed: %', new.entry_date;
  end if;
  return new;
end;
$$;
drop trigger if exists journal_entries_check_date on journal_entries;
create trigger journal_entries_check_date before insert on journal_entries
  for each row execute function journal_entries_check_date();

-- ===== 5) ตัวช่วยลงรายการ (ใช้ภายใน) =====
create or replace function acct_new_entry(
  p_restaurant_id uuid, p_source_type text, p_source_id uuid, p_date date, p_memo text,
  p_reverses uuid default null, p_reason text default null
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v uuid;
begin
  insert into journal_entries (restaurant_id, entry_date, source_type, source_id, memo, reverses_entry_id, reason, created_by)
  values (p_restaurant_id, p_date, p_source_type, p_source_id, left(p_memo, 300), p_reverses, left(p_reason, 300),
          (select id from app_users where id = auth.uid()))
  returning id into v;
  return v;
end;
$$;

-- รายการของเอกสารเดียวกันในธุรกรรมเดียวกัน ใช้รายการเดิม (เช่น ตัดสต็อก 5 วัตถุดิบของออเดอร์เดียว = 1 รายการ)
create or replace function acct_tx_entry(p_restaurant_id uuid, p_source_type text, p_source_id uuid, p_memo text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v uuid;
begin
  select id into v from journal_entries
  where restaurant_id = p_restaurant_id and source_type = p_source_type
    and source_id is not distinct from p_source_id and created_txid = txid_current() and reverses_entry_id is null
  limit 1;
  if v is null then
    v := acct_new_entry(p_restaurant_id, p_source_type, p_source_id,
                        acct_open_date(p_restaurant_id, acct_today(p_restaurant_id)), p_memo);
  end if;
  return v;
end;
$$;

-- จำนวนบวก = เดบิต · ลบ = เครดิต · 0 = ไม่ลง
create or replace function acct_line_id(p_entry uuid, p_account uuid, p_amount numeric, p_ingredient uuid default null, p_memo text default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_amt numeric := round(coalesce(p_amount, 0), 2);
begin
  if v_amt = 0 then
    return;
  end if;
  insert into journal_lines (entry_id, restaurant_id, account_id, debit, credit, ingredient_id, memo)
  select p_entry, e.restaurant_id, p_account, greatest(v_amt, 0), greatest(-v_amt, 0), p_ingredient, left(p_memo, 200)
  from journal_entries e where e.id = p_entry;
end;
$$;

create or replace function acct_line(p_entry uuid, p_key text, p_amount numeric, p_ingredient uuid default null, p_memo text default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform acct_line_id(p_entry, acct_account((select restaurant_id from journal_entries where id = p_entry), p_key),
                       p_amount, p_ingredient, p_memo);
end;
$$;

-- กลับรายการ: สลับเดบิต/เครดิตทุกบรรทัด ลงวันที่เปิดอยู่วันแรก (วันเดิมอาจปิดไปแล้ว)
create or replace function acct_reverse_internal(p_entry uuid, p_reason text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e journal_entries;
  v uuid;
begin
  select * into e from journal_entries where id = p_entry;
  if e.id is null then
    raise exception 'not_found';
  end if;
  if exists (select 1 from journal_entries where reverses_entry_id = p_entry) then
    raise exception 'already_reversed';
  end if;
  v := acct_new_entry(e.restaurant_id, 'reversal', e.source_id, acct_open_date(e.restaurant_id, acct_today(e.restaurant_id)),
                      'กลับรายการ #' || e.entry_no || coalesce(' · ' || e.memo, ''), p_entry, p_reason);
  insert into journal_lines (entry_id, restaurant_id, account_id, debit, credit, ingredient_id, memo)
  select v, restaurant_id, account_id, credit, debit, ingredient_id, memo
  from journal_lines where entry_id = p_entry order by id;
  return v;
end;
$$;

revoke execute on function acct_today(uuid) from public, anon;
grant execute on function acct_today(uuid) to authenticated;
revoke execute on function acct_open_date(uuid, date) from public, anon;
grant execute on function acct_open_date(uuid, date) to authenticated;
revoke execute on function acct_new_entry(uuid, text, uuid, date, text, uuid, text) from public, anon, authenticated;
revoke execute on function acct_tx_entry(uuid, text, uuid, text) from public, anon, authenticated;
revoke execute on function acct_line_id(uuid, uuid, numeric, uuid, text) from public, anon, authenticated;
revoke execute on function acct_line(uuid, text, numeric, uuid, text) from public, anon, authenticated;
revoke execute on function acct_reverse_internal(uuid, text) from public, anon, authenticated;

-- ===== 6) สต็อก: ลงผลต่างมูลค่าทุกครั้งที่ยอด/ต้นทุนต่อหน่วยเปลี่ยน =====
-- บริบท (ตั้งชั่วคราวในธุรกรรม): plato.stock_ctx = 'ประเภทเอกสาร|รหัสเอกสาร|บัญชีคู่' จาก stock_movements
--                                plato.receipt_ctx = รหัสใบรับของที่กำลังบันทึก (ต้นทุนเฉลี่ยเปลี่ยนก่อนสต็อกเข้า)
create or replace function apply_stock_movement()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.created_by := auth.uid();
  perform set_config('plato.stock_ctx',
    case
      when new.reason = 'sale' then 'recipe_deduct|' || coalesce(new.order_id::text, '') || '|cogs'
      when new.reason = 'purchase' and new.receipt_id is not null then 'stock_receipt|' || new.receipt_id || '|'
      when new.reason = 'purchase' then 'stock_receipt||@payment'
      when new.reason = 'waste' then 'waste|' || new.id || '|variance'
      when new.reason = 'adjustment' then 'count_adjust|' || coalesce(new.count_id, new.id) || '|variance'
      when new.reason = 'production' then 'production|' || coalesce(new.batch_id, new.id) || '|variance'
      else 'stock_revalue|' || new.id || '|variance'
    end, true);
  update ingredients
     set quantity_on_hand = quantity_on_hand + new.change
   where id = new.ingredient_id
     and restaurant_id = new.restaurant_id
  returning quantity_on_hand into new.balance_after;
  if not found then
    raise exception 'invalid_ingredient';
  end if;
  perform set_config('plato.stock_ctx', '', true);
  return new;
end;
$$;

create or replace function acct_payment_key(p_restaurant_id uuid, p_method text)
returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case coalesce(p_method, (select receipt_payment_default from shop_settings where restaurant_id = p_restaurant_id), 'cash')
    when 'bank' then 'bank' when 'credit' then 'ap' else 'cash' end;
$$;
revoke execute on function acct_payment_key(uuid, text) from public, anon, authenticated;

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
    v_src := 'stock_receipt'; v_doc := v_receipt::uuid; v_contra := null;   -- ต้นทุนเฉลี่ยใหม่ตอนรับของ
  elsif tg_op = 'INSERT' then
    v_src := 'opening'; v_doc := v_ing; v_contra := 'equity';               -- วัตถุดิบใหม่พร้อมยอดยกมา
  else
    v_src := 'stock_revalue'; v_doc := v_ing; v_contra := 'variance';       -- แก้ต้นทุนต่อหน่วย / ลบวัตถุดิบ
  end if;

  v_entry := acct_tx_entry(v_rid, v_src, v_doc, case v_src
    when 'recipe_deduct' then 'ตัดสต็อกตามสูตร'
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
drop trigger if exists ingredients_accounting on ingredients;
create trigger ingredients_accounting
  after insert or update of quantity_on_hand, cost_per_unit or delete on ingredients
  for each row execute function acct_ingredient_value();

-- ใบรับของ: จำว่ากำลังบันทึกใบไหน แล้วปิดรายการเมื่อฟังก์ชันใส่ยอดรวม (ขั้นสุดท้ายของ submit_stock_receipt)
alter table stock_receipts add column if not exists payment_method text check (payment_method in ('cash', 'bank', 'credit'));

create or replace function stock_receipts_accounting()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_entry uuid;
  v_stock numeric;
  v_pay numeric;
  v_claim numeric;
begin
  if tg_op = 'INSERT' then
    perform set_config('plato.receipt_ctx', new.id::text, true);
    if new.payment_method is null then
      update stock_receipts
         set payment_method = coalesce((select receipt_payment_default from shop_settings where restaurant_id = new.restaurant_id), 'cash')
       where id = new.id;
    end if;
    return null;
  end if;

  -- ยอดรวมถูกใส่ครั้งแรก: Dr สต็อก (ผลต่างมูลค่าที่ลงไปแล้ว) + Dr ลูกหนี้ผู้ขาย (ของขาด) / Cr เงินสด/ธนาคาร/เจ้าหนี้ (ตามบิล)
  if old.item_count = 0 and new.item_count > 0 then
    v_entry := acct_tx_entry(new.restaurant_id, 'stock_receipt', new.id, 'รับวัตถุดิบเข้า');
    select coalesce(sum(jl.debit - jl.credit), 0) into v_stock
    from journal_lines jl join accounts a on a.id = jl.account_id
    where jl.entry_id = v_entry and a.system_key = 'stock';
    v_pay := coalesce(new.invoice_total, new.total_cost, 0);
    v_claim := coalesce(new.claim_total, 0);
    perform acct_line(v_entry, acct_payment_key(new.restaurant_id, new.payment_method), -v_pay, null,
                      'ตามบิล' || coalesce(' ' || new.supplier, '') || coalesce(' #' || new.invoice_no, ''));
    perform acct_line(v_entry, 'claim', v_claim, null, 'ของขาด/ตีกลับ รอทวง');
    -- ส่วนที่เหลือ: ขาด/เกินในเกณฑ์ที่ยอมรับ + เศษสตางค์ของต้นทุนเฉลี่ย
    perform acct_line(v_entry, 'recv_variance', v_pay - v_claim - v_stock, null, 'ส่วนต่างรับสินค้า');
    perform set_config('plato.receipt_ctx', '', true);
  end if;
  return null;
end;
$$;
drop trigger if exists stock_receipts_accounting on stock_receipts;
create trigger stock_receipts_accounting after insert or update on stock_receipts
  for each row execute function stock_receipts_accounting();

-- ติดตามของขาด: pending -> credited (ได้ลดหนี้: ล้างกับเจ้าหนี้) / accepted (ยอมรับ: เป็นส่วนต่างรับสินค้า)
create or replace function stock_receipt_lines_claim_accounting()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rid uuid;
  v_entry uuid;
  v_amt numeric := new.claim_value;
begin
  if new.claim_status is not distinct from old.claim_status or coalesce(v_amt, 0) = 0 then
    return null;
  end if;
  select restaurant_id into v_rid from stock_receipts where id = new.receipt_id;
  v_entry := acct_new_entry(v_rid, 'supplier_claim', new.receipt_id, acct_open_date(v_rid, acct_today(v_rid)),
                            'ของขาดจากผู้ขาย: ' || old.claim_status || ' -> ' || new.claim_status);
  -- ย้อนผลของสถานะเดิม
  if old.claim_status = 'credited' then
    perform acct_line(v_entry, 'claim', v_amt, new.ingredient_id, new.ingredient_name);
    perform acct_line(v_entry, 'ap', -v_amt, new.ingredient_id, new.ingredient_name);
  elsif old.claim_status = 'accepted' then
    perform acct_line(v_entry, 'claim', v_amt, new.ingredient_id, new.ingredient_name);
    perform acct_line(v_entry, 'recv_variance', -v_amt, new.ingredient_id, new.ingredient_name);
  end if;
  -- ลงผลของสถานะใหม่
  if new.claim_status = 'credited' then
    perform acct_line(v_entry, 'ap', v_amt, new.ingredient_id, 'ได้ลดหนี้ ' || new.ingredient_name);
    perform acct_line(v_entry, 'claim', -v_amt, new.ingredient_id, 'ได้ลดหนี้ ' || new.ingredient_name);
  elsif new.claim_status = 'accepted' then
    perform acct_line(v_entry, 'recv_variance', v_amt, new.ingredient_id, 'ยอมรับของขาด ' || new.ingredient_name);
    perform acct_line(v_entry, 'claim', -v_amt, new.ingredient_id, 'ยอมรับของขาด ' || new.ingredient_name);
  end if;
  return null;
end;
$$;
drop trigger if exists stock_receipt_lines_claim_accounting on stock_receipt_lines;
create trigger stock_receipt_lines_claim_accounting after update of claim_status on stock_receipt_lines
  for each row execute function stock_receipt_lines_claim_accounting();

-- ===== 7) บิล: จ่ายแล้วลงรายได้ · ยกเลิกหลังจ่าย = กลับรายการ · ยกเลิกหลังตัดสต็อก = ย้ายต้นทุนไปส่วนต่างสต็อก =====
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
revoke execute on function acct_post_bill(orders) from public, anon, authenticated;

create or replace function orders_accounting()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bill uuid;
  v_deduct uuid;
  v_cost numeric;
  v_entry uuid;
begin
  if new.import_batch is not null or new.is_demo then
    return null;
  end if;

  if new.status = 'paid' and old.status <> 'paid' then
    perform acct_post_bill(new);
  end if;

  if new.status = 'cancelled' and old.status <> 'cancelled' then
    -- ยกเลิกบิลที่จ่ายแล้ว: กลับรายการรายได้ทั้งบิล
    if old.status = 'paid' then
      select id into v_bill from journal_entries
      where restaurant_id = new.restaurant_id and source_type = 'bill' and source_id = new.id
        and not exists (select 1 from journal_entries x where x.reverses_entry_id = journal_entries.id)
      limit 1;
      if v_bill is not null then
        perform acct_reverse_internal(v_bill, coalesce(new.cancel_reason, 'ยกเลิกบิล'));
      end if;
    end if;
    -- ต้นทุน: ของถูกทำไปแล้ว สต็อกไม่คืน -> ย้ายจากต้นทุนขายไปส่วนต่างสต็อก (ไม่ใช่ต้นทุนของการขาย)
    select e.id, coalesce(sum(jl.debit - jl.credit), 0) into v_deduct, v_cost
    from journal_entries e
    join journal_lines jl on jl.entry_id = e.id
    join accounts a on a.id = jl.account_id and a.system_key = 'cogs'
    where e.restaurant_id = new.restaurant_id and e.source_type = 'recipe_deduct' and e.source_id = new.id
      and not exists (select 1 from journal_entries x where x.reverses_entry_id = e.id)
    group by e.id
    limit 1;
    if v_deduct is not null and v_cost <> 0 then
      v_entry := acct_new_entry(new.restaurant_id, 'reversal', new.id, acct_open_date(new.restaurant_id, acct_today(new.restaurant_id)),
                                'ยกเลิกออเดอร์: ย้ายต้นทุนขายเป็นส่วนต่างสต็อก', v_deduct, coalesce(new.cancel_reason, 'ยกเลิกออเดอร์'));
      perform acct_line(v_entry, 'variance', v_cost);
      perform acct_line(v_entry, 'cogs', -v_cost);
    end if;
  end if;
  return null;
end;
$$;
drop trigger if exists orders_accounting on orders;
create trigger orders_accounting after update of status on orders
  for each row when (old.status is distinct from new.status)
  execute function orders_accounting();

-- ออเดอร์ที่ลงบัญชีแล้วลบไม่ได้ (รายได้/ต้นทุนจะหายจากสมุดรายวัน) ใช้ยกเลิกแทน
create or replace function orders_keep_posted()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from journal_entries
             where restaurant_id = old.restaurant_id and source_id = old.id and source_type in ('bill', 'recipe_deduct'))
     and exists (select 1 from restaurants where id = old.restaurant_id) then
    raise exception 'order_posted_use_cancel';
  end if;
  return old;
end;
$$;
drop trigger if exists orders_keep_posted on orders;
create trigger orders_keep_posted before delete on orders
  for each row execute function orders_keep_posted();

-- ===== 8) รายจ่าย =====
alter table expenses add column if not exists account_id uuid references accounts(id);
alter table expenses add column if not exists payment_method text not null default 'cash'
  check (payment_method in ('cash', 'bank', 'credit'));
alter table expenses add column if not exists vat_amount numeric(12,2) not null default 0 check (vat_amount >= 0);
alter table expenses add column if not exists source text not null default 'manual'
  check (source in ('manual', 'stock_receipt', 'legacy'));
alter table expenses add column if not exists created_by uuid references app_users(id) on delete set null;
alter table expenses add column if not exists created_at timestamptz not null default now();
alter table expenses add column if not exists voided_at timestamptz;
alter table expenses add column if not exists voided_by uuid references app_users(id) on delete set null;
alter table expenses add column if not exists void_reason text check (char_length(void_reason) <= 300);
alter table expenses drop constraint if exists expenses_vat_check;
alter table expenses add constraint expenses_vat_check check (vat_amount <= amount);

-- รายจ่ายก่อนมีโมดูลบัญชี: ไม่ลงย้อนหลัง (ยอดเดิมดูได้จากรายงานแบบเดิม) · รายจ่ายจากใบรับของ: สต็อกลงบัญชีแทน
update expenses e set source = case when exists (select 1 from stock_receipts r where r.expense_id = e.id) then 'stock_receipt' else 'legacy' end
where source = 'manual';
update expenses e set account_id = a.id
from accounts a
where e.account_id is null and a.restaurant_id = e.restaurant_id and a.legacy_category = e.category;

-- ช่องที่ผู้ใช้กรอกเองได้ (source / void / created_by ระบบเป็นคนตั้ง)
revoke insert, update on expenses from authenticated;
grant insert (restaurant_id, category, amount, spent_on, note, receipt_url, account_id, payment_method, vat_amount) on expenses to authenticated;
grant update (note, receipt_url) on expenses to authenticated;

create or replace function expenses_before_insert()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a accounts;
begin
  new.created_by := (select id from app_users where id = auth.uid());
  new.voided_at := null; new.voided_by := null; new.void_reason := null;
  -- อยู่ระหว่างบันทึกใบรับของ: รายจ่ายนี้คือบิลวัตถุดิบ (สต็อกลงบัญชีให้แล้ว)
  if nullif(current_setting('plato.receipt_ctx', true), '') is not null and new.category = 'ingredients' then
    new.source := 'stock_receipt';
  else
    new.source := 'manual';
  end if;
  if new.account_id is null then
    select * into a from accounts where restaurant_id = new.restaurant_id and legacy_category = new.category and is_active
    order by system_key nulls last limit 1;
  else
    select * into a from accounts where id = new.account_id and restaurant_id = new.restaurant_id;
  end if;
  if a.id is null or a.type <> 'expense' or not a.is_active
     or (new.source = 'manual' and a.system_key in ('cogs', 'variance', 'recv_variance', 'cash_over_short')) then
    raise exception 'invalid_expense_account';
  end if;
  new.account_id := a.id;
  new.category := coalesce(a.legacy_category, 'other');
  return new;
end;
$$;
drop trigger if exists expenses_before_insert on expenses;
create trigger expenses_before_insert before insert on expenses
  for each row execute function expenses_before_insert();

create or replace function expenses_after_insert()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_entry uuid;
begin
  if new.source <> 'manual' then
    return null;
  end if;
  v_entry := acct_new_entry(new.restaurant_id, 'expense', new.id, new.spent_on,
                            coalesce(new.note, (select name from accounts where id = new.account_id)));
  perform acct_line_id(v_entry, new.account_id, new.amount - new.vat_amount);
  perform acct_line(v_entry, 'vat_in', new.vat_amount);
  perform acct_line(v_entry, acct_payment_key(new.restaurant_id, new.payment_method), -new.amount);
  return null;
end;
$$;
drop trigger if exists expenses_after_insert on expenses;
create trigger expenses_after_insert after insert on expenses
  for each row execute function expenses_after_insert();

-- ลงบัญชีแล้วแก้ยอด/หมวด/วันที่ไม่ได้ ลบไม่ได้ → ใช้ "ยกเลิกรายจ่าย" (กลับรายการ)
create or replace function expenses_guard()
returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if old.source <> 'manual' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if exists (select 1 from restaurants where id = old.restaurant_id) then
      raise exception 'expense_posted_use_void';
    end if;
    return old;
  end if;
  if new.amount <> old.amount or new.category <> old.category or new.spent_on <> old.spent_on
     or new.account_id is distinct from old.account_id or new.payment_method <> old.payment_method
     or new.vat_amount <> old.vat_amount or new.source <> old.source or new.restaurant_id <> old.restaurant_id then
    raise exception 'expense_posted_use_void';
  end if;
  return new;
end;
$$;
drop trigger if exists expenses_guard on expenses;
create trigger expenses_guard before update or delete on expenses
  for each row execute function expenses_guard();

create or replace function acct_void_expense(p_expense_id uuid, p_reason text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  x expenses;
  v_entry uuid;
  v uuid;
begin
  select * into x from expenses where id = p_expense_id for update;
  if x.id is null or not has_role(x.restaurant_id, array['owner', 'accountant']) then
    raise exception 'forbidden';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'reason_required';
  end if;
  if x.source <> 'manual' then
    raise exception 'not_posted';
  end if;
  if x.voided_at is not null then
    raise exception 'already_reversed';
  end if;
  select id into v_entry from journal_entries
  where restaurant_id = x.restaurant_id and source_type = 'expense' and source_id = x.id and reverses_entry_id is null;
  v := acct_reverse_internal(v_entry, trim(p_reason));
  update expenses set voided_at = now(), voided_by = (select id from app_users where id = auth.uid()),
                      void_reason = left(trim(p_reason), 300)
   where id = x.id;
  return v;
end;
$$;
revoke execute on function acct_void_expense(uuid, text) from public, anon;
grant execute on function acct_void_expense(uuid, text) to authenticated;

-- รูปใบเสร็จ: bucket 'expense-receipts' (ไม่สาธารณะ) ไฟล์อยู่ใต้โฟลเดอร์ <restaurant_id>/
create or replace function can_access_expense_receipt(p_name text, p_write boolean)
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return has_role(split_part(p_name, '/', 1)::uuid,
                  case when p_write then array['owner', 'accountant'] else array['owner', 'manager', 'accountant'] end);
exception when invalid_text_representation then
  return false;
end;
$$;
revoke execute on function can_access_expense_receipt(text, boolean) from public, anon;
grant execute on function can_access_expense_receipt(text, boolean) to authenticated;

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    execute $q$
      insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('expense-receipts', 'expense-receipts', false, 10485760, array['image/*', 'application/pdf'])
      on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types
    $q$;
    execute 'drop policy if exists expense_receipts_select on storage.objects';
    execute 'drop policy if exists expense_receipts_insert on storage.objects';
    execute $q$
      create policy expense_receipts_select on storage.objects for select to authenticated
      using (bucket_id = 'expense-receipts' and public.can_access_expense_receipt(name, false))
    $q$;
    execute $q$
      create policy expense_receipts_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'expense-receipts' and public.can_access_expense_receipt(name, true))
    $q$;
  end if;
end;
$$;

-- ===== 9) จ่ายเจ้าหนี้ (ใบรับของแบบเครดิต) =====
create or replace function acct_pay_supplier(
  p_restaurant_id uuid, p_amount numeric, p_payment_method text, p_supplier text default null,
  p_date date default null, p_note text default null
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v uuid;
begin
  if not has_role(p_restaurant_id, array['owner', 'accountant']) then
    raise exception 'forbidden';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100000000 then
    raise exception 'invalid_amount';
  end if;
  if coalesce(p_payment_method, '') not in ('cash', 'bank') then
    raise exception 'invalid_payment_method';
  end if;
  v := acct_new_entry(p_restaurant_id, 'supplier_payment', null, coalesce(p_date, acct_today(p_restaurant_id)),
                      'จ่ายเจ้าหนี้' || coalesce(' ' || nullif(trim(p_supplier), ''), '') || coalesce(' · ' || nullif(trim(p_note), ''), ''));
  perform acct_line(v, 'ap', p_amount);
  perform acct_line(v, p_payment_method, -p_amount);
  return v;
end;
$$;
revoke execute on function acct_pay_supplier(uuid, numeric, text, text, date, text) from public, anon;
grant execute on function acct_pay_supplier(uuid, numeric, text, text, date, text) to authenticated;

-- ===== 10) ยอดยกมา (เงินสด/ธนาคาร) =====
create or replace function acct_set_opening(p_restaurant_id uuid, p_cash numeric, p_bank numeric, p_date date default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v uuid;
begin
  if not has_role(p_restaurant_id, array['owner']) then
    raise exception 'forbidden';
  end if;
  if coalesce(p_cash, 0) < 0 or coalesce(p_bank, 0) < 0 or coalesce(p_cash, 0) + coalesce(p_bank, 0) = 0 then
    raise exception 'invalid_amount';
  end if;
  v := acct_new_entry(p_restaurant_id, 'opening', null, coalesce(p_date, acct_today(p_restaurant_id)), 'ยอดยกมา เงินสด/ธนาคาร');
  perform acct_line(v, 'cash', p_cash);
  perform acct_line(v, 'bank', p_bank);
  perform acct_line(v, 'equity', -(coalesce(p_cash, 0) + coalesce(p_bank, 0)));
  return v;
end;
$$;
revoke execute on function acct_set_opening(uuid, numeric, numeric, date) from public, anon;
grant execute on function acct_set_opening(uuid, numeric, numeric, date) to authenticated;

-- ===== 11) กลับรายการเอง (เจ้าของ) · บิล = ยกเลิกบิล · รายจ่าย = ยกเลิกรายจ่าย · สต็อก = ตรวจนับใหม่ =====
create or replace function acct_reverse_entry(p_entry_id uuid, p_reason text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e journal_entries;
begin
  select * into e from journal_entries where id = p_entry_id;
  if e.id is null or not has_role(e.restaurant_id, array['owner']) then
    raise exception 'forbidden';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'reason_required';
  end if;
  if e.source_type not in ('supplier_payment', 'opening', 'day_close') or (e.source_type = 'opening' and e.source_id is not null) then
    raise exception 'reverse_not_allowed: %', e.source_type;
  end if;
  return acct_reverse_internal(p_entry_id, trim(p_reason));
end;
$$;
revoke execute on function acct_reverse_entry(uuid, text) from public, anon;
grant execute on function acct_reverse_entry(uuid, text) to authenticated;

-- ===== 12) กระทบยอดสต็อก: โมดูลสต็อก vs บัญชีสต็อก =====
create or replace function acct_stock_reconcile_data(p_restaurant_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with m as (
    select coalesce(sum(round(quantity_on_hand * cost_per_unit, 2)), 0) as v from ingredients where restaurant_id = p_restaurant_id
  ), g as (
    select coalesce(sum(jl.debit - jl.credit), 0) as v
    from journal_lines jl join accounts a on a.id = jl.account_id and a.system_key = 'stock'
    where jl.restaurant_id = p_restaurant_id
  )
  select jsonb_build_object('stock_value', m.v, 'ledger_value', g.v, 'difference', g.v - m.v, 'ok', g.v = m.v)
  from m, g;
$$;
revoke execute on function acct_stock_reconcile_data(uuid) from public, anon, authenticated;

create or replace function acct_stock_reconcile(p_restaurant_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'accountant', 'stock']) then
    raise exception 'forbidden';
  end if;
  return acct_stock_reconcile_data(p_restaurant_id);
end;
$$;
revoke execute on function acct_stock_reconcile(uuid) from public, anon;
grant execute on function acct_stock_reconcile(uuid) to authenticated;

-- ===== 13) สรุปตามช่วงวันที่ (ข้อมูลดิบ · สูตร % คิดที่ frontend/src/lib/accounting.ts) =====
create or replace function acct_summary_data(p_restaurant_id uuid, p_from date, p_to date)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with l as (
    select a.grp, a.system_key, a.code, a.name, a.id as account_id, e.source_type, e.entry_date, jl.debit, jl.credit
    from journal_lines jl
    join journal_entries e on e.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where jl.restaurant_id = p_restaurant_id and e.entry_date <= p_to
  ), r as (select * from l where entry_date >= p_from)
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'sales', (select coalesce(sum(credit - debit), 0) from r where grp = 'sales'),
    'sales_by_account', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'amount', amt) order by code)
                                  from (select code, name, sum(credit - debit) as amt from r where grp = 'sales' group by code, name) x), '[]'),
    'discounts', (select coalesce(sum(debit - credit), 0) from r where grp = 'discount'),
    'other_income', (select coalesce(sum(credit - debit), 0) from r where grp = 'other_income'),
    'cogs_recipe', (select coalesce(sum(debit - credit), 0) from r where system_key = 'cogs'),
    'stock_variance', (select coalesce(sum(debit - credit), 0) from r where system_key = 'variance'),
    'food_cost', (select coalesce(sum(debit - credit), 0) from r where grp = 'food_cost'),
    'labor', (select coalesce(sum(debit - credit), 0) from r where grp = 'labor'),
    'opex', (select coalesce(sum(debit - credit), 0) from r where grp = 'opex'),
    'expenses_by_account', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'grp', grp, 'amount', amt) order by code)
                                     from (select code, name, grp, sum(debit - credit) as amt from r
                                           where grp in ('food_cost', 'labor', 'opex') group by code, name, grp) x where amt <> 0), '[]'),
    'cash_open', (select coalesce(sum(debit - credit), 0) from l where grp in ('cash', 'bank') and entry_date < p_from),
    'cash_close', (select coalesce(sum(debit - credit), 0) from l where grp in ('cash', 'bank')),
    'cash_in', (select coalesce(sum(debit), 0) from r where grp in ('cash', 'bank') and source_type <> 'opening'),
    'cash_out', (select coalesce(sum(credit), 0) from r where grp in ('cash', 'bank') and source_type <> 'opening'),
    'cash_drawer', (select coalesce(sum(debit - credit), 0) from l where grp = 'cash'),
    'cash_by_source', coalesce((select jsonb_agg(jsonb_build_object('source_type', source_type, 'in', i, 'out', o) order by source_type)
                                from (select source_type, sum(debit) as i, sum(credit) as o from r
                                      where grp in ('cash', 'bank') and source_type <> 'opening' group by source_type) x), '[]'),
    'stock_open', (select coalesce(sum(debit - credit), 0) from l where grp = 'stock' and entry_date < p_from),
    'stock_close', (select coalesce(sum(debit - credit), 0) from l where grp = 'stock'),
    'stock_in', (select coalesce(sum(debit - credit), 0) from r where grp = 'stock' and source_type in ('stock_receipt', 'opening')),
    'vat_output', (select coalesce(sum(credit - debit), 0) from r where grp = 'vat_out'),
    'vat_input', (select coalesce(sum(debit - credit), 0) from r where grp = 'vat_in'),
    'bills', (select count(*) from journal_entries e where e.restaurant_id = p_restaurant_id and e.source_type = 'bill'
                and e.entry_date between p_from and p_to),
    'cancelled_bills', (select count(*) from journal_entries e join journal_entries o on o.id = e.reverses_entry_id and o.source_type = 'bill'
                          where e.restaurant_id = p_restaurant_id and e.entry_date between p_from and p_to)
  );
$$;
revoke execute on function acct_summary_data(uuid, date, date) from public, anon, authenticated;

create or replace function acct_summary(p_restaurant_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'accountant']) then
    raise exception 'forbidden';
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 3660 then
    raise exception 'invalid_range';
  end if;
  return acct_summary_data(p_restaurant_id, p_from, p_to);
end;
$$;
revoke execute on function acct_summary(uuid, date, date) from public, anon;
grant execute on function acct_summary(uuid, date, date) to authenticated;

-- แดชบอร์ด: วันนี้ / 7 วัน / 30 วัน / เดือนนี้ / เดือนก่อน / ตั้งแต่ต้นปี + กระทบยอดสต็อก + ตั้งค่า
create or replace function acct_dashboard(p_restaurant_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  t date;
  m date;
  s shop_settings;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'accountant']) then
    raise exception 'forbidden';
  end if;
  t := acct_today(p_restaurant_id);
  m := date_trunc('month', t)::date;
  select * into s from shop_settings where restaurant_id = p_restaurant_id;
  return jsonb_build_object(
    'today', t,
    'periods', jsonb_build_object(
      'today', acct_summary_data(p_restaurant_id, t, t),
      'd7', acct_summary_data(p_restaurant_id, t - 6, t),
      'd30', acct_summary_data(p_restaurant_id, t - 29, t),
      'month', acct_summary_data(p_restaurant_id, m, t),
      'prev_month', acct_summary_data(p_restaurant_id, (m - interval '1 month')::date, m - 1),
      'ytd', acct_summary_data(p_restaurant_id, date_trunc('year', t)::date, t)
    ),
    'reconcile', acct_stock_reconcile_data(p_restaurant_id),
    'last_close', (select max(close_date) from day_closes where restaurant_id = p_restaurant_id),
    'unclosed_days', (select count(distinct entry_date) from journal_entries e
                       where e.restaurant_id = p_restaurant_id and e.entry_date < t
                         and e.entry_date > coalesce((select max(close_date) from day_closes where restaurant_id = p_restaurant_id), t - 31)
                         and not exists (select 1 from day_closes d where d.restaurant_id = p_restaurant_id and d.close_date = e.entry_date)),
    'settings', jsonb_build_object(
      'accounting_mode', coalesce(s.accounting_mode, 'standard'),
      'business_type', coalesce(s.business_type, 'individual'),
      'vat_registered', coalesce(s.vat_registered, false),
      'vat_rate', coalesce(s.vat_rate, 7),
      'receipt_payment_default', coalesce(s.receipt_payment_default, 'cash'),
      'food_cost_target_min', coalesce(s.food_cost_target_min, 28),
      'food_cost_target_max', coalesce(s.food_cost_target_max, 35),
      'prime_cost_target_min', coalesce(s.prime_cost_target_min, 60),
      'prime_cost_target_max', coalesce(s.prime_cost_target_max, 65),
      'onboarded', s.accounting_onboarded_at is not null
    )
  );
end;
$$;
revoke execute on function acct_dashboard(uuid) from public, anon;
grant execute on function acct_dashboard(uuid) to authenticated;

-- กำไรขั้นต้นต่อเมนู (ราคาขายก่อนส่วนลดท้ายบิล · ต้นทุนตามสูตรปัจจุบัน)
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
    select m.id, coalesce(sum(r.quantity_used * 100 / i.yield_pct * i.cost_per_unit), 0) as unit_cost, count(r.ingredient_id) > 0 as has_recipe
    from menu_items m
    left join recipes r on r.menu_item_id = m.id
    left join ingredients i on i.id = r.ingredient_id
    where m.restaurant_id = p_restaurant_id
    group by m.id
  ), s as (
    select m.id, m.name,
           sum(case when m.sold_by_weight then coalesce(oi.weight_g, 0) / 1000 else oi.quantity end) as qty,
           sum(oi.quantity * oi.unit_price) as rev,
           sum(case
                 when m.sold_by_weight and wi.id is not null
                   then coalesce(oi.weight_g, 0) * coalesce(grams_to_unit(wi.unit), 0) * wi.cost_per_unit + c.unit_cost * oi.quantity
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
revoke execute on function acct_menu_profit(uuid, date, date) from public, anon;
grant execute on function acct_menu_profit(uuid, date, date) to authenticated;

-- ===== 14) โหมดมืออาชีพ: งบทดลอง (ใช้ทำงบกำไรขาดทุน/งบดุล) · สมุดรายวัน · บัญชีแยกประเภท =====
create or replace function acct_trial_balance(p_restaurant_id uuid, p_from date, p_to date)
returns table (account_id uuid, code text, name text, type text, grp text, opening numeric, debit numeric, credit numeric, closing numeric)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'accountant']) then
    raise exception 'forbidden';
  end if;
  return query
  select a.id, a.code, a.name, a.type, a.grp,
         coalesce(sum(jl.debit - jl.credit) filter (where e.entry_date < p_from), 0),
         coalesce(sum(jl.debit) filter (where e.entry_date between p_from and p_to), 0),
         coalesce(sum(jl.credit) filter (where e.entry_date between p_from and p_to), 0),
         coalesce(sum(jl.debit - jl.credit) filter (where e.entry_date <= p_to), 0)
  from accounts a
  left join journal_lines jl on jl.account_id = a.id
  left join journal_entries e on e.id = jl.entry_id
  where a.restaurant_id = p_restaurant_id
  group by a.id
  order by a.code;
end;
$$;
revoke execute on function acct_trial_balance(uuid, date, date) from public, anon;
grant execute on function acct_trial_balance(uuid, date, date) to authenticated;

create or replace function acct_journal_rows(p_restaurant_id uuid, p_from date, p_to date, p_account_id uuid default null, p_limit int default 5000)
returns table (
  entry_id uuid, entry_no bigint, entry_date date, source_type text, source_id uuid, memo text, reason text,
  reverses_entry_id uuid, created_at timestamptz, created_by_name text,
  line_id bigint, account_code text, account_name text, debit numeric, credit numeric, line_memo text
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'accountant']) then
    raise exception 'forbidden';
  end if;
  return query
  select e.id, e.entry_no, e.entry_date, e.source_type, e.source_id, e.memo, e.reason, e.reverses_entry_id, e.created_at,
         coalesce(u.display_name, u.email), jl.id, a.code, a.name, jl.debit, jl.credit, jl.memo
  from journal_entries e
  join journal_lines jl on jl.entry_id = e.id
  join accounts a on a.id = jl.account_id
  left join app_users u on u.id = e.created_by
  where e.restaurant_id = p_restaurant_id and e.entry_date between p_from and p_to
    and (p_account_id is null or jl.account_id = p_account_id)
  order by e.entry_date, e.entry_no, jl.id
  limit least(greatest(coalesce(p_limit, 5000), 1), 50000);
end;
$$;
revoke execute on function acct_journal_rows(uuid, date, date, uuid, int) from public, anon;
grant execute on function acct_journal_rows(uuid, date, date, uuid, int) to authenticated;

-- ===== 15) ปิดวัน =====
create or replace function acct_day_summary(p_restaurant_id uuid, p_date date)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  d day_closes;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'accountant']) then
    raise exception 'forbidden';
  end if;
  select * into d from day_closes where restaurant_id = p_restaurant_id and close_date = p_date;
  return acct_summary_data(p_restaurant_id, p_date, p_date) || jsonb_build_object(
    'restaurant', (select name from restaurants where id = p_restaurant_id),
    'date', p_date,
    'system_cash', (select coalesce(sum(jl.debit - jl.credit), 0)
                    from journal_lines jl join journal_entries e on e.id = jl.entry_id
                    join accounts a on a.id = jl.account_id and a.grp = 'cash'
                    where jl.restaurant_id = p_restaurant_id and e.entry_date <= p_date
                      and not (e.source_type = 'day_close' and e.entry_date = p_date)),
    'closed', d.id is not null,
    'close', case when d.id is null then null else jsonb_build_object(
      'counted_cash', d.counted_cash, 'difference', d.difference, 'note', d.note,
      'confirmed_by_name', d.confirmed_by_name, 'created_at', d.created_at) end
  );
end;
$$;
revoke execute on function acct_day_summary(uuid, date) from public, anon;
grant execute on function acct_day_summary(uuid, date) to authenticated;

-- นับเงินสดในลิ้นชักแล้วยืนยัน: ส่วนต่างลงบัญชีเงินสดขาด/เกิน แล้วล็อกวันนั้น (เพิ่มรายการไม่ได้อีก แก้ได้เฉพาะกลับรายการ)
create or replace function acct_close_day(p_restaurant_id uuid, p_date date, p_counted_cash numeric, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_system numeric;
  v_diff numeric;
  v_entry uuid;
  v_summary jsonb;
  v_id uuid;
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
  if exists (select 1 from day_closes where restaurant_id = p_restaurant_id and close_date = p_date) then
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
revoke execute on function acct_close_day(uuid, date, numeric, text) from public, anon;
grant execute on function acct_close_day(uuid, date, numeric, text) to authenticated;

-- ===== 16) ยอดยกมาของสต็อกที่มีอยู่ก่อนเปิดใช้โมดูลบัญชี (บัญชีสต็อก = มูลค่าในโมดูลสต็อกตั้งแต่วันแรก) =====
do $$
declare
  r record;
  v uuid;
begin
  for r in
    select i.restaurant_id, sum(round(i.quantity_on_hand * i.cost_per_unit, 2)) as v
    from ingredients i
    group by i.restaurant_id
    having sum(round(i.quantity_on_hand * i.cost_per_unit, 2)) <> 0
  loop
    if not exists (select 1 from journal_entries where restaurant_id = r.restaurant_id) then
      v := acct_new_entry(r.restaurant_id, 'opening', null, acct_today(r.restaurant_id), 'ยอดยกมา สต็อกวัตถุดิบ (เปิดใช้โมดูลบัญชี)');
      perform acct_line(v, 'stock', r.v);
      perform acct_line(v, 'equity', -r.v);
    end if;
  end loop;
end;
$$;
