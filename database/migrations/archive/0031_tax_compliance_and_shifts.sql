-- 0031: ภาษีตามกรมสรรพากร + กะแคชเชียร์ + ภาษีซื้อ/หัก ณ ที่จ่ายของรายจ่าย
--   - tax_settings / pos_terminals: ข้อมูลผู้ประกอบการจดทะเบียน VAT และเครื่อง POS ที่ได้รับอนุมัติ (ภ.พ.06)
--   - document_sequences + next_tax_doc_no(): เลขที่เอกสารเรียงต่อเนื่องไม่ขาดช่วง ต่อ ประเภท/เครื่อง/เดือน
--     ออกเลขตอน "ยืนยัน" เท่านั้น ในธุรกรรมเดียวกับการบันทึกเอกสาร (ล็อกแถวลำดับเลขจน commit · rollback = เลขคืน)
--   - tax_documents: ABB (ใบกำกับภาษีอย่างย่อ) · TAX (ใบกำกับภาษีเต็มรูป / แปลงจาก ABB) · CN (ใบลดหนี้)
--     เขียนผ่านฟังก์ชันเท่านั้น · ลบไม่ได้ · ยืนยันแล้วแก้ไม่ได้ (ยกเลิกเอกสารที่ยืนยันแล้ว = ออกใบลดหนี้)
--     xml_payload: XML ตามโครงสร้าง ETDA (ขมธอ.3-2560) สำหรับส่งออกเอง ควรตรวจกับ XSD ก่อนยื่นจริง
--   - cashier_shifts / cash_drawer_logs: เปิด-ปิดกะ เงินทอนตั้งต้น เงินเข้า/ออกลิ้นชัก ยอดที่ควรมี เทียบนับจริง
--     ออเดอร์ที่ชำระเงินผูกกับกะที่เปิดอยู่ของผู้รับเงินอัตโนมัติ (orders.shift_id)
--   - expenses: ผู้ขาย เลขผู้เสียภาษี ใบกำกับภาษีซื้อ ภาษีหัก ณ ที่จ่าย (ภ.ง.ด.3 / ภ.ง.ด.53) ลงบัญชี 2040 อัตโนมัติ
--   หมายเหตุ: ระบบนี้ไม่ใช่เครื่องมือยื่นภาษีอย่างเป็นทางการ ควรให้นักบัญชีตรวจ

-- ===== 0) ตัวช่วย =====
-- เลขประจำตัวผู้เสียภาษี / บัตรประชาชน 13 หลัก พร้อม checksum (mod 11)
create or replace function th_tax_id_valid(p text)
returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select case when p ~ '^[0-9]{13}$' then
    (11 - (select sum(substr(p, i, 1)::int * (14 - i)) from generate_series(1, 12) as i) % 11) % 10
      = substr(p, 13, 1)::int
  end;
$$;

create or replace function tax_fmt(p numeric)
returns text
language sql immutable set search_path = public, pg_temp as $$
  select to_char(coalesce(p, 0), 'FM999999999990.00');
$$;

-- แยกยอดรวม VAT (ราคารวมภาษี) เป็นฐานภาษี + ภาษี
create or replace function tax_doc_split(p_total numeric, p_exempt numeric, p_rate numeric,
                                         out taxable numeric, out vat numeric)
language sql immutable set search_path = public, pg_temp as $$
  select (p_total - p_exempt) - round((p_total - p_exempt) * p_rate / (100 + p_rate), 2),
         round((p_total - p_exempt) * p_rate / (100 + p_rate), 2);
$$;
revoke execute on function tax_fmt(numeric) from public, anon, authenticated;
revoke execute on function tax_doc_split(numeric, numeric, numeric) from public, anon, authenticated;

create or replace function tax_block_truncate()
returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'tax_record_immutable';
end;
$$;

-- ===== 1) ข้อมูลผู้ประกอบการ และเครื่อง POS =====
create table if not exists tax_settings (
  restaurant_id uuid primary key references restaurants(id) on delete cascade,
  tax_id text not null check (th_tax_id_valid(tax_id)),
  company_name text not null check (char_length(trim(company_name)) between 1 and 200),
  branch_code text not null default '00000' check (branch_code ~ '^[0-9]{5}$'),   -- 00000 = สำนักงานใหญ่
  branch_name text check (char_length(branch_name) <= 100),
  registered_address text not null check (char_length(trim(registered_address)) between 1 and 500),
  postcode text check (postcode ~ '^[0-9]{5}$'),
  updated_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function tax_settings_touch()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and new.restaurant_id <> old.restaurant_id then
    raise exception 'invalid_request';
  end if;
  new.company_name := trim(new.company_name);
  new.registered_address := trim(new.registered_address);
  new.updated_by := (select id from app_users where id = auth.uid());
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists tax_settings_touch on tax_settings;
create trigger tax_settings_touch before insert or update on tax_settings
  for each row execute function tax_settings_touch();

alter table tax_settings enable row level security;
drop policy if exists tax_settings_read on tax_settings;
create policy tax_settings_read on tax_settings for select using (is_staff_of(restaurant_id));
drop policy if exists tax_settings_insert on tax_settings;
create policy tax_settings_insert on tax_settings for insert
  with check (has_role(restaurant_id, array['owner', 'accountant']));
drop policy if exists tax_settings_update on tax_settings;
create policy tax_settings_update on tax_settings for update
  using (has_role(restaurant_id, array['owner', 'accountant']))
  with check (has_role(restaurant_id, array['owner', 'accountant']));
revoke all on tax_settings from anon, authenticated;
grant select on tax_settings to authenticated;
grant insert (restaurant_id, tax_id, company_name, branch_code, branch_name, registered_address, postcode) on tax_settings to authenticated;
grant update (tax_id, company_name, branch_code, branch_name, registered_address, postcode) on tax_settings to authenticated;

create table if not exists pos_terminals (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  terminal_code text not null check (terminal_code ~ '^[A-Z0-9]{1,10}$'),        -- ใช้ในเลขที่เอกสาร
  name text not null check (char_length(trim(name)) between 1 and 80),
  pos_reg_no text check (pos_reg_no ~ '^[A-Za-z0-9/-]{1,30}$'),                  -- เลขอนุมัติเครื่อง POS จากกรมสรรพากร
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, terminal_code)
);
create unique index if not exists pos_terminals_reg_no_key on pos_terminals (pos_reg_no) where pos_reg_no is not null;

