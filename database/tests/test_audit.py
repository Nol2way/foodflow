"""Audit regression checks against disposable local PostgreSQL; no remote configuration."""
import json
import uuid
import threading
from concurrent.futures import ThreadPoolExecutor
import psycopg
from decimal import Decimal
from harness import start, Runner

srv, uri, admin = start()
t = Runner(uri)
q, one, check = t.q, t.one, t.check
rid = one('select id from restaurants order by created_at limit 1')
users = {r: uuid.uuid4() for r in ['owner','staff','kitchen']}
for role, uid in users.items():
    one('insert into app_users(id,email) values(%s,%s) returning id',(uid,f'{uid}@audit.invalid'))
    assert q('su','insert into staff_members values(%s,%s,%s)',(uid,rid,role))[0]=='ok'
menu = one("insert into menu_items(restaurant_id,name,price) values(%s,'Audit cents',0.01) returning id",(rid,))
def place():
    r=q(users['staff'],"select staff_place_order(%s,%s::jsonb,null,'takeaway','audit')",(rid,json.dumps([{'menu_item_id':str(menu),'quantity':1}])))
    assert r[0]=='ok',r
    oid=r[1][0][0]
    for status in ['preparing','ready','served']:
        assert q(users['kitchen'],'update orders set status=%s where id=%s',(status,oid))[0]=='ok'
    return oid
oid=place()
for role in users:
    check(f'{role}: cannot bypass payment',q(users[role],"update orders set status='paid' where id=%s",(oid,))[0]=='err')
check('cannot forge private payment capability',q(users['staff'],'insert into private.payment_authorizations values(txid_current(),%s)',(oid,))[0]=='err')
check('stale quote rolls back',q(users['staff'],"select counter_pay_bill(%s,%s::uuid[],p_expected_total=>99)",(rid,[str(oid)]))[0]=='err' and one('select status from orders where id=%s',(oid,))=='served')
check('missing quote rejected',q(users['staff'],"select counter_pay_bill(%s,%s::uuid[],p_expected_total=>null)",(rid,[str(oid)]))[0]=='err')
q('su','insert into shop_settings(restaurant_id) values(%s) on conflict do nothing',(rid,))
q('su','update shop_settings set loyalty_enabled=true,loyalty_point_value=0.01,loyalty_min_redeem=1,loyalty_baht_per_point=100 where restaurant_id=%s',(rid,))
mid=one("insert into members(restaurant_id,phone,points) values(%s,'0900000001',9) returning id",(rid,))
ids=[str(place()) for _ in range(10)]
paid=q(users['staff'],"select counter_pay_bill(%s,%s::uuid[],null,'cash',%s,9,p_expected_total=>0.01)",(rid,ids,mid))
check('ten penny orders settle nine penny redemption',paid[0]=='ok',paid)
check('allocation preserves cents and nonnegative rows',one('select min(total)>=0 and sum(total)=0.01 and sum(points_discount)=0.09 from orders where id=any(%s::uuid[])',(ids,)))
member=one("insert into members(restaurant_id,phone,points) values(%s,'0900000002',0) returning id",(rid,))
rev=place()
q('su','update orders set is_demo=true,member_id=%s,points_earned=5 where id=%s',(member,rev))
q(users['staff'],"select counter_pay_bill(%s,%s::uuid[],p_expected_total=>0.01)",(rid,[str(rev)]))
result=q(users['owner'],"update orders set status='cancelled',cancel_reason='audit' where id=%s",(rev,))
check('reversal records actual capped balance delta',result[0]=='ok' and one("select sum(change) from point_ledger where member_id=%s and reason='reverse'",(member,))==0)
for field,value in [('is_active',False),('must_change_password',True)]:
    q('su',f'update app_users set {field}=%s where id=%s',(value,users['staff']))
    check(f'{field} denies direct RLS membership',q(users['staff'],"select has_role(%s,array['staff'])",(rid,))[1]==[(False,)])
    q('su',f'update app_users set {field}=%s where id=%s',(not value,users['staff']))
