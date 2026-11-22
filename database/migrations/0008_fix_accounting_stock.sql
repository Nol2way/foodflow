-- 0008: แก้บั๊กระบบบัญชี ภาษี และสต็อก
-- 1) accounting_summary() และ daily_report_data(): ตัดรายจ่ายที่ถูกยกเลิก (voided_at is null)
-- 2) orders_accounting(): ห้ามยกเลิกบิลที่จ่ายแล้วหากมีใบกำกับภาษี (ABB/TAX) ที่ยืนยันแล้วและยังไม่มีใบลดหนี้ (CN) ครอบคลุม
-- 3) tax_doc_build_xml(): ปรับยอดรายบรรทัด (NetLineTotalAmount) ให้ตรงกับยอดก่อน VAT หลังส่วนลด (LineTotalAmount)

create or replace function accounting_summary(p_restaurant_id uuid, p_days int default 1)
returns table (
  from_date date,
  to_date date,
  revenue_total numeric,
  paid_orders bigint,
  expense_total numeric,
  expenses_by_category jsonb,
  discount_total numeric
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_tz text;
  v_to date;
  v_from date;
begin
  if not has_role(p_restaurant_id, array['owner', 'accountant', 'manager']) then
    raise exception 'forbidden';
  end if;
  if p_days is null or p_days < 1 or p_days > 366 then
    raise exception 'invalid_days';
  end if;

  select timezone into v_tz from restaurants where id = p_restaurant_id;
  v_to := (now() at time zone v_tz)::date;
  v_from := v_to - (p_days - 1);

  return query
  select v_from,
         v_to,
         coalesce((select sum(o.total) from orders o
                   where o.restaurant_id = p_restaurant_id and o.status = 'paid'
                     and (o.paid_at at time zone v_tz)::date between v_from and v_to), 0)::numeric,
         (select count(*) from orders o
           where o.restaurant_id = p_restaurant_id and o.status = 'paid'
             and (o.paid_at at time zone v_tz)::date between v_from and v_to)::bigint,
         coalesce((select sum(e.amount) from expenses e
                   where e.restaurant_id = p_restaurant_id and e.voided_at is null
                     and e.spent_on between v_from and v_to), 0)::numeric,
         coalesce((select jsonb_object_agg(x.category, x.amount) from (
                     select e.category::text as category, sum(e.amount) as amount
                     from expenses e
                     where e.restaurant_id = p_restaurant_id and e.voided_at is null
                       and e.spent_on between v_from and v_to
                     group by e.category) x), '{}'::jsonb),
         coalesce((select sum(o.discount_total) from orders o
                   where o.restaurant_id = p_restaurant_id and o.status = 'paid'
                     and (o.paid_at at time zone v_tz)::date between v_from and v_to), 0)::numeric;
end;
$$;

revoke execute on function accounting_summary(uuid, int) from public, anon;
grant execute on function accounting_summary(uuid, int) to authenticated;

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
                and created_at >= v_from and created_at < v_to),
    'revenue', (select coalesce(sum(total), 0) from orders where restaurant_id = p_restaurant_id and status = 'paid'
                and created_at >= v_from and created_at < v_to),
    'discount', (select coalesce(sum(discount_total), 0) from orders where restaurant_id = p_restaurant_id and status = 'paid'
                and created_at >= v_from and created_at < v_to),
    'revenue_last_week', (select coalesce(sum(total), 0) from orders where restaurant_id = p_restaurant_id and status = 'paid'
                and created_at >= v_prev_from and created_at < v_prev_from + interval '1 day'),
    'cancelled', (select count(*) from orders where restaurant_id = p_restaurant_id and status = 'cancelled'
                and created_at >= v_from and created_at < v_to),
    'payments', coalesce((
      select jsonb_object_agg(coalesce(payment_method, 'unknown'), amount)
      from (select payment_method, sum(total) as amount from orders
            where restaurant_id = p_restaurant_id and status = 'paid' and created_at >= v_from and created_at < v_to
            group by payment_method) x
    ), '{}'::jsonb),
    'top_items', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'quantity', qty, 'amount', amount) order by qty desc, name)
      from (
        select m.name, sum(oi.quantity) as qty, sum(oi.quantity * oi.unit_price) as amount
        from order_items oi
        join orders o on o.id = oi.order_id
        join menu_items m on m.id = oi.menu_item_id
        where o.restaurant_id = p_restaurant_id and o.status = 'paid' and o.created_at >= v_from and o.created_at < v_to
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
revoke execute on function daily_report_data(uuid, date) from public, anon, authenticated;
grant execute on function daily_report_data(uuid, date) to service_role;

-- ป้องกันการยกเลิกบิลที่จ่ายแล้วหากยังมีใบกำกับภาษี (ABB/TAX) ที่ยืนยันแล้วและยังไม่ได้ออกใบลดหนี้ (CN) ครบยอด
create or replace function orders_accounting()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bill uuid;
  v_confirmed_tax numeric;
  v_confirmed_cn numeric;
begin
  if new.import_batch is not null or new.is_demo then
    return null;
  end if;

  if new.status = 'paid' and old.status <> 'paid' then
    perform acct_post_bill(new);
  end if;

  if new.status = 'cancelled' and old.status <> 'cancelled' and old.status = 'paid' then
    -- ตรวจเอกสารภาษีที่ยืนยันแล้วของออเดอร์นี้ (ไม่นับ ABB ที่ถูกแปลงเป็น TAX แล้ว)
    select coalesce(sum(td.total_amount), 0) into v_confirmed_tax
    from tax_documents td
    where td.restaurant_id = new.restaurant_id
      and td.order_id = new.id
      and td.status = 'confirmed'
      and td.doc_type in ('ABB', 'TAX')
      and not (
        td.doc_type = 'ABB'
        and exists (
          select 1 from tax_documents t2
          where t2.ref_document_id = td.id and t2.doc_type = 'TAX' and t2.status = 'confirmed'
        )
      );

    if v_confirmed_tax > 0 then
      select coalesce(sum(td.total_amount), 0) into v_confirmed_cn
      from tax_documents td
      where td.restaurant_id = new.restaurant_id
        and td.order_id = new.id
        and td.status = 'confirmed'
        and td.doc_type = 'CN';

      if v_confirmed_cn < v_confirmed_tax then
        raise exception 'tax_doc_confirmed_use_cn';
      end if;
    end if;

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

-- ปรับ XML ETDA: ให้ผลรวม NetLineTotalAmount ของทุกรายการเท่ากับ LineTotalAmount (ฐานภาษีก่อน VAT หลังส่วนลด) พอดี
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
    with raw_lines as (
      select row_number() over (order by oi.id) as rn,
             count(*) over () as cnt,
             coalesce(m.name, 'รายการอาหาร') as name,
             oi.quantity,
             round(oi.unit_price * oi.quantity, 2) as gross_total,
             sum(round(oi.unit_price * oi.quantity, 2)) over () as sum_gross
      from order_items oi
      left join menu_items m on m.id = oi.menu_item_id
      where oi.order_id = d.order_id
    ),
    allocated as (
      select rn, cnt, name, quantity,
             case when sum_gross > 0 then round(v_target_net * gross_total / sum_gross, 2) else 0 end as base_net
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
revoke execute on function tax_doc_build_xml(tax_documents, tax_documents, text) from public, anon, authenticated;