alter table pos_terminals enable row level security;
drop policy if exists pos_terminals_read on pos_terminals;
create policy pos_terminals_read on pos_terminals for select using (is_staff_of(restaurant_id));
drop policy if exists pos_terminals_insert on pos_terminals;
create policy pos_terminals_insert on pos_terminals for insert
  with check (has_role(restaurant_id, array['owner', 'manager']));
drop policy if exists pos_terminals_update on pos_terminals;
create policy pos_terminals_update on pos_terminals for update
  using (has_role(restaurant_id, array['owner', 'manager']))
  with check (has_role(restaurant_id, array['owner', 'manager']));
drop policy if exists pos_terminals_delete on pos_terminals;
create policy pos_terminals_delete on pos_terminals for delete
  using (has_role(restaurant_id, array['owner', 'manager']));
revoke all on pos_terminals from anon, authenticated;
grant select, delete on pos_terminals to authenticated;
grant insert (restaurant_id, terminal_code, name, pos_reg_no, is_active) on pos_terminals to authenticated;
grant update (terminal_code, name, pos_reg_no, is_active) on pos_terminals to authenticated;

-- ===== 2) ลำดับเลขที่เอกสาร =====
create table if not exists document_sequences (
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  doc_prefix text not null check (doc_prefix in ('ABB', 'TAX', 'CN')),
  terminal_code text not null check (terminal_code ~ '^[A-Z0-9]{1,10}$'),
  year_month text not null check (year_month ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
  last_no bigint not null check (last_no > 0),
  updated_at timestamptz not null default now(),
  primary key (restaurant_id, doc_prefix, terminal_code, year_month)
);

-- เลขเดินหน้าทีละ 1 เท่านั้น ลด/ข้าม/ลบไม่ได้ (ยกเว้นลบทั้งร้าน)
create or replace function document_sequences_guard()
returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from restaurants where id = old.restaurant_id) then
      raise exception 'tax_record_immutable';
    end if;
    return old;
  end if;
  if new.restaurant_id <> old.restaurant_id or new.doc_prefix <> old.doc_prefix
     or new.terminal_code <> old.terminal_code or new.year_month <> old.year_month
     or new.last_no <> old.last_no + 1 then
    raise exception 'tax_record_immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists document_sequences_guard on document_sequences;
create trigger document_sequences_guard before update or delete on document_sequences
  for each row execute function document_sequences_guard();
drop trigger if exists document_sequences_no_truncate on document_sequences;
create trigger document_sequences_no_truncate before truncate on document_sequences
  for each statement execute function tax_block_truncate();

alter table document_sequences enable row level security;
drop policy if exists document_sequences_read on document_sequences;
create policy document_sequences_read on document_sequences for select
  using (has_role(restaurant_id, array['owner', 'manager', 'accountant']));
revoke all on document_sequences from anon, authenticated;
grant select on document_sequences to authenticated;

