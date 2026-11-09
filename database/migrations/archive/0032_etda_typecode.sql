-- 0032: XML ETDA ของใบกำกับภาษีเต็มรูป (TAX) ใช้ TypeCode T03 = ใบเสร็จรับเงิน/ใบกำกับภาษี (ร้านอาหารรับเงินทันที)
--   ABB คง T05 (ใบกำกับภาษีอย่างย่อ ตาม ขมธอ.3-2560 · T04 = ใบส่งของ/ใบกำกับภาษี ไม่ใช่ใบอย่างย่อ) · CN = 81
--   เอกสารที่ยืนยันแล้วก่อน migration นี้เก็บ XML เดิมไว้ (แก้ไม่ได้ตามกฎหมาย) มีผลกับเอกสารที่ยืนยันหลังจากนี้

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
