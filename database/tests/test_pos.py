"""POS mutations, option snapshots, fees, splits and retry identity in local PostgreSQL."""
import json
import os
import uuid
from decimal import Decimal
from harness import start, Runner
srv,uri,admin=start()
t=Runner(uri)
q,one,check=t.q,t.one,t.check
rid=one('select id from restaurants order by created_at limit 1')
uid=one('insert into app_users(email) values(%s) returning id',(f'{uuid.uuid4()}@pos.invalid',))
q('su',"insert into staff_members values(%s,%s,'owner')",(uid,rid))
menu=one("insert into menu_items(restaurant_id,name,price,option_choices) values(%s,'Options',10,%s::jsonb) returning id",(rid,json.dumps([{'id':'egg','name':'Egg','price':5}])) )
tables=[r[0] for r in q('su','select id from dining_tables where restaurant_id=%s order by id limit 2',(rid,))[1]]
def items(quantity=1,options=None):
    return json.dumps([{'menu_item_id':str(menu),'quantity':quantity,'selected_option_ids':options or []}])
def place(payload=None,ref=None):
    return q(uid,'select staff_place_order(%s,%s::jsonb,%s,p_client_ref=>%s)',(rid,payload or items(2,['egg']),tables[0],ref))
ref=uuid.uuid4()
first=place(ref=ref)
assert first[0]=='ok',first
oid=first[1][0][0]
check('option price is resolved server-side',one('select total from orders where id=%s',(oid,))==30)
check('options persisted in kitchen/receipt snapshot',one("select options_snapshot->0->>'name' from order_items where order_id=%s",(oid,))=='Egg')
check('same client_ref returns same order',place(ref=ref)[1][0][0]==oid)
check('changed retry payload rejected',place(items(3),ref)[0]=='err')
check('unknown option rejected',place(items(1,['fake']))[0]=='err')
check('duplicate option rejected',place(items(1,['egg','egg']))[0]=='err')
q(uid,'update menu_items set option_choices=%s::jsonb where id=%s',(json.dumps([{'id':'egg','name':'New egg','price':7}]),menu))
check('price changes do not rewrite original snapshot',one('select unit_price from order_items where order_id=%s',(oid,))==15)
check('invalid option config rejected',q(uid,'update menu_items set option_choices=%s::jsonb where id=%s',(json.dumps([{'id':'bad','name':'Bad','price':True}]),menu))[0]=='err')
edit=q(uid,'select staff_edit_order(%s,%s::jsonb,%s)',(oid,items(1,['egg']),'changed'))
check('received order editable with new resolved prices',edit[0]=='ok' and one('select total from orders where id=%s',(oid,))==17,edit)
check('charges add exact amount',q(uid,'select order_set_charges(%s,2.50,3.25)',(oid,))[1][0][0]==Decimal('22.75'))
check('fractional sub-cent charge rejected',q(uid,'select order_set_charges(%s,0.001,0)',(oid,))[0]=='err')
q(uid,'select table_request_bill(%s,%s)',(rid,tables[0]))
check('bill request timestamp stored',one('select bill_requested_at is not null from orders where id=%s',(oid,)))
check('table move moves unpaid order',q(uid,'select table_move_orders(%s,%s,%s)',(rid,tables[0],tables[1]))[0]=='ok' and one('select table_id from orders where id=%s',(oid,))==tables[1])
for status in ['preparing','ready','served']:
    assert q(uid,'update orders set status=%s where id=%s',(status,oid))[0]=='ok'
check('started order cannot be edited',q(uid,'select staff_edit_order(%s,%s::jsonb)',(oid,items()))[0]=='err')
pay=q(uid,'select counter_pay_bill(%s,%s::uuid[],p_expected_total=>22.75)',(rid,[str(oid)]))
check('payment includes exact service and tip',pay[0]=='ok',pay)
receipt=q(uid,'select bill_receipt(%s::uuid[])',([str(oid)],))[1][0][0]
check('receipt preserves fees and options',receipt['service_charge']==2.5 and receipt['tip']==3.25 and receipt['items'][0]['options_snapshot'][0]['name']=='New egg')
check('charged journal balances',one("select sum(debit)=sum(credit) from journal_lines where entry_id=(select id from journal_entries where source_type='bill' and source_id=%s)",(oid,)))
doc=json.dumps({'order_id':str(oid),'doc_type':'ABB','confirmed_at':'2026-01-01T00:00:00Z','taxable_amount':22.75,'exempt_amount':0,'vat_amount':0,'vat_rate':0,'total_amount':22.75})
xml_result=q('su',"select tax_doc_build_xml(jsonb_populate_record(null::tax_documents,%s::jsonb),null::tax_documents,'Asia/Bangkok')",(doc,))
if xml_result[0]=='err' and 'unsupported XML feature' in xml_result[1]:
    if os.environ.get('REQUIRE_XML_TESTS') == '1':
        raise RuntimeError('Release CI requires PostgreSQL with XML support')
    print('SKIP tax XML execution: bundled Windows PostgreSQL lacks XML support; run on libxml-enabled PostgreSQL before release')