-- เลขถัดไป เช่น ABB-POS01-202611-000001
-- INSERT ... ON CONFLICT DO UPDATE ล็อกแถว (ร้าน, ประเภท, เครื่อง, เดือน) จนจบธุรกรรม ผู้เรียกพร้อมกันต่อคิว
-- เรียกได้เฉพาะภายใน tax_doc_confirm() (ออกเลขพร้อมบันทึกเอกสารในธุรกรรมเดียว เลขจึงไม่ขาดช่วง)
create or replace function next_tax_doc_no(p_restaurant_id uuid, doc_prefix text, terminal_code text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  v_prefix text := upper(trim(next_tax_doc_no.doc_prefix));
  v_terminal text := upper(trim(next_tax_doc_no.terminal_code));
  v_ym text;
  v_no bigint;
begin
  if v_prefix is null or v_prefix not in ('ABB', 'TAX', 'CN') then
    raise exception 'invalid_doc_prefix';
  end if;
  if not exists (select 1 from pos_terminals t
                 where t.restaurant_id = p_restaurant_id and t.terminal_code = v_terminal and t.is_active) then
    raise exception 'terminal_not_found';
  end if;
  v_ym := to_char(now() at time zone coalesce((select timezone from restaurants where id = p_restaurant_id), 'Asia/Bangkok'),
                  'YYYYMM');
  insert into document_sequences as s (restaurant_id, doc_prefix, terminal_code, year_month, last_no)
  values (p_restaurant_id, v_prefix, v_terminal, v_ym, 1)
  on conflict (restaurant_id, doc_prefix, terminal_code, year_month)
  do update set last_no = s.last_no + 1, updated_at = now()
  returning s.last_no into v_no;
  return v_prefix || '-' || v_terminal || '-' || v_ym || '-'
         || lpad(v_no::text, greatest(6, char_length(v_no::text)), '0');
end;
$$;
revoke execute on function next_tax_doc_no(uuid, text, text) from public, anon, authenticated;
grant execute on function next_tax_doc_no(uuid, text, text) to service_role;

-- ===== 3) เอกสารภาษี =====
create table if not exists tax_documents (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  order_id uuid not null references orders(id),
  ref_document_id uuid references tax_documents(id),          -- CN: เอกสารที่ลดหนี้ · TAX: ABB ที่แปลงมา
  doc_type text not null check (doc_type in ('ABB', 'TAX', 'CN')),
  doc_number text,
  status text not null default 'draft' check (status in ('draft', 'confirmed', 'voided')),
  -- ข้อมูลผู้ขายและเครื่อง ณ วันที่ออก (เก็บสำเนา แก้ตั้งค่าภายหลังเอกสารเดิมไม่เปลี่ยน)
  terminal_id uuid references pos_terminals(id),
  terminal_code text,
  pos_reg_no text,
  seller_tax_id text,
  seller_name text,
  seller_branch_code text,
  seller_address text,
  seller_postcode text,
  buyer_name text check (char_length(buyer_name) <= 200),
  buyer_tax_id text check (th_tax_id_valid(buyer_tax_id)),
  buyer_branch_code text check (buyer_branch_code ~ '^[0-9]{5}$'),
  buyer_address text check (char_length(buyer_address) <= 500),
  vat_rate numeric(5,2) not null check (vat_rate >= 0 and vat_rate <= 30),
  taxable_amount numeric(14,2) not null default 0 check (taxable_amount >= 0),
  exempt_amount numeric(14,2) not null default 0 check (exempt_amount >= 0),
  vat_amount numeric(14,2) not null default 0 check (vat_amount >= 0),
  total_amount numeric(14,2) not null check (total_amount > 0),
  credit_note_reason text check (char_length(credit_note_reason) <= 300),
  xml_payload text,
  issue_date date,
  created_by uuid,                                            -- ไม่ผูก FK: ลบผู้ใช้แล้วเอกสารต้องอยู่ครบ
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_by uuid,
  confirmed_by_name text,
  confirmed_at timestamptz,
  voided_by uuid,
  voided_by_name text,
  voided_at timestamptz,
  void_reason text check (char_length(void_reason) <= 300),
  constraint tax_documents_number_key unique (restaurant_id, doc_number),
  constraint tax_documents_amounts_check check (
    total_amount = taxable_amount + exempt_amount + vat_amount
    and abs(vat_amount - round(taxable_amount * vat_rate / 100, 2)) <= 0.01),
  constraint tax_documents_ref_check check (
    (doc_type = 'ABB' and ref_document_id is null and credit_note_reason is null)
    or (doc_type = 'TAX' and credit_note_reason is null)
    or (doc_type = 'CN' and ref_document_id is not null and coalesce(trim(credit_note_reason), '') <> '')),
  constraint tax_documents_buyer_branch_check check (buyer_branch_code is null or buyer_tax_id is not null),
  constraint tax_documents_state_check check (
    case status
      when 'draft' then doc_number is null and confirmed_at is null and voided_at is null and xml_payload is null
      when 'confirmed' then doc_number is not null and confirmed_at is not null and issue_date is not null
                            and xml_payload is not null and terminal_code is not null and voided_at is null
                            and seller_tax_id is not null and seller_name is not null
                            and seller_branch_code is not null and seller_address is not null
      when 'voided' then doc_number is null and confirmed_at is null and voided_at is not null
    end),
  constraint tax_documents_full_buyer_check check (
    doc_type <> 'TAX' or status <> 'confirmed'
    or (buyer_name is not null and buyer_tax_id is not null and buyer_branch_code is not null and buyer_address is not null))
);
create index if not exists tax_documents_restaurant_date_idx on tax_documents (restaurant_id, issue_date);
create index if not exists tax_documents_order_idx on tax_documents (order_id);
create index if not exists tax_documents_ref_idx on tax_documents (ref_document_id) where ref_document_id is not null;
-- 1 ออเดอร์มี ABB ได้ 1 ใบ และ TAX ได้ 1 ใบ (ไม่นับฉบับร่างที่ยกเลิก)
create unique index if not exists tax_documents_order_type_key on tax_documents (order_id, doc_type)
  where doc_type in ('ABB', 'TAX') and status <> 'voided';

-- ลบไม่ได้ (ยกเว้นลบทั้งร้าน) · สร้างได้เฉพาะฉบับร่าง · ยืนยัน/ยกเลิกแล้วแก้ไม่ได้
-- ร่าง → ยืนยัน ผ่าน tax_doc_confirm() เท่านั้น (ออกเลขในธุรกรรมเดียวกัน)
create or replace function tax_documents_guard()
returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from restaurants where id = old.restaurant_id) then
      raise exception 'tax_document_no_delete';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.doc_number is not null or new.confirmed_at is not null
       or new.voided_at is not null or new.xml_payload is not null then
      raise exception 'tax_document_insert_draft_only';
    end if;
    return new;
  end if;
  if old.status <> 'draft' then
    raise exception 'tax_document_immutable';
  end if;
  if new.id <> old.id or new.restaurant_id <> old.restaurant_id or new.order_id <> old.order_id
     or new.doc_type <> old.doc_type or new.ref_document_id is distinct from old.ref_document_id
     or new.created_at <> old.created_at or new.created_by is distinct from old.created_by then
    raise exception 'invalid_request';
  end if;
  if new.status = 'confirmed' and coalesce(current_setting('plato.tax_confirm_ctx', true), '') <> old.id::text then
    raise exception 'tax_document_confirm_via_function';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists tax_documents_guard on tax_documents;