check('old epoch denies direct RLS',q(users['staff'],"select set_config('request.jwt.claims','{\"credential_version\":-1}',true),has_role(%s,array['staff'])",(rid,))[1][0][1] is False)
check('no epoch denies direct RLS',q(users['staff'],"select set_config('request.jwt.claims','{}',true),has_role(%s,array['staff'])",(rid,))[1][0][1] is False)
other=one("insert into restaurants(name) values('other audit') returning id")
check('tenant helper cannot inspect another shop',q(users['owner'],'select staff_is_senior(%s,%s)',(other,users['owner']))[1]==[(False,)])
rows=json.dumps([{'line':1,'ref':'audit','at':'2026-01-01 12:00','item':'Audit cents','qty':1,'price':''}])
preview=q(users['owner'],'select import_sales_history(%s,%s::jsonb,true)',(rid,rows))[1][0][0]
q('su','update menu_items set price=2 where id=%s',(menu,))
check('import rejects changed preview price',q(users['owner'],'select import_sales_history(%s,%s::jsonb,false,false,%s)',(rid,rows,preview['preview_token']))[0]=='err')
preview=q(users['owner'],'select import_sales_history(%s,%s::jsonb,true)',(rid,rows))[1][0][0]
first=q(users['owner'],'select import_sales_history(%s,%s::jsonb,false,false,%s)',(rid,rows,preview['preview_token']))
second=q(users['owner'],'select import_sales_history(%s,%s::jsonb,false,false,%s)',(rid,rows,preview['preview_token']))
check('identical import retry returns original batch',first[0]==second[0]=='ok' and first[1][0][0]['batch_id']==second[1][0][0]['batch_id'] and second[1][0][0]['duplicate'])
check('import inserted once',one('select count(*) from orders where import_batch=%s',(first[1][0][0]['batch_id'],))==1)
check('atomic promotion rejects cross-shop items without partial write',q(users['owner'],'select save_promotion(%s,null,%s::jsonb,%s::uuid[])',(other,json.dumps({'name':'bad','discount_type':'fixed','value':1}),[str(menu)]))[0]=='err')
q('su',"""do $test$ declare entry uuid; begin
 for i in 1..501 loop
 entry:=acct_new_entry('%s','opening',null,current_date,'Export boundary fixture');
 perform acct_line(entry,'cash',1); perform acct_line(entry,'equity',-1);
 end loop; end; $test$;""" % rid)