else:
    xml=xml_result[1][0][0] if xml_result[0]=='ok' else ''
    check('tax XML represents options, service and tip explicitly','New egg' in xml and 'ค่าบริการ' in xml and 'ทิป' in xml,xml_result)
payload=json.dumps([{'menu_item_id':str(menu),'quantity':1},{'menu_item_id':str(menu),'quantity':2,'selected_option_ids':['egg']}])
split_from=place(payload)[1][0][0]
q(uid,'select order_set_charges(%s,3,4)',(split_from,))
split_item=one('select id from order_items where order_id=%s order by quantity limit 1',(split_from,))
split=q(uid,'select staff_split_order(%s,%s::uuid[])',(split_from,[str(split_item)]))
check('split moves selected line into new bill',split[0]=='ok',split)
split_to=split[1][0][0]
check('split preserves combined total and fee cents',one('select sum(total)=51 and sum(service_charge)=3 and sum(tip)=4 from orders where id=any(%s::uuid[])',([str(split_from),str(split_to)],)))
check('split rejects all remaining lines',q(uid,'select staff_split_order(%s,%s::uuid[])',(split_to,[str(split_item)]))[0]=='err')
check('audit includes workflow changes without customer values',any(x[3]=='insert' and x[4]=='orders' for x in q(uid,'select * from audit_events(%s)',(rid,))[1]))
check('audit private storage inaccessible',q(uid,'delete from private.audit_log')[0]=='err')
fixed=one("insert into promotions(restaurant_id,name,discount_type,value) values(%s,'Split fixed discount','amount',6) returning id",(rid,))
split_payload=json.dumps([{'menu_item_id':str(menu),'quantity':1},{'menu_item_id':str(menu),'quantity':2}])
fixed_parent=q(uid,'select staff_place_order(%s,%s::jsonb,%s,p_promotion_ids=>%s::uuid[])',(rid,split_payload,tables[0],[str(fixed)]))[1][0][0]
fixed_line=one('select id from order_items where order_id=%s and quantity=1',(fixed_parent,))
fixed_child=q(uid,'select staff_split_order(%s,%s::uuid[])',(fixed_parent,[str(fixed_line)]))[1][0][0]
check('both split bills carry immutable allocation marker',one('select bool_and(is_split) from orders where id=any(%s::uuid[])',([str(fixed_parent),str(fixed_child)],)))
check('editing discounted split cannot recalculate full fixed discount',q(uid,'select staff_edit_order(%s,%s::jsonb)',(fixed_parent,items()))[0]=='err')
remaining_line=one('select id from order_items where order_id=%s',(fixed_parent,))
check('partial cancellation cannot recalculate split fixed discount',q(uid,'select cancel_order_items(%s,%s::jsonb)',(fixed_parent,json.dumps([{'id':str(remaining_line),'quantity':1}])))[0]=='err')
for bill in [fixed_child,fixed_parent]:
    for status in ['preparing','ready','served']:
        assert q(uid,'update orders set status=%s where id=%s',(status,bill))[0]=='ok'
    expected=one('select total from orders where id=%s',(bill,))
    paid=q(uid,'select counter_pay_bill(%s,%s::uuid[],%s::uuid[],p_expected_total=>%s)',(rid,[str(bill)],[str(fixed)],expected))
    check('split payment preserves allocated fixed promo after sibling settles',paid[0]=='ok',paid)
check('separate split payments never duplicate fixed discount',one('select sum(total)=24 and sum(discount_total)=6 from orders where id=any(%s::uuid[])',([str(fixed_parent),str(fixed_child)],)))
recipe_menu=one("select id from menu_items where restaurant_id=%s and name='ผัดกะเพราหมูสับ'",(rid,))
ingredient=one("select id from ingredients where restaurant_id=%s and name='หมูสับ'",(rid,))
initial=one('select quantity_on_hand from ingredients where id=%s',(ingredient,))
cooked=place(json.dumps([{'menu_item_id':str(recipe_menu),'quantity':1},{'menu_item_id':str(recipe_menu),'quantity':2}]))[1][0][0]
for status in ['preparing','ready','served']:
    assert q(uid,'update orders set status=%s where id=%s',(status,cooked))[0]=='ok'
deducted=one('select quantity_on_hand from ingredients where id=%s',(ingredient,))
cooked_line=one('select id from order_items where order_id=%s and quantity=1',(cooked,))
split=q(uid,'select staff_split_order(%s,%s::uuid[])',(cooked,[str(cooked_line)]))
check('served split safely transfers stock ownership',split[0]=='ok' and one('select quantity_on_hand from ingredients where id=%s',(ingredient,))==deducted,split)
if split[0]=='ok':
    cooked_new=split[1][0][0]
    result=q(uid,"update orders set status='cancelled',cancel_reason='split cancellation' where id=%s",(cooked_new,))
    check('cancelling one split returns only its own stock',result[0]=='ok' and one('select quantity_on_hand from ingredients where id=%s',(ingredient,))==deducted+(initial-deducted)/3,result)
    result=q(uid,"update orders set status='cancelled',cancel_reason='remaining cancellation' where id=%s",(cooked,))
    check('cancelling both restores original inventory',result[0]=='ok' and one('select quantity_on_hand from ingredients where id=%s',(ingredient,))==initial,result)
t.finish()