create trigger tax_documents_guard before insert or update or delete on tax_documents
  for each row execute function tax_documents_guard();
drop trigger if exists tax_documents_no_truncate on tax_documents;
create trigger tax_documents_no_truncate before truncate on tax_documents
  for each statement execute function tax_block_truncate();

alter table tax_documents enable row level security;
drop policy if exists tax_documents_read on tax_documents;
create policy tax_documents_read on tax_documents for select
  using (has_role(restaurant_id, array['owner', 'manager', 'accountant', 'staff']));
-- ไม่มี policy insert/update/delete: เขียนผ่านฟังก์ชัน security definer เท่านั้น
revoke all on tax_documents from anon, authenticated;
grant select on tax_documents to authenticated;

-- เครื่อง POS ที่ออกเอกสารแล้ว: เปลี่ยนรหัสเครื่องไม่ได้ · เลขอนุมัติใส่ครั้งแรกได้ เปลี่ยนภายหลังไม่ได้
create or replace function pos_terminals_guard()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.restaurant_id <> old.restaurant_id then
    raise exception 'invalid_request';
  end if;
  if (new.terminal_code <> old.terminal_code
      or (old.pos_reg_no is not null and new.pos_reg_no is distinct from old.pos_reg_no))
     and (exists (select 1 from tax_documents where terminal_id = old.id)
          or exists (select 1 from document_sequences
                     where restaurant_id = old.restaurant_id and terminal_code = old.terminal_code)) then
    raise exception 'terminal_in_use';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists pos_terminals_guard on pos_terminals;
create trigger pos_terminals_guard before update on pos_terminals
  for each row execute function pos_terminals_guard();

-- ผู้ขายต้องจดทะเบียน VAT และกรอกข้อมูลผู้ประกอบการครบ
create or replace function tax_doc_seller(p_restaurant_id uuid)
returns tax_settings
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s tax_settings;
begin
  if not coalesce((select vat_registered from shop_settings where restaurant_id = p_restaurant_id), false) then
    raise exception 'vat_not_registered';
  end if;
  select * into s from tax_settings where restaurant_id = p_restaurant_id;
  if s.restaurant_id is null then
    raise exception 'tax_settings_missing';
  end if;
  return s;
end;
$$;
revoke execute on function tax_doc_seller(uuid) from public, anon, authenticated;

create or replace function tax_doc_roles(p_doc_type text)
returns text[]
language sql immutable set search_path = public, pg_temp as $$
  select case when p_doc_type = 'CN' then array['owner', 'manager', 'accountant']
              else array['owner', 'manager', 'accountant', 'staff'] end;
$$;
revoke execute on function tax_doc_roles(text) from public, anon, authenticated;

-- XML ตามโครงสร้าง ETDA Cross Industry Invoice (ABB = TypeCode T05 · TAX = 388 · CN = 81)
create or replace function tax_doc_build_xml(d tax_documents, r tax_documents, p_tz text)
returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_root text := case when d.doc_type = 'CN' then 'DebitCreditNote' else 'TaxInvoice' end;
  v_issue text := to_char(d.confirmed_at at time zone p_tz, 'YYYY-MM-DD"T"HH24:MI:SS');
  v_lines xml;
  v_body xml;