export=q(users['owner'],'select acct_journal_export(%s,current_date-365,current_date)',(rid,))[1][0][0]
check('journal export exceeds 1000 rows without omission',len(export)>1000 and len(export)==one('select count(*) from journal_lines jl join journal_entries e on e.id=jl.entry_id where e.restaurant_id=%s and e.entry_date between current_date-365 and current_date',(rid,)))
check('export has unique line IDs and complete balanced entries',len({x['line_id'] for x in export})==len(export) and sum(Decimal(str(x['debit']))-Decimal(str(x['credit'])) for x in export)==0)
expensive=one("insert into menu_items(restaurant_id,name,price) values(%s,'Audit expensive',60) returning id",(rid,))
cheap=one("insert into menu_items(restaurant_id,name,price) values(%s,'Audit cheap',30) returning id",(rid,))
bill_promo=one("insert into promotions(restaurant_id,name,discount_type,value,min_subtotal) values(%s,'Minimum50','amount',5,50) returning id",(rid,))
item_promo=one("insert into promotions(restaurant_id,name,discount_type,value) values(%s,'Cheap discount','amount',3) returning id",(rid,))
q('su','insert into promotion_items values(%s,%s)',(item_promo,cheap))
item_payload=json.dumps([{'menu_item_id':str(expensive),'quantity':1},{'menu_item_id':str(cheap),'quantity':1}])
cancel_bill=q(users['owner'],"select staff_place_order(%s,%s::jsonb,null,'takeaway',null,null,%s::uuid[])",(rid,item_payload,[str(bill_promo),str(item_promo)]))[1][0][0]
cancel_item=one('select id from order_items where order_id=%s and menu_item_id=%s',(cancel_bill,expensive))
cancelled=q(users['owner'],'select cancel_order_items(%s,%s::jsonb)',(cancel_bill,json.dumps([{'id':str(cancel_item),'quantity':1}])))
check('partial cancellation retains still-valid promotion',cancelled[0]=='ok' and one('select total from orders where id=%s',(cancel_bill,))==27 and one('select count(*) from order_promotions where order_id=%s and promotion_id=%s',(cancel_bill,item_promo))==1,cancelled)
q('su','update promotions set max_uses=1 where id=%s',(item_promo,))
check('token-authorized display still honors exhausted promo cap',one('select promotion_is_live(p) from promotions p where id=%s',(item_promo,)) is False)
q('su','update promotions set max_uses=null where id=%s',(item_promo,))
q('su',"create function audit_test_fail() returns trigger language plpgsql as $$ begin raise exception 'synthetic_database_failure'; end; $$")
q('su','create trigger audit_test_fail before insert on order_promotions for each row execute function audit_test_fail()')
# Editing to a valid promotion but injecting an unrelated storage failure must roll back the item edit.
edit=q(users['owner'],'select staff_edit_order(%s,%s::jsonb)',(cancel_bill,json.dumps([{'menu_item_id':str(cheap),'quantity':2}])))
check('unexpected promotion storage failure aborts entire edit',edit[0]=='err' and 'synthetic_database_failure' in edit[1] and one('select sum(quantity) from order_items where order_id=%s',(cancel_bill,))==1)
q('su','drop trigger audit_test_fail on order_promotions')
q('su','drop function audit_test_fail()')
q('su','insert into shop_settings(restaurant_id) values(%s) on conflict do nothing',(rid,))
assert q('su',"update shop_settings set line_to='U00000000000000000000000000000000' where restaurant_id=%s",(rid,))[0]=='ok'
target=q('su',"select local_date,local_hour from daily_report_targets('2026-01-01T17:30:00Z') where restaurant_id=%s",(rid,))[1][0]
check('scheduler uses supplied instant in shop timezone',str(target[0])=='2026-01-02' and target[1]==0,target)
claim=one("select report_dispatch_claim(%s,'2026-01-01')",(rid,))
check('duplicate scheduled invocation skips claimed delivery',claim is not None and one("select report_dispatch_claim(%s,'2026-01-01')",(rid,)) is None)
q('su',"select report_dispatch_finish(%s,'2026-01-01',false)",(rid,))
check('failed delivery retries with same provider key',one("select report_dispatch_claim(%s,'2026-01-01')",(rid,))==claim)
q('su',"select report_dispatch_finish(%s,'2026-01-01',true)",(rid,))
check('successful delivery never resent',one("select report_dispatch_claim(%s,'2026-01-01')",(rid,)) is None)
q('su',"select app_set_password(%s,'original-password',true)",(users['staff'],))
epoch=one('select credential_version from app_users where id=%s',(users['staff'],))
q('su',"select app_set_password(%s,'reset-password',true)",(users['staff'],))
check('password change rejects credential superseded by reset',q('su',"select app_change_password(%s,'original-password','changed-password',%s)",(users['staff'],epoch))[0]=='err')
epoch=one('select credential_version from app_users where id=%s',(users['staff'],))
changed=q('su',"select app_change_password(%s,'reset-password','changed-password',%s)",(users['staff'],epoch))
check('atomic password change returns new epoch and clears first-login',changed[0]=='ok' and changed[1][0][0]==epoch+1 and not one('select must_change_password from app_users where id=%s',(users['staff'],)),changed)
check('password write rejects overlong UTF8 bcrypt secret',q('su','select app_set_password(%s,%s,false)',(users['staff'],'ก'*25))[0]=='err')
# Use separate committed connections so this exercises actual interleaving, not savepoints.
concurrent_rid=admin.execute("insert into restaurants(name) values('concurrent owners') returning id").fetchone()[0]
owners=[uuid.uuid4(),uuid.uuid4()]
for owner in owners:
    admin.execute('insert into app_users(id,email) values(%s,%s)',(owner,f'{owner}@race.invalid'))
    admin.execute("insert into staff_members values(%s,%s,'owner')",(owner,concurrent_rid))
barrier=threading.Barrier(2)
def remove_owner(owner):
    with psycopg.connect(uri) as conn:
        conn.execute("set local lock_timeout='5s'")
        conn.execute("select set_config('request.jwt.claim.sub',%s,true)",(str(owner),))
        conn.execute("select set_config('request.jwt.claims','{\"credential_version\":0}',true)")
        conn.execute('set local role authenticated')
        barrier.wait(timeout=5)
        try:
            conn.execute("delete from staff_members where user_id=%s and restaurant_id=%s and role='owner'",(owner,concurrent_rid))
            conn.commit()
            return 'ok'
        except psycopg.Error as exc:
            conn.rollback()
            return str(exc).splitlines()[0]
with ThreadPoolExecutor(max_workers=2) as pool:
    outcomes=list(pool.map(remove_owner,owners))
check('concurrent owner removal commits at most one',outcomes.count('ok')==1 and admin.execute("select count(*) from staff_members where restaurant_id=%s and role='owner'",(concurrent_rid,)).fetchone()[0]==1,outcomes)
# A single store enforces the same bucket across independent connections.
def throttle(_):
    with psycopg.connect(uri) as conn:
        conn.execute('set local role service_role')
        return conn.execute("select app_auth_allow('concurrency-regression',3,60)").fetchone()[0]
with ThreadPoolExecutor(max_workers=6) as pool:
    allowances=list(pool.map(throttle,range(6)))
check('shared limiter admits exactly limit across connections',sum(allowances)==3,allowances)
t.finish()