begin
  if d.doc_type = 'CN' then
    v_lines := xmlelement(name "ram:IncludedSupplyChainTradeLineItem",
      xmlelement(name "ram:AssociatedDocumentLineDocument", xmlelement(name "ram:LineID", 1)),
      xmlelement(name "ram:SpecifiedTradeProduct",
        xmlelement(name "ram:Name", left('ลดหนี้ตามเอกสารเลขที่ ' || r.doc_number || ': ' || d.credit_note_reason, 256))),
      xmlelement(name "ram:SpecifiedLineTradeAgreement",
        xmlelement(name "ram:GrossPriceProductTradePrice", xmlelement(name "ram:ChargeAmount", tax_fmt(d.total_amount)))),
      xmlelement(name "ram:SpecifiedLineTradeDelivery",
        xmlelement(name "ram:BilledQuantity", xmlattributes('C62' as "unitCode"), 1)),
      xmlelement(name "ram:SpecifiedLineTradeSettlement",
        xmlelement(name "ram:SpecifiedTradeSettlementLineMonetarySummation",
          xmlelement(name "ram:NetLineTotalAmount", tax_fmt(d.total_amount)))));
  else
    select xmlagg(xmlelement(name "ram:IncludedSupplyChainTradeLineItem",
             xmlelement(name "ram:AssociatedDocumentLineDocument", xmlelement(name "ram:LineID", x.rn)),
             xmlelement(name "ram:SpecifiedTradeProduct", xmlelement(name "ram:Name", x.name)),
             xmlelement(name "ram:SpecifiedLineTradeAgreement",
               xmlelement(name "ram:GrossPriceProductTradePrice", xmlelement(name "ram:ChargeAmount", tax_fmt(x.unit_price)))),
             xmlelement(name "ram:SpecifiedLineTradeDelivery",
               xmlelement(name "ram:BilledQuantity", xmlattributes('C62' as "unitCode"), x.quantity)),
             xmlelement(name "ram:SpecifiedLineTradeSettlement",
               xmlelement(name "ram:SpecifiedTradeSettlementLineMonetarySummation",
                 xmlelement(name "ram:NetLineTotalAmount", tax_fmt(x.line_total)))))
           order by x.rn)
      into v_lines
    from (select row_number() over (order by oi.id) as rn,
                 coalesce(m.name, 'รายการอาหาร') as name,
                 oi.quantity, oi.unit_price,
                 round(oi.unit_price * oi.quantity, 2) as line_total
          from order_items oi
          left join menu_items m on m.id = oi.menu_item_id
          where oi.order_id = d.order_id) x;
  end if;

  v_body := xmlconcat(
    xmlelement(name "rsm:ExchangedDocumentContext",
      xmlelement(name "ram:GuidelineSpecifiedDocumentContextParameter",
        xmlelement(name "ram:ID", xmlattributes('ETDA' as "schemeAgencyID", 'v2.0' as "schemeVersionID"), 'ER3-2560'))),
    xmlelement(name "rsm:ExchangedDocument",
      xmlelement(name "ram:ID", d.doc_number),
      xmlelement(name "ram:Name", case d.doc_type when 'ABB' then 'ใบกำกับภาษีอย่างย่อ'
                                                  when 'TAX' then 'ใบกำกับภาษี' else 'ใบลดหนี้' end),
      xmlelement(name "ram:TypeCode", case d.doc_type when 'ABB' then 'T05' when 'TAX' then '388' else '81' end),
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
            xmlelement(name "ram:ReferenceTypeCode", case r.doc_type when 'ABB' then 'T05' else '388' end))
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
          xmlelement(name "ram:LineTotalAmount", tax_fmt(d.taxable_amount + d.exempt_amount)),
          xmlelement(name "ram:TaxBasisTotalAmount", tax_fmt(d.taxable_amount + d.exempt_amount)),
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
revoke execute on function tax_doc_build_xml(tax_documents, tax_documents, text) from public, anon, authenticated;

-- สร้างฉบับร่าง
--   ABB / TAX: ยอดจากออเดอร์ที่ชำระแล้ว (ราคารวม VAT) · TAX อ้าง ABB = แปลง ABB เป็นใบเต็มรูป (ยอดตาม ABB)
--   CN: อ้างเอกสารที่ยืนยันแล้ว ยอดลดหนี้รวม VAT (p_amount) รวมทุกใบไม่เกินยอดเอกสารต้นทาง
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
revoke execute on function tax_doc_create(text, uuid, uuid, text, text, text, text, numeric, numeric, text) from public, anon;
grant execute on function tax_doc_create(text, uuid, uuid, text, text, text, text, numeric, numeric, text) to authenticated;

-- แก้ฉบับร่าง: ข้อมูลผู้ซื้อแทนที่ทั้งชุด · ยอดยกเว้นภาษี / ยอดลดหนี้ / เหตุผล ส่ง null = คงเดิม
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
revoke execute on function tax_doc_update_draft(uuid, text, text, text, text, numeric, numeric, text) from public, anon;
grant execute on function tax_doc_update_draft(uuid, text, text, text, text, numeric, numeric, text) to authenticated;

-- ยืนยัน: ออกเลขที่ + เก็บสำเนาข้อมูลผู้ขาย + สร้าง XML ในธุรกรรมเดียว (หลังจากนี้แก้/ลบไม่ได้)
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
  select * into d from tax_documents where id = p_document_id for update;
  if d.id is null or not has_role(d.restaurant_id, tax_doc_roles(d.doc_type)) then
    raise exception 'forbidden';
  end if;
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
revoke execute on function tax_doc_confirm(uuid, text) from public, anon;
grant execute on function tax_doc_confirm(uuid, text) to authenticated;

-- ยกเลิกฉบับร่าง (ยังไม่มีเลขที่ จึงไม่ทำให้เลขขาดช่วง)
create or replace function tax_doc_void_draft(p_document_id uuid, p_reason text)
returns tax_documents
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d tax_documents;
begin
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
revoke execute on function tax_doc_void_draft(uuid, text) from public, anon;
grant execute on function tax_doc_void_draft(uuid, text) to authenticated;

-- ===== 4) กะแคชเชียร์ และเงินเข้า/ออกลิ้นชัก =====
create table if not exists cashier_shifts (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  terminal_id uuid references pos_terminals(id),
  cashier_id uuid not null,                         -- ไม่ผูก FK: ลบผู้ใช้แล้วประวัติกะยังอยู่
  cashier_name text not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  starting_cash numeric(14,2) not null check (starting_cash >= 0),
  cash_sales numeric(14,2),
  cash_in_total numeric(14,2),
  cash_out_total numeric(14,2),
  expected_cash numeric(14,2),
  actual_cash numeric(14,2) check (actual_cash >= 0),
  variance_cash numeric(14,2),                      -- นับจริง - ที่ควรมี (+ เกิน / - ขาด)
  close_note text check (char_length(close_note) <= 300),
  closed_by uuid,
  closed_by_name text,
  check (
    (status = 'open' and closed_at is null and actual_cash is null and expected_cash is null and variance_cash is null)
    or (status = 'closed' and closed_at is not null and closed_at >= opened_at
        and actual_cash is not null and expected_cash is not null and cash_sales is not null
        and cash_in_total is not null and cash_out_total is not null
        and expected_cash = starting_cash + cash_sales + cash_in_total - cash_out_total
        and variance_cash = actual_cash - expected_cash))
);
create index if not exists cashier_shifts_restaurant_opened_idx on cashier_shifts (restaurant_id, opened_at);
create unique index if not exists cashier_shifts_open_cashier_key on cashier_shifts (restaurant_id, cashier_id)
  where status = 'open';
create unique index if not exists cashier_shifts_open_terminal_key on cashier_shifts (terminal_id)
  where status = 'open' and terminal_id is not null;

create table if not exists cash_drawer_logs (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references cashier_shifts(id),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  log_type text not null check (log_type in ('cash_in', 'cash_out')),
  amount numeric(14,2) not null check (amount > 0),
  reason text not null check (char_length(trim(reason)) between 1 and 300),
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists cash_drawer_logs_shift_idx on cash_drawer_logs (shift_id, created_at);

-- ปิดกะแล้วแก้ไม่ได้ · ลบไม่ได้ (ยกเว้นลบทั้งร้าน) · รายการเงินเข้า/ออกแก้ไม่ได้
create or replace function cashier_shifts_guard()
returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from restaurants where id = old.restaurant_id) then
      raise exception 'shift_immutable';
    end if;
    return old;
  end if;
  if tg_table_name = 'cash_drawer_logs' or old.status = 'closed' then
    raise exception 'shift_immutable';
  end if;
  if new.restaurant_id <> old.restaurant_id or new.cashier_id <> old.cashier_id
     or new.opened_at <> old.opened_at or new.starting_cash <> old.starting_cash
     or new.terminal_id is distinct from old.terminal_id then
    raise exception 'invalid_request';
  end if;
  return new;
end;
$$;
drop trigger if exists cashier_shifts_guard on cashier_shifts;
create trigger cashier_shifts_guard before update or delete on cashier_shifts
  for each row execute function cashier_shifts_guard();
drop trigger if exists cash_drawer_logs_guard on cash_drawer_logs;
create trigger cash_drawer_logs_guard before update or delete on cash_drawer_logs
  for each row execute function cashier_shifts_guard();

alter table cashier_shifts enable row level security;
alter table cash_drawer_logs enable row level security;
drop policy if exists cashier_shifts_read on cashier_shifts;
create policy cashier_shifts_read on cashier_shifts for select
  using (has_role(restaurant_id, array['owner', 'manager', 'accountant'])
         or (cashier_id = auth.uid() and is_staff_of(restaurant_id)));
drop policy if exists cash_drawer_logs_read on cash_drawer_logs;
create policy cash_drawer_logs_read on cash_drawer_logs for select
  using (has_role(restaurant_id, array['owner', 'manager', 'accountant'])
         or exists (select 1 from cashier_shifts s where s.id = shift_id and s.cashier_id = auth.uid()));
revoke all on cashier_shifts, cash_drawer_logs from anon, authenticated;
grant select on cashier_shifts, cash_drawer_logs to authenticated;

-- ออเดอร์ที่เปลี่ยนเป็น "ชำระแล้ว" ผูกกับกะที่เปิดอยู่ของผู้รับเงิน (ผู้ใช้ตั้งเองไม่ได้)
alter table orders add column if not exists shift_id uuid references cashier_shifts(id);
create index if not exists orders_shift_idx on orders (shift_id) where shift_id is not null;

create or replace function orders_assign_shift()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'paid' and (tg_op = 'INSERT' or old.status is distinct from 'paid') then
    new.shift_id := (select id from cashier_shifts
                     where restaurant_id = new.restaurant_id and cashier_id = auth.uid() and status = 'open');
  elsif tg_op = 'INSERT' then
    new.shift_id := null;
  else
    new.shift_id := old.shift_id;
  end if;
  return new;
end;
$$;
drop trigger if exists orders_assign_shift on orders;
create trigger orders_assign_shift before insert or update on orders
  for each row execute function orders_assign_shift();

-- ยอดของกะ: เงินทอนตั้งต้น + ขายเงินสด (บิลที่ยังเป็นชำระแล้ว) + เงินเข้า - เงินออก
create or replace function shift_totals(p_shift_id uuid,
  out cash_sales numeric, out cash_in_total numeric, out cash_out_total numeric, out expected_cash numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  select x.sales, x.cin, x.cout, s.starting_cash + x.sales + x.cin - x.cout
  from cashier_shifts s
  cross join lateral (
    select
      coalesce((select sum(o.total) from orders o
                where o.shift_id = s.id and o.status = 'paid' and o.payment_method = 'cash'), 0)::numeric(14,2) as sales,
      coalesce((select sum(l.amount) from cash_drawer_logs l
                where l.shift_id = s.id and l.log_type = 'cash_in'), 0)::numeric(14,2) as cin,
      coalesce((select sum(l.amount) from cash_drawer_logs l
                where l.shift_id = s.id and l.log_type = 'cash_out'), 0)::numeric(14,2) as cout
  ) x
  where s.id = p_shift_id;
$$;
revoke execute on function shift_totals(uuid) from public, anon, authenticated;

create or replace function shift_open(p_restaurant_id uuid, p_starting_cash numeric, p_terminal_code text default null)
returns cashier_shifts
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  u app_users;
  t pos_terminals;
  s cashier_shifts;
begin
  if not has_role(p_restaurant_id, array['owner', 'manager', 'staff']) then
    raise exception 'forbidden';
  end if;
  select * into u from app_users where id = auth.uid();
  if u.id is null then
    raise exception 'forbidden';
  end if;
  if p_starting_cash is null or p_starting_cash < 0 then
    raise exception 'invalid_amount';
  end if;
  if nullif(trim(p_terminal_code), '') is not null then
    select * into t from pos_terminals
    where restaurant_id = p_restaurant_id and terminal_code = upper(trim(p_terminal_code)) and is_active;
    if t.id is null then
      raise exception 'terminal_not_found';
    end if;
  end if;
  begin
    insert into cashier_shifts (restaurant_id, terminal_id, cashier_id, cashier_name, starting_cash)
    values (p_restaurant_id, t.id, u.id, coalesce(u.display_name, u.email), round(p_starting_cash, 2))
    returning * into s;
  exception when unique_violation then
    raise exception 'shift_already_open';
  end;
  return s;
end;
$$;
revoke execute on function shift_open(uuid, numeric, text) from public, anon;
grant execute on function shift_open(uuid, numeric, text) to authenticated;

create or replace function shift_cash_log(p_shift_id uuid, p_log_type text, p_amount numeric, p_reason text)
returns cash_drawer_logs
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s cashier_shifts;
  l cash_drawer_logs;
  v_amount numeric := round(coalesce(p_amount, 0), 2);
begin
  select * into s from cashier_shifts where id = p_shift_id for update;
  if s.id is null or not (has_role(s.restaurant_id, array['owner', 'manager'])
                          or (s.cashier_id = auth.uid() and is_staff_of(s.restaurant_id))) then
    raise exception 'forbidden';
  end if;
  if s.status <> 'open' then
    raise exception 'shift_closed';
  end if;
  if p_log_type not in ('cash_in', 'cash_out') then
    raise exception 'invalid_log_type';
  end if;
  if v_amount <= 0 then
    raise exception 'invalid_amount';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'reason_required';
  end if;
  if p_log_type = 'cash_out' and (select expected_cash from shift_totals(s.id)) - v_amount < 0 then
    raise exception 'insufficient_cash';
  end if;
  insert into cash_drawer_logs (shift_id, restaurant_id, log_type, amount, reason, created_by, created_by_name)
  values (s.id, s.restaurant_id, p_log_type, v_amount, left(trim(p_reason), 300),
          (select id from app_users where id = auth.uid()),
          (select coalesce(display_name, email) from app_users where id = auth.uid()))
  returning * into l;
  return l;
end;
$$;
revoke execute on function shift_cash_log(uuid, text, numeric, text) from public, anon;
grant execute on function shift_cash_log(uuid, text, numeric, text) to authenticated;

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
revoke execute on function shift_close(uuid, numeric, text) from public, anon;
grant execute on function shift_close(uuid, numeric, text) to authenticated;

-- สรุปกะ (X-Report ระหว่างกะ / Z-Report หลังปิดกะ)
create or replace function shift_report(p_shift_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s cashier_shifts;
  x record;
begin
  select * into s from cashier_shifts where id = p_shift_id;
  if s.id is null or not (has_role(s.restaurant_id, array['owner', 'manager', 'accountant'])
                          or (s.cashier_id = auth.uid() and is_staff_of(s.restaurant_id))) then
    raise exception 'forbidden';
  end if;
  select * into x from shift_totals(s.id);
  return jsonb_build_object(
    'shift', to_jsonb(s),
    'cash_sales', x.cash_sales,
    'cash_in_total', x.cash_in_total,
    'cash_out_total', x.cash_out_total,
    'expected_cash', case when s.status = 'closed' then s.expected_cash else x.expected_cash end,
    'sales_by_method', coalesce((
      select jsonb_object_agg(m.method, jsonb_build_object('bills', m.bills, 'total', m.total))
      from (select coalesce(o.payment_method, 'other') as method, count(*) as bills, sum(o.total) as total
            from orders o where o.shift_id = s.id and o.status = 'paid'
            group by 1) m), '{}'::jsonb),
    'cancelled_after_paid', (select count(*) from orders o where o.shift_id = s.id and o.status = 'cancelled'),
    'drawer_logs', coalesce((
      select jsonb_agg(jsonb_build_object('type', l.log_type, 'amount', l.amount, 'reason', l.reason,
                                          'by', l.created_by_name, 'at', l.created_at) order by l.created_at)
      from cash_drawer_logs l where l.shift_id = s.id), '[]'::jsonb));
end;
$$;
revoke execute on function shift_report(uuid) from public, anon;
grant execute on function shift_report(uuid) to authenticated;

-- ===== 5) รายจ่าย: ผู้ขาย ใบกำกับภาษีซื้อ ภาษีหัก ณ ที่จ่าย =====
alter table expenses add column if not exists supplier_name text check (char_length(trim(supplier_name)) between 1 and 200);
alter table expenses add column if not exists supplier_tax_id text check (th_tax_id_valid(supplier_tax_id));
alter table expenses add column if not exists supplier_branch_code text check (supplier_branch_code ~ '^[0-9]{5}$');
alter table expenses add column if not exists tax_invoice_no text check (char_length(trim(tax_invoice_no)) between 1 and 50);
alter table expenses add column if not exists tax_invoice_date date;
alter table expenses add column if not exists vat_amount numeric(12,2) not null default 0 check (vat_amount >= 0);
alter table expenses add column if not exists wht_rate numeric(4,2) check (wht_rate in (1, 2, 3, 5));
alter table expenses add column if not exists wht_amount numeric(12,2) not null default 0 check (wht_amount >= 0);
alter table expenses add column if not exists wht_type text check (wht_type in ('pnd3', 'pnd53'));

alter table expenses drop constraint if exists expenses_tax_invoice_check;
alter table expenses add constraint expenses_tax_invoice_check check (
  (tax_invoice_no is null and tax_invoice_date is null)
  or (tax_invoice_no is not null and tax_invoice_date is not null
      and supplier_name is not null and supplier_tax_id is not null));
alter table expenses drop constraint if exists expenses_supplier_branch_check;
alter table expenses add constraint expenses_supplier_branch_check check (
  supplier_branch_code is null or supplier_tax_id is not null);
-- ภ.ง.ด.53 = นิติบุคคล (เลขผู้เสียภาษีขึ้นต้น 0) · ภ.ง.ด.3 = บุคคลธรรมดา
alter table expenses drop constraint if exists expenses_wht_check;
alter table expenses add constraint expenses_wht_check check (
  (wht_rate is null and wht_type is null and wht_amount = 0)
  or (wht_rate is not null and wht_type is not null
      and supplier_name is not null and supplier_tax_id is not null
      and wht_amount <= amount - vat_amount
      and (wht_type = 'pnd53') = (left(supplier_tax_id, 1) = '0')));

-- ใบกำกับภาษีซื้อใบเดียวใช้ได้ครั้งเดียว (ไม่นับรายจ่ายที่ยกเลิก)
create unique index if not exists expenses_tax_invoice_key
  on expenses (restaurant_id, supplier_tax_id, supplier_branch_code, tax_invoice_no)
  where tax_invoice_no is not null and voided_at is null;
create index if not exists expenses_wht_idx on expenses (restaurant_id, wht_type, spent_on) where wht_type is not null;

-- คำนวณภาษีหัก ณ ที่จ่ายจากฐานก่อน VAT (ทำงานหลัง expenses_before_insert ตามลำดับชื่อ trigger)
create or replace function expenses_tax_fields()
returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.supplier_name := nullif(trim(new.supplier_name), '');
  new.supplier_tax_id := nullif(trim(new.supplier_tax_id), '');
  new.tax_invoice_no := nullif(trim(new.tax_invoice_no), '');
  if new.supplier_tax_id is not null then
    new.supplier_branch_code := coalesce(nullif(trim(new.supplier_branch_code), ''), '00000');
  else
    new.supplier_branch_code := null;
  end if;
  if new.wht_rate is null then
    new.wht_amount := 0;
    new.wht_type := null;
  else
    if new.source <> 'manual' then
      raise exception 'wht_manual_expense_only';
    end if;
    if new.supplier_tax_id is null then
      raise exception 'wht_supplier_tax_id_required';
    end if;
    new.wht_type := coalesce(new.wht_type, case when left(new.supplier_tax_id, 1) = '0' then 'pnd53' else 'pnd3' end);
    new.wht_amount := round((new.amount - new.vat_amount) * new.wht_rate / 100, 2);
  end if;
  return new;
end;
$$;
drop trigger if exists expenses_tax_fields on expenses;
create trigger expenses_tax_fields before insert on expenses
  for each row execute function expenses_tax_fields();

grant insert (supplier_name, supplier_tax_id, supplier_branch_code, tax_invoice_no, tax_invoice_date, wht_rate, wht_type)
  on expenses to authenticated;

-- บัญชีระบบ: ภาษีหัก ณ ที่จ่ายค้างจ่าย (รหัสแรกที่ว่างในช่วง 2040-2099)
create or replace function acct_seed_wht_account(p_restaurant_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_code text;
begin
  if exists (select 1 from accounts where restaurant_id = p_restaurant_id and system_key = 'wht_payable') then
    return;
  end if;
  select c::text into v_code
  from generate_series(2040, 2099) as c
  where not exists (select 1 from accounts where restaurant_id = p_restaurant_id and code = c::text)
  order by c limit 1;
  if v_code is null then
    raise exception 'account_code_unavailable';
  end if;
  insert into accounts (restaurant_id, code, name, type, grp, system_key)
  values (p_restaurant_id, v_code, 'ภาษีหัก ณ ที่จ่ายค้างจ่าย', 'liability', 'other_liability', 'wht_payable')
  on conflict do nothing;
end;
$$;
revoke execute on function acct_seed_wht_account(uuid) from public, anon, authenticated;

select acct_seed_wht_account(id) from restaurants;

create or replace function restaurants_seed_wht_account()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform acct_seed_wht_account(new.id);
  return new;
end;
$$;
-- ชื่อ trigger เรียงหลัง restaurants_seed_accounts (ผังบัญชีหลักสร้างก่อน)
drop trigger if exists restaurants_seed_wht_account on restaurants;
create trigger restaurants_seed_wht_account after insert on restaurants
  for each row execute function restaurants_seed_wht_account();

-- ลงบัญชีรายจ่าย: Dr ค่าใช้จ่าย (ก่อน VAT) + Dr ภาษีซื้อ / Cr ภาษีหัก ณ ที่จ่ายค้างจ่าย + Cr เงินที่จ่ายจริง
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
  if new.wht_amount > 0 then
    perform acct_line(v_entry, 'wht_payable', -new.wht_amount);
  end if;
  perform acct_line(v_entry, acct_payment_key(new.restaurant_id, new.payment_method), -(new.amount - new.wht_amount));
  return null;
end;
$$;

-- ลงบัญชีแล้วแก้ยอด/หมวด/วันที่/ภาษี ไม่ได้ ลบไม่ได้ → ใช้ "ยกเลิกรายจ่าย" (กลับรายการ)
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
     or new.vat_amount <> old.vat_amount or new.source <> old.source or new.restaurant_id <> old.restaurant_id
     or new.wht_rate is distinct from old.wht_rate or new.wht_amount <> old.wht_amount
     or new.wht_type is distinct from old.wht_type
     or new.supplier_tax_id is distinct from old.supplier_tax_id
     or new.supplier_branch_code is distinct from old.supplier_branch_code
     or new.tax_invoice_no is distinct from old.tax_invoice_no
     or new.tax_invoice_date is distinct from old.tax_invoice_date then
    raise exception 'expense_posted_use_void';
  end if;
  return new;
end;
$$;
