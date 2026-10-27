"""ทดสอบ migration + RLS ของ Plato บน Postgres จริง (จำลอง auth ของ Supabase ด้วย stub)

วิธีรัน:
  pip install pixeltable-pgserver "psycopg[binary]"
  python database/tests/test_rls.py

หมายเหตุ: รันบน Postgres ชั่วคราวในเครื่อง ไม่ใช่ Supabase จริง และไม่ทดสอบหน้าเว็บ
"""
import datetime
import json
import subprocess
import pathlib
import sys
import tempfile
import uuid

try:
    import pgserver
except ImportError:
    import pixeltable_pgserver as pgserver
import psycopg

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRATCH = pathlib.Path(tempfile.mkdtemp(prefix='foodflow-pg-'))

srv = pgserver.get_server(SCRATCH / 'pgdata', cleanup_mode='delete')
uri = srv.get_uri()
admin = psycopg.connect(uri, autocommit=True)
print(admin.execute('select version()').fetchone()[0])

STUB = """
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create publication supabase_realtime;
-- pgcrypto ไม่มีในบิลด์ทดสอบ: จำลอง crypt/gen_salt ใน schema extensions (บน Supabase ใช้ bcrypt จริง)
create schema extensions;
create function extensions.gen_salt(text, int default 10) returns text language sql volatile as
  $$ select '$stub$' || substr(md5(random()::text), 1, 8) $$;
create function extensions.crypt(text, text) returns text language sql immutable as
  $$ select left($2, 14) || md5(left($2, 14) || $1) $$;
grant usage on schema public, auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated;
"""
admin.execute(STUB)

FILES = [
    'migrations/0001_schema.sql',
    'migrations/0002_customer_ordering.sql',
    'migrations/0003_roles.sql',
    'migrations/0004_stock_costs_analytics.sql',
    'migrations/0005_import_and_hardening.sql',
    'migrations/0006_accounting_summary.sql',
    'migrations/0007_staff_ordering.sql',
    'migrations/0008_order_status_rules.sql',
    'migrations/0009_manager_promotions.sql',
    'migrations/0010_kitchen_item_done.sql',
    'migrations/0011_item_served.sql',
    'migrations/0012_promotion_rules.sql',
    'migrations/0013_display_magazine.sql',
    'migrations/0014_display_media.sql',
    'migrations/0015_display_customize.sql',
    'migrations/0016_manager_accounting.sql',
    'migrations/0017_payment_loyalty.sql',
    'migrations/0018_reports_insights.sql',
    'migrations/0019_stock_history.sql',
    'migrations/0020_multi_roles.sql',
    'migrations/0021_app_users.sql',
    'migrations/0022_stock_counts.sql',
    'migrations/0023_seafood_inventory.sql',
    'migrations/0024_units.sql',
    'migrations/0025_receiving_check.sql',
    'migrations/0026_accounting.sql',
    'migrations/0027_stock_ledger.sql',
    'migrations/0028_stock_recipes.sql',
    'migrations/0029_stock_operations.sql',
    'migrations/0030_stock_rls.sql',
    'seed/seed.sql',
    'seed/seed_demo.sql',
]
for f in FILES:
    try:
        text = (ROOT / f).read_text(encoding='utf-8')
        # pgcrypto ไม่มีในบิลด์ทดสอบ (gen_random_uuid เป็นฟังก์ชันหลักตั้งแต่ PG13 อยู่แล้ว)
        text = text.replace('create extension if not exists "pgcrypto";', '')
        text = text.replace('create extension if not exists pgcrypto with schema extensions;', '')
        admin.execute(text)
        print('LOADED', f)
    except psycopg.Error as e:
        print('LOAD FAILED', f, '->', e)
        sys.exit(2)

tx = psycopg.connect(uri)
cur = tx.cursor()
results = []


def check(name, ok, detail=''):
    results.append(bool(ok))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail and not ok else ''))


def q(uid, sql, args=None):
    """รันในฐานะ uid ('su' = superuser, None = anon, UUID = ผู้ใช้ที่ล็อกอิน)"""
    cur.execute('savepoint sp')
    try:
        if uid == 'su':
            cur.execute('reset role')
            cur.execute("select set_config('request.jwt.claim.sub','',true)")
        elif uid == 'service':
            cur.execute('set local role service_role')
        elif uid is None:
            cur.execute('set local role anon')
            cur.execute("select set_config('request.jwt.claim.sub','',true)")
        else:
            cur.execute('set local role authenticated')
            cur.execute("select set_config('request.jwt.claim.sub',%s,true)", (str(uid),))
        cur.execute(sql, args)
        rows = cur.fetchall() if cur.description else None
        rc = cur.rowcount
        cur.execute('reset role')
        cur.execute('release savepoint sp')
        return ('ok', rows, rc)
    except psycopg.Error as e:
        cur.execute('rollback to savepoint sp')
        cur.execute('reset role')
        return ('err', str(e).splitlines()[0], 0)


def one(sql, args=None):
    r = q('su', sql, args)
    assert r[0] == 'ok', r
    return r[1][0][0]


# ---------- เตรียมข้อมูล ----------
r1 = one("select id from restaurants order by created_at limit 1")
tables = [row[0] for row in q('su', "select id from dining_tables where restaurant_id=%s order by label", (r1,))[1]]
menu = {n: i for i, n in q('su', "select id, name from menu_items where restaurant_id=%s", (r1,))[1]}
KAPRAO = menu['ผัดกะเพราหมูสับ']

U = {k: uuid.uuid4() for k in ['owner', 'staff', 'kitchen', 'acc', 'stock', 'other', 'newbie', 'nobody', 'mgr', 'cook2']}
for u in U.values():
    q('su', 'insert into app_users(id, email) values (%s, %s)', (u, f'{u}@test.local'))
r2 = one("insert into restaurants(name) values ('ร้านอื่น') returning id")
ing2 = one("insert into ingredients(restaurant_id,name,unit,quantity_on_hand) values (%s,'น้ำตาล','g',100) returning id", (r2,))
for k, rid, role in [('owner', r1, 'owner'), ('staff', r1, 'staff'), ('kitchen', r1, 'kitchen'),
                     ('acc', r1, 'accountant'), ('stock', r1, 'stock'), ('other', r2, 'owner'),
                     ('mgr', r1, 'manager')]:
    q('su', 'insert into staff_members(user_id, restaurant_id, role) values (%s,%s,%s)', (U[k], rid, role))


def qty(name):
    return float(one("select quantity_on_hand from ingredients where restaurant_id=%s and name=%s", (r1, name)))


def items(n=1, item=KAPRAO, note=None):
    return json.dumps([{"menu_item_id": str(item), "quantity": n, "note": note}])


def order_as(uid, js, table='T0', order_type='dine_in', label=None, note=None, rid=None):
    t = tables[0] if table == 'T0' else table
    return q(uid, "select staff_place_order(%s, %s::jsonb, %s, %s, %s, %s)",
             (rid or r1, js, t, order_type, label, note))


def place(n=1, item=KAPRAO):
    return order_as(U['staff'], items(n, item))


# ---------- 1) พนักงานรับออเดอร์ (ลูกค้าไม่สั่งเอง) ----------
st = order_as(U['staff'], items(2, note='ไม่เผ็ด'), note='โต๊ะรีบ')
check('staff: รับออเดอร์ทานที่ร้านได้', st[0] == 'ok', st)
oid = st[1][0][0]
check('staff: ราคารวมใช้ราคาจากฐานข้อมูล (2 x 60 = 120)', float(one('select total from orders where id=%s', (oid,))) == 120)
check('staff: บันทึกผู้รับออเดอร์ หมายเหตุ และประเภท',
      one("select created_by = %s and note = 'โต๊ะรีบ' and order_type = 'dine_in' from orders where id=%s", (U['staff'], oid)))
check('staff: หมายเหตุรายเมนูถูกบันทึก', one("select note from order_items where order_id=%s", (oid,)) == 'ไม่เผ็ด')
check('kitchen: เห็นออเดอร์ใหม่ทันที (สถานะ received)',
      q(U['kitchen'], "select status from orders where id=%s", (oid,))[1] == [('received',)])
check('kitchen: เห็นรายการอาหารในออเดอร์', q(U['kitchen'], "select count(*) from order_items where order_id=%s", (oid,))[1][0][0] == 1)
check('owner: รับออเดอร์ได้', order_as(U['owner'], items(1))[0] == 'ok')
tk = order_as(U['staff'], items(1), table=None, order_type='takeaway', label='คุณเอ 081')
check('staff: สั่งกลับบ้านไม่ต้องมีโต๊ะ พร้อมชื่อลูกค้า',
      tk[0] == 'ok' and one("select table_id is null and customer_label='คุณเอ 081' from orders where id=%s", (tk[1][0][0],)), tk)
check('staff: กลับบ้านแต่ส่งโต๊ะมา ระบบไม่ผูกโต๊ะ',
      one("select table_id is null from orders where id=%s",
          (order_as(U['staff'], items(1), order_type='takeaway')[1][0][0],)))
for who in ['kitchen', 'acc', 'stock', 'nobody']:
    check(f'{who}: รับออเดอร์ไม่ได้', order_as(U[who], items(1))[0] == 'err')
check('anon: รับออเดอร์ไม่ได้', order_as(None, items(1))[0] == 'err')
check('ร้านอื่น: รับออเดอร์ข้ามร้านไม่ได้', order_as(U['other'], items(1))[0] == 'err')
check('ทานที่ร้านต้องมีโต๊ะ', order_as(U['staff'], items(1), table=None)[0] == 'err')
check('โต๊ะของร้านอื่นใช้ไม่ได้',
      order_as(U['other'], items(1), rid=r2)[0] == 'err')
check('ประเภทออเดอร์ผิดถูกปฏิเสธ', order_as(U['staff'], items(1), order_type='delivery')[0] == 'err')
check('จำนวน 0 ถูกปฏิเสธ', place(0)[0] == 'err')
check('จำนวนเกิน 50 ถูกปฏิเสธ', place(51)[0] == 'err')
check('รายการว่างถูกปฏิเสธ', order_as(U['staff'], '[]')[0] == 'err')
q('su', "update menu_items set is_available=false where id=%s", (KAPRAO,))
st2 = place(1)
check('เมนูที่หมดสั่งไม่ได้', st2[0] == 'err' and 'item_unavailable' in st2[1], st2)
q('su', "update menu_items set is_available=true where id=%s", (KAPRAO,))
n_before = one('select count(*) from orders')
check('ออเดอร์ที่ผิดกลางทาง ไม่เหลือออเดอร์ค้าง (ทั้งหมดหรือไม่มีเลย)',
      order_as(U['staff'], json.dumps([{"menu_item_id": str(KAPRAO), "quantity": 1}, {"menu_item_id": str(uuid.uuid4()), "quantity": 1}]))[0] == 'err'
      and one('select count(*) from orders') == n_before)
check('staff: insert ออเดอร์ตรงไม่ได้ (ต้องผ่านฟังก์ชัน)',
      q(U['staff'], "insert into orders(restaurant_id, total) values (%s, 1)", (r1,))[0] == 'err')
check('staff: แก้ยอดเงินออเดอร์ตรงไม่ได้',
      q(U['staff'], "update orders set total=1 where id=%s", (oid,))[0] == 'err')
check('owner: แก้ยอดเงินออเดอร์ตรงไม่ได้',
      q(U['owner'], "update orders set total=1 where id=%s", (oid,))[0] == 'err')
check('staff: แก้ราคาในรายการอาหารตรงไม่ได้',
      q(U['staff'], "update order_items set unit_price=1 where order_id=%s", (oid,))[0] == 'err')
check('staff: เพิ่มรายการอาหารตรงไม่ได้',
      q(U['staff'], "insert into order_items(order_id, menu_item_id, quantity, unit_price) values (%s,%s,1,0)", (oid, KAPRAO))[0] == 'err')
check('anon: อ่านเมนูไม่ได้แล้ว', q(None, 'select count(*) from menu_items')[0] == 'err' or q(None, 'select count(*) from menu_items')[1][0][0] == 0)
check('anon: อ่านออเดอร์ไม่ได้', q(None, 'select count(*) from orders')[0] == 'err')
check('ฟังก์ชันสั่งอาหารของลูกค้าถูกลบแล้ว',
      one("select count(*) from pg_proc where proname in ('place_order','get_table_info','get_order_status')") == 0)
check('ครัว/สต็อก อ่านเมนูได้',
      q(U['kitchen'], 'select count(*) from menu_items')[1][0][0] > 0 and q(U['stock'], 'select count(*) from menu_items')[1][0][0] > 0)
check('ร้านอื่นไม่เห็นเมนูร้านแรก', q(U['other'], 'select count(*) from menu_items where restaurant_id=%s', (r1,))[1][0][0] == 0)

# ---------- 2) ครัว + ตัดสต็อกอัตโนมัติ ----------
before = {n: qty(n) for n in ['หมูสับ', 'ข้าวสวย', 'ใบกะเพรา', 'ไข่ไก่']}
r = q(U['kitchen'], "update orders set status='preparing' where id=%s", (oid,))
check('kitchen: เริ่มทำออเดอร์ได้', r[0] == 'ok' and r[2] == 1, r)
check('stock: ตัดตามสูตรถูกต้อง (หมูสับ -200, ข้าว -400, ใบกะเพรา -30, ไข่ -2)',
      (before['หมูสับ'] - qty('หมูสับ'), before['ข้าวสวย'] - qty('ข้าวสวย'),
       before['ใบกะเพรา'] - qty('ใบกะเพรา'), before['ไข่ไก่'] - qty('ไข่ไก่')) == (200, 400, 30, 2))
item1 = one('select id from order_items where order_id=%s limit 1', (oid,))
r = q(U['kitchen'], 'select kitchen_set_item_done(%s, true)', (item1,))
check('kitchen: ติ๊กเสร็จรายเมนูได้ (0010)', r[0] == 'ok' and one('select done_at is not null from order_items where id=%s', (item1,)), r)
r = q(U['kitchen'], 'select kitchen_set_item_done(%s, false)', (item1,))
check('kitchen: ยกเลิกติ๊กเสร็จรายเมนูได้', r[0] == 'ok' and one('select done_at is null from order_items where id=%s', (item1,)), r)
check('kitchen: แก้ done_at ตรงไม่ได้', q(U['kitchen'], 'update order_items set done_at=now() where id=%s', (item1,))[0] == 'err')
check('accountant: ติ๊กเสร็จรายเมนูไม่ได้', q(U['acc'], 'select kitchen_set_item_done(%s, true)', (item1,))[0] == 'err')
check('ร้านอื่น: ติ๊กเสร็จรายเมนูไม่ได้', q(U['other'], 'select kitchen_set_item_done(%s, true)', (item1,))[0] == 'err')
check('orders: started_at ถูกบันทึกอัตโนมัติ', one('select started_at is not null from orders where id=%s', (oid,)))
check('stock: stock_deducted_at ถูกตั้งค่า', one('select stock_deducted_at is not null from orders where id=%s', (oid,)))
check('ประวัติสต็อก: ตัดขายจำออเดอร์ที่ตัดไว้', one("select count(*) from stock_movements where reason='sale' and order_id=%s", (oid,)) > 0)
sales_before = one("select count(*) from stock_movements where reason='sale'")
q(U['kitchen'], "update orders set status='ready' where id=%s", (oid,))
check('kitchen: ติ๊กเสร็จรายเมนูได้เฉพาะตอนกำลังทำ', q(U['kitchen'], 'select kitchen_set_item_done(%s, true)', (item1,))[0] == 'err')
check('stock: เปลี่ยนสถานะต่อไม่ตัดซ้ำ', one("select count(*) from stock_movements where reason='sale'") == sales_before
      and qty('หมูสับ') == before['หมูสับ'] - 200)
r = q(U['staff'], 'select set_item_served(%s, true)', (item1,))
check('staff: ติ๊กเสิร์ฟรายเมนูได้ (0011)', r[0] == 'ok' and one('select served_at is not null from order_items where id=%s', (item1,)), r)
r = q(U['kitchen'], 'select set_item_served(%s, false)', (item1,))
check('kitchen: ยกเลิกติ๊กเสิร์ฟรายเมนูได้', r[0] == 'ok' and one('select served_at is null from order_items where id=%s', (item1,)), r)
check('staff: แก้ served_at ตรงไม่ได้', q(U['staff'], 'update order_items set served_at=now() where id=%s', (item1,))[0] == 'err')
check('accountant: ติ๊กเสิร์ฟรายเมนูไม่ได้', q(U['acc'], 'select set_item_served(%s, true)', (item1,))[0] == 'err')
check('ร้านอื่น: ติ๊กเสิร์ฟรายเมนูไม่ได้', q(U['other'], 'select set_item_served(%s, true)', (item1,))[0] == 'err')
check('kitchen: ตั้ง paid ไม่ได้', q(U['kitchen'], "update orders set status='paid' where id=%s", (oid,))[0] == 'err')
check('kitchen: ตั้ง cancelled ไม่ได้', q(U['kitchen'], "update orders set status='cancelled' where id=%s", (oid,))[0] == 'err')
check('staff: served แล้ว paid ได้',
      q(U['staff'], "update orders set status='served' where id=%s", (oid,))[2] == 1
      and q(U['staff'], "update orders set status='paid' where id=%s", (oid,))[2] == 1)
check('staff: ติ๊กเสิร์ฟรายเมนูได้เฉพาะตอนพร้อมเสิร์ฟ', q(U['staff'], 'select set_item_served(%s, true)', (item1,))[0] == 'err')
check('orders: paid_at ถูกบันทึกอัตโนมัติ', one('select paid_at is not null from orders where id=%s', (oid,)))
check('accountant: อ่านออเดอร์ได้', q(U['acc'], 'select count(*) from orders')[1][0][0] >= 1)
check('accountant: แก้ออเดอร์ไม่ได้ (0 แถว)',
      q(U['acc'], "update orders set status='cancelled' where id=%s", (oid,))[2] == 0)
check('stock role: อ่านออเดอร์ไม่ได้', q(U['stock'], 'select count(*) from orders')[1][0][0] == 0)

# ---------- 3) ของไม่พอ: ตัดไม่ได้ (สต็อกไม่ติดลบ) และปิดเมนูที่เกี่ยวข้องอัตโนมัติ (0027/0028) ----------
basil = one("select id from ingredients where restaurant_id=%s and name='ใบกะเพรา'", (r1,))
oid2 = place(1)[1][0][0]   # รับออเดอร์ไว้ก่อนของจะหมด
q(U['stock'], "select submit_stock_count(%s, %s::jsonb)", (r1, json.dumps([{'ingredient_id': str(basil), 'counted_qty': 10}])))
check('stock: นับแล้วเหลือไม่พอ 1 จาน (ต้องใช้ดิบ 15g) -> ปิดเมนูอัตโนมัติ',
      one('select not is_available and stock_disabled from menu_items where id=%s', (KAPRAO,)))
r = q(U['kitchen'], "update orders set status='preparing' where id=%s", (oid2,))
check('stock: ของไม่พอ เริ่มทำไม่ได้ ยอดไม่ติดลบ', r[0] == 'err' and 'insufficient_stock' in r[1] and qty('ใบกะเพรา') == 10, r)
check('stock: เมนูที่ระบบปิด รับออเดอร์ใหม่ไม่ได้', place(1)[0] == 'err')
q(U['stock'], "select submit_stock_receipt(%s, %s::jsonb, null, null, null, null, false)", (r1, json.dumps([{'ingredient_id': str(basil), 'quantity': 500, 'unit_cost': 0.15}])))
check('stock: ของกลับมาพอ -> เปิดเมนูให้อัตโนมัติ', one('select is_available and not stock_disabled from menu_items where id=%s', (KAPRAO,)))
r = q(U['kitchen'], "update orders set status='preparing' where id=%s", (oid2,))
check('stock: รับของแล้วเริ่มทำได้ ตัดดิบตาม trim yield (510 - 15)', r[0] == 'ok' and qty('ใบกะเพรา') == 495, r)

# ---------- 3.5) ลำดับสถานะออเดอร์ (0008) ----------
def upd(uid, oid_, status, reason=None):
    if reason is None:
        return q(uid, "update orders set status=%s where id=%s", (status, oid_))
    return q(uid, "update orders set status=%s, cancel_reason=%s where id=%s", (status, reason, oid_))

def walk(oid_, *steps):
    for who, st_ in steps:
        r_ = upd(U[who], oid_, st_)
        assert r_[0] == 'ok' and r_[2] == 1, (who, st_, r_)

a1 = place(1)[1][0][0]
check('สถานะ: ข้ามขั้น received → paid ไม่ได้', upd(U['staff'], a1, 'paid')[0] == 'err')
check('สถานะ: ข้ามขั้น received → served ไม่ได้ (ครัว)', upd(U['kitchen'], a1, 'served')[0] == 'err')
walk(a1, ('kitchen', 'preparing'), ('kitchen', 'ready'), ('kitchen', 'served'))
check('สถานะ: ครัวย้อน served → received ไม่ได้', upd(U['kitchen'], a1, 'received')[0] == 'err')
walk(a1, ('staff', 'paid'))
r = upd(U['staff'], a1, 'cancelled', 'ลูกค้าไม่จ่าย')
check('สถานะ: หน้าร้านยกเลิกบิลที่ชำระแล้วไม่ได้ (รายรับไม่หาย)', r[0] == 'err' and one('select status from orders where id=%s', (a1,)) == 'paid', r)
check('สถานะ: หน้าร้านย้อนบิลชำระแล้วกลับเป็น served ไม่ได้', upd(U['staff'], a1, 'served')[0] == 'err')
check('สถานะ: เจ้าของยกเลิกบิลชำระแล้วโดยไม่ใส่เหตุผลไม่ได้', upd(U['owner'], a1, 'cancelled')[0] == 'err')
check('สถานะ: เจ้าของยกเลิกบิลชำระแล้วพร้อมเหตุผลได้', upd(U['owner'], a1, 'cancelled', 'คิดเงินผิดโต๊ะ')[2] == 1)
check('สถานะ: บันทึกผู้ยกเลิก เวลา และสถานะก่อนยกเลิก',
      one("select cancelled_by = %s and cancelled_at is not null and cancelled_from = 'paid' and cancel_reason = 'คิดเงินผิดโต๊ะ' from orders where id=%s", (U['owner'], a1)))
check('สถานะ: ยกเลิกแล้วเปลี่ยนต่อไม่ได้', upd(U['owner'], a1, 'paid')[0] == 'err')
a2 = place(1)[1][0][0]
check('สถานะ: หน้าร้านยกเลิกออเดอร์ที่ครัวยังไม่เริ่มได้', upd(U['staff'], a2, 'cancelled')[2] == 1
      and one("select cancelled_by = %s and cancelled_from = 'received' from orders where id=%s", (U['staff'], a2)))
a3 = place(1)[1][0][0]
walk(a3, ('kitchen', 'preparing'))
check('สถานะ: หน้าร้านยกเลิกออเดอร์ที่ครัวเริ่มทำแล้วไม่ได้', upd(U['staff'], a3, 'cancelled')[0] == 'err')
check('สถานะ: เจ้าของยกเลิกออเดอร์ที่ครัวเริ่มทำแล้วได้', upd(U['owner'], a3, 'cancelled')[2] == 1)
a4 = place(1)[1][0][0]
check('สถานะ: แก้เหตุผลยกเลิกโดยไม่ยกเลิกไม่ได้',
      q(U['staff'], "update orders set cancel_reason='x' where id=%s", (a4,))[0] == 'err')
check('สถานะ: แก้คอลัมน์ผู้ยกเลิกตรงๆ ไม่ได้',
      q(U['owner'], "update orders set cancelled_by=%s where id=%s", (U['staff'], a4))[0] == 'err')

# ---------- 4) บัญชี ----------
q('su', "insert into expenses(restaurant_id,category,amount) values (%s,'rent',1000)", (r1,))
check('accountant: อ่านรายจ่ายได้', q(U['acc'], 'select count(*) from expenses')[1][0][0] == 1)
check('accountant: บันทึกรายจ่ายได้',
      q(U['acc'], "insert into expenses(restaurant_id,category,amount) values (%s,'utilities',500)", (r1,))[0] == 'ok')
check('kitchen: อ่านรายจ่ายไม่เห็น', q(U['kitchen'], 'select count(*) from expenses')[1][0][0] == 0)
check('kitchen: บันทึกรายจ่ายไม่ได้',
      q(U['kitchen'], "insert into expenses(restaurant_id,category,amount) values (%s,'other',1)", (r1,))[0] == 'err')
check('stock role: อ่านรายจ่ายไม่เห็น', q(U['stock'], 'select count(*) from expenses')[1][0][0] == 0)
check('staff: บันทึกรายจ่ายไม่ได้',
      q(U['staff'], "insert into expenses(restaurant_id,category,amount) values (%s,'other',1)", (r1,))[0] == 'err')

# ---------- 5) สต็อก ----------
pork = one("select id from ingredients where restaurant_id=%s and name='หมูสับ'", (r1,))
p0 = qty('หมูสับ')
check('stock role: รับเข้าผ่านใบรับของได้และยอดเพิ่ม',
      q(U['stock'], "select submit_stock_receipt(%s, %s::jsonb)", (r1, json.dumps([{'ingredient_id': str(pork), 'quantity': 500, 'unit_cost': 0.18}])))[0] == 'ok'
      and qty('หมูสับ') == p0 + 500)
check('stock role: เขียน ledger ตรงไม่ได้ (ต้องผ่านฟังก์ชัน)',
      q(U['stock'], "insert into stock_movements(restaurant_id,ingredient_id,change,reason) values (%s,%s,-999999,'waste')", (r1, pork))[0] == 'err')
r = q(U['stock'], "update ingredients set quantity_on_hand=1 where id=%s", (pork,))
check('stock role: แก้ยอดคงเหลือตรงๆ ไม่ได้', r[0] == 'err', r)
check('stock role: แก้ชื่อวัตถุดิบได้', q(U['stock'], "update ingredients set name='หมูสับ' where id=%s", (pork,))[2] == 1)
check('stock role: ผูกวัตถุดิบข้ามร้านไม่ได้ (movement)',
      q(U['stock'], "insert into stock_movements(restaurant_id,ingredient_id,change,reason) values (%s,%s,5,'purchase')", (r1, ing2))[0] == 'err')
TEA_RECIPE = one("select id from recipes where menu_item_id=%s", (menu['ชาเย็น'],))
check('stock role: สูตรอาหารข้ามร้านไม่ได้',
      q(U['stock'], "insert into recipe_lines(recipe_id,ingredient_id,qty) values (%s,%s,1)", (TEA_RECIPE, ing2))[0] == 'err')
check('stock role: เพิ่มบรรทัดสูตรในร้านตัวเองได้',
      q(U['stock'], "insert into recipe_lines(recipe_id,ingredient_id,qty) values (%s,%s,5)", (TEA_RECIPE, pork))[0] == 'ok')
q('su', "delete from recipe_lines where recipe_id=%s and ingredient_id=%s", (TEA_RECIPE, pork))
check('ร้านอื่น: อ่านสูตรของร้านนี้ไม่ได้', q(U['other'], 'select count(*) from recipe_lines where recipe_id=%s', (TEA_RECIPE,))[1][0][0] == 0)
check('accountant: อ่านวัตถุดิบได้', q(U['acc'], 'select count(*) from ingredients')[1][0][0] > 0)
check('accountant: เพิ่มประวัติสต็อกไม่ได้',
      q(U['acc'], "insert into stock_movements(restaurant_id,ingredient_id,change,reason) values (%s,%s,1,'purchase')", (r1, pork))[0] == 'err')
check('staff: อ่านวัตถุดิบไม่เห็น', q(U['staff'], 'select count(*) from ingredients')[1][0][0] == 0)
check('kitchen: บันทึกของเสียแยกไม่ได้ (ไม่มีของเสียแยก ไปโผล่เป็นส่วนต่างตอนนับ)',
      q(U['kitchen'], "insert into stock_movements(restaurant_id,ingredient_id,change,reason) values (%s,%s,-5,'waste')", (r1, pork))[0] == 'err')
check('kitchen: บันทึกรับเข้าไม่ได้',
      q(U['kitchen'], "insert into stock_movements(restaurant_id,ingredient_id,change,reason) values (%s,%s,5,'purchase')", (r1, pork))[0] == 'err')
check('ประวัติสต็อกแก้ไขไม่ได้ (update)',
      q(U['stock'], "update stock_movements set change=0", None)[2] == 0)
check('ประวัติสต็อกลบไม่ได้ (delete)', q(U['stock'], "delete from stock_movements", None)[2] == 0)

# ประวัติสต็อก (0019)
q(U['stock'], "select submit_stock_receipt(%s, %s::jsonb)", (r1, json.dumps([{'ingredient_id': str(pork), 'quantity': 7, 'unit_cost': 0.18}])))
last = one("select created_by::text || '|' || balance_after::text from stock_movements where ingredient_id=%s order by created_at desc, balance_after desc limit 1", (pork,))
check('ประวัติสต็อก: บันทึกคนทำจากผู้ล็อกอินและคงเหลือจริง', last == f"{U['stock']}|{qty('หมูสับ'):.3f}", last)
hist = q(U['stock'], "select ingredient_name, type, actor_name from stock_history(%s, now() - interval '1 day', now() + interval '1 day', %s, null, 'receive', 50)", (r1, pork))
check('ประวัติสต็อก: พนักงานสต็อกดึงประวัติได้พร้อมชื่อวัตถุดิบ', hist[0] == 'ok' and len(hist[1]) > 0 and hist[1][0][0] == 'หมูสับ', hist)
check('ประวัติสต็อก: บัญชีดูได้', q(U['acc'], "select count(*) from stock_history(%s, now() - interval '1 day', now() + interval '1 day')", (r1,))[0] == 'ok')
check('ประวัติสต็อก: พนักงานหน้าร้านดูไม่ได้', q(U['staff'], "select count(*) from stock_history(%s, now() - interval '1 day', now() + interval '1 day')", (r1,))[0] == 'err')
check('ประวัติสต็อก: ร้านอื่นดูไม่ได้', q(U['other'], "select count(*) from stock_history(%s, now() - interval '1 day', now() + interval '1 day')", (r1,))[0] == 'err')

# ใบตรวจนับสต็อก (0022)
import json as _json
ings = q('su', "select id, name, quantity_on_hand, cost_per_unit from ingredients where restaurant_id=%s order by name limit 2", (r1,))[1]
(i1, n1, q1, c1), (i2, n2, q2, c2) = ings
lines = _json.dumps([{'ingredient_id': str(i1), 'counted_qty': float(q1) - 3}, {'ingredient_id': str(i2), 'counted_qty': float(q2)}])
sc = q(U['stock'], "select submit_stock_count(%s, %s::jsonb, 'นับสิ้นเดือน')", (r1, lines))
check('ตรวจนับ: พนักงานสต็อกบันทึกใบตรวจนับได้', sc[0] == 'ok', sc)
CID = sc[1][0][0] if sc[0] == 'ok' else None
head = q('su', "select item_count, diff_count, diff_value, counted_by from stock_counts where id=%s", (CID,))[1][0]
check('ตรวจนับ: สรุปจำนวนรายการ / รายการที่ไม่ตรง / มูลค่าส่วนต่าง', head[0] == 2 and head[1] == 1
      and float(head[2]) == round(-3 * float(c1), 2) and head[3] == U['stock'], head)
check('ตรวจนับ: ปรับยอดในระบบเป็นยอดนับจริง', float(qty(n1)) == float(q1) - 3 and float(qty(n2)) == float(q2))
adj = q('su', "select change, reason::text, created_by from stock_movements where count_id=%s", (CID,))[1]
check('ตรวจนับ: ลงประวัติสต็อกเฉพาะรายการที่ไม่ตรง (ปรับยอด, ใครทำ)', len(adj) == 1 and float(adj[0][0]) == -3
      and adj[0][1] == 'adjustment' and adj[0][2] == U['stock'], adj)
ln = q('su', "select system_qty, counted_qty, diff from stock_count_lines where count_id=%s and ingredient_id=%s", (CID, i1))[1][0]
check('ตรวจนับ: เก็บยอดระบบตอนนับ ยอดจริง ส่วนต่าง', float(ln[0]) == float(q1) and float(ln[2]) == -3, ln)
check('ตรวจนับ: บัญชีอ่านใบตรวจนับได้', q(U['acc'], 'select count(*) from stock_counts where id=%s', (CID,))[1][0][0] == 1
      and q(U['acc'], 'select count(*) from stock_count_lines where count_id=%s', (CID,))[1][0][0] == 2)
check('ตรวจนับ: บัญชีบันทึกใบตรวจนับไม่ได้', q(U['acc'], "select submit_stock_count(%s, %s::jsonb)", (r1, lines))[0] == 'err')
check('ตรวจนับ: หน้าร้านอ่านไม่ได้', q(U['staff'], 'select count(*) from stock_counts')[1][0][0] == 0)
check('ตรวจนับ: ร้านอื่นบันทึกให้ร้านนี้ไม่ได้', q(U['other'], "select submit_stock_count(%s, %s::jsonb)", (r1, lines))[0] == 'err')
check('ตรวจนับ: แก้ใบที่บันทึกแล้วไม่ได้', q(U['stock'], 'update stock_counts set diff_value=0 where id=%s', (CID,))[0] == 'err')
check('ตรวจนับ: ลบใบที่บันทึกแล้วไม่ได้', q(U['owner'], 'delete from stock_counts where id=%s', (CID,))[0] == 'err')
check('ตรวจนับ: เพิ่มแถวเองโดยตรงไม่ได้', q(U['stock'], "insert into stock_counts(restaurant_id) values (%s)", (r1,))[0] == 'err')
check('ตรวจนับ: จำนวนติดลบไม่ได้',
      q(U['stock'], "select submit_stock_count(%s, %s::jsonb)", (r1, _json.dumps([{'ingredient_id': str(i1), 'counted_qty': -1}])))[0] == 'err')
check('ตรวจนับ: วัตถุดิบร้านอื่นไม่ได้',
      q(U['stock'], "select submit_stock_count(%s, %s::jsonb)", (r1, _json.dumps([{'ingredient_id': str(ing2), 'counted_qty': 1}])))[0] == 'err')
check('ตรวจนับ: วัตถุดิบซ้ำในใบเดียวไม่ได้',
      q(U['stock'], "select submit_stock_count(%s, %s::jsonb)", (r1, _json.dumps([{'ingredient_id': str(i1), 'counted_qty': 1}] * 2)))[0] == 'err')
check('ตรวจนับ: ใบว่างไม่ได้', q(U['stock'], "select submit_stock_count(%s, '[]'::jsonb)", (r1,))[0] == 'err')
hist = q(U['stock'], "select note, type from stock_history(%s, now() - interval '1 day', now() + interval '1 day', %s, %s, 'count_adjust', 5)", (r1, i1, U['stock']))
check('ตรวจนับ: ประวัติสต็อกแสดงว่ามาจากการนับ (กรองตามผู้ทำรายการได้)', hist[0] == 'ok' and hist[1] and hist[1][0] == ('นับสต็อก', 'count_adjust'), hist)
check('ประวัติสต็อก: กรองผู้ทำรายการคนอื่นไม่เจอรายการนี้',
      q(U['stock'], "select count(*) from stock_history(%s, now() - interval '1 day', now() + interval '1 day', %s, %s, 'count_adjust', 5)", (r1, i1, U['owner']))[1][0][0] == 0)

# ---------- 6) เมนูหมด ----------
check('set_menu_availability: ครัวทำได้', q(U['kitchen'], "select set_menu_availability(%s, false)", (KAPRAO,))[0] == 'ok')
q('su', "update menu_items set is_available=true where id=%s", (KAPRAO,))
check('set_menu_availability: บัญชีทำไม่ได้', q(U['acc'], "select set_menu_availability(%s, false)", (KAPRAO,))[0] == 'err')
check('set_menu_availability: anon ทำไม่ได้', q(None, "select set_menu_availability(%s, false)", (KAPRAO,))[0] == 'err')
check('menu_items: ครัวแก้ราคาตรงๆ ไม่ได้ (0 แถว)', q(U['kitchen'], "update menu_items set price=1", None)[2] == 0)
check('menu_items: เจ้าของแก้ราคาได้', q(U['owner'], "update menu_items set price=price where id=%s", (KAPRAO,))[2] == 1)

# ---------- 7) วิเคราะห์ ----------
rows = q(U['acc'], 'select day_of_week, hour_of_day, order_count from analytics_hourly(%s, 60)', (r1,))
check('analytics: บัญชีเรียกได้และมีข้อมูล', rows[0] == 'ok' and len(rows[1]) > 0, rows[:2])
check('analytics: เจ้าของเรียกได้', q(U['owner'], 'select count(*) from analytics_hourly(%s, 28)', (r1,))[0] == 'ok')
check('analytics: ครัวเรียกไม่ได้', q(U['kitchen'], 'select count(*) from analytics_hourly(%s, 28)', (r1,))[0] == 'err')
check('analytics: anon เรียกไม่ได้', q(None, 'select count(*) from analytics_hourly(%s, 28)', (r1,))[0] == 'err')
check('analytics: เจ้าของร้านอื่นเรียกข้ามร้านไม่ได้', q(U['other'], 'select count(*) from analytics_hourly(%s, 28)', (r1,))[0] == 'err')
hour_tot = {}
for dow, hr, n in rows[1]:
    hour_tot[hr] = hour_tot.get(hr, 0) + n
top6 = set(sorted(hour_tot, key=lambda h: -hour_tot[h])[:6])
check('analytics: ช่วงพีคตรงกับข้อมูลทดลอง (11-13, 18-20 ตามเวลาไทย)', top6 == {11, 12, 13, 18, 19, 20}, sorted(top6))
sm = q(U['acc'], 'select order_count, avg_bill, avg_prep_minutes, first_order_at from analytics_summary(%s, 60)', (r1,))
check('analytics_summary: มีออเดอร์และวันที่เริ่มต้น', sm[0] == 'ok' and sm[1][0][0] > 0 and sm[1][0][3] is not None, sm[:2])
top = q(U['owner'], 'select item_name, quantity_sold from analytics_top_items(%s, 60)', (r1,))
check('analytics_top_items: ได้รายการเมนู', top[0] == 'ok' and 0 < len(top[1]) <= 10, top[:2])

# ---------- 8) ต้นทุนต่อเมนู ----------
cost = q(U['owner'], "select unit_cost, ingredient_count from menu_item_costs where name='ผัดกะเพราหมูสับ'")
check('menu_item_costs: ต้นทุนกะเพรา = 30.75 และมี 4 วัตถุดิบ',
      cost[0] == 'ok' and float(cost[1][0][0]) == 30.75 and cost[1][0][1] == 4, cost[:2])
check('menu_item_costs: บัญชีเห็นต้นทุนเหมือนกัน',
      float(q(U['acc'], "select unit_cost from menu_item_costs where name='ผัดกะเพราหมูสับ'")[1][0][0]) == 30.75)
check('menu_item_costs: หน้าร้านไม่เห็นต้นทุนจริง (0)',
      float(q(U['staff'], "select unit_cost from menu_item_costs where name='ผัดกะเพราหมูสับ'")[1][0][0]) == 0)

# ---------- 9) จัดการพนักงาน + แยกร้าน ----------
check('owner: เพิ่มพนักงานได้',
      q(U['owner'], "insert into staff_members(user_id,restaurant_id,role) values (%s,%s,'kitchen')", (U['newbie'], r1))[0] == 'ok')
check('kitchen: เพิ่มพนักงานไม่ได้',
      q(U['kitchen'], "insert into staff_members(user_id,restaurant_id,role) values (%s,%s,'owner')", (U['kitchen'], r1))[0] == 'err')
check('บทบาทที่ไม่มีในระบบถูกปฏิเสธ',
      q('su', "update staff_members set role='chef' where user_id=%s", (U['staff'],))[0] == 'err')
check('แยกร้าน: เจ้าของร้านอื่นไม่เห็นออเดอร์', q(U['other'], 'select count(*) from orders')[1][0][0] == 0)
check('แยกร้าน: เจ้าของร้านอื่นไม่เห็นรายจ่าย', q(U['other'], 'select count(*) from expenses')[1][0][0] == 0)
check('แยกร้าน: เจ้าของร้านอื่นไม่เห็นพนักงานร้านแรก',
      q(U['other'], "select count(*) from staff_members where restaurant_id=%s", (r1,))[1][0][0] == 0)
check('ผู้ใช้ที่ล็อกอินแต่ไม่มีบทบาทอ่านออเดอร์ไม่เห็น', q(U['nobody'], 'select count(*) from orders')[1][0][0] == 0)

# ---------- 9.4) สรุปบัญชี (migration 0006) ----------
# เพิ่มออเดอร์ชำระแล้ว 1,200 รายการวันนี้ เกินขีด 1,000 แถวของ Supabase ที่หน้าบัญชีเดิมเจอ
q('su', """insert into orders (restaurant_id, status, total, created_at, paid_at)
            select %s, 'paid', 10, now(), now() from generate_series(1, 1200)""", (r1,))
q('su', "insert into expenses (restaurant_id, category, amount, spent_on) values (%s,'rent',500,(now() at time zone 'Asia/Bangkok')::date), (%s,'rent',250,(now() at time zone 'Asia/Bangkok')::date), (%s,'labor',100,(now() at time zone 'Asia/Bangkok')::date - 3)", (r1, r1, r1))
want_rev = float(one("select sum(total) from orders where restaurant_id=%s and status='paid' and (paid_at at time zone 'Asia/Bangkok')::date = (now() at time zone 'Asia/Bangkok')::date", (r1,)))
acc = q(U['acc'], 'select * from accounting_summary(%s, 1)', (r1,))
check('accounting_summary: บัญชีเรียกได้ ยอดรายรับวันนี้ตรงกับผลรวมจริง (เกิน 1,000 ออเดอร์)',
      acc[0] == 'ok' and float(acc[1][0][2]) == want_rev and acc[1][0][3] >= 1200, (acc, want_rev))
want_cat = {k: float(v) for k, v in q('su', "select category::text, sum(amount) from expenses where restaurant_id=%s and spent_on = (now() at time zone 'Asia/Bangkok')::date group by 1", (r1,))[1]}
check('accounting_summary: รายจ่ายแยกหมวดตรงกับผลรวมจริง และไม่นับรายจ่ายนอกช่วง',
      acc[0] == 'ok' and {k: float(v) for k, v in acc[1][0][5].items()} == want_cat and want_cat.get('rent', 0) >= 750
      and float(acc[1][0][4]) == sum(want_cat.values()), (acc, want_cat))
acc7 = q(U['owner'], 'select expenses_by_category from accounting_summary(%s, 7)', (r1,))
want7 = float(one("select coalesce(sum(amount),0) from expenses where restaurant_id=%s and category='labor' and spent_on > (now() at time zone 'Asia/Bangkok')::date - 7", (r1,)))
check('accounting_summary: ช่วง 7 วันรวม labor ที่ย้อนไป 3 วัน', acc7[0] == 'ok' and float(acc7[1][0][0].get('labor', 0)) == want7 and want7 >= 100, (acc7, want7))
check('accounting_summary: ครัวเรียกไม่ได้', q(U['kitchen'], 'select * from accounting_summary(%s, 1)', (r1,))[0] == 'err')
check('accounting_summary: anon เรียกไม่ได้', q(None, 'select * from accounting_summary(%s, 1)', (r1,))[0] == 'err')
check('accounting_summary: ร้านอื่นเรียกไม่ได้', q(U['other'], 'select * from accounting_summary(%s, 1)', (r1,))[0] == 'err')
check('accounting_summary: days ผิดถูกปฏิเสธ', q(U['owner'], 'select * from accounting_summary(%s, 0)', (r1,))[0] == 'err')

# ---------- 9.5) นำเข้ายอดขาย CSV (migration 0005) ----------
def imp(uid, rows, dry=False, skip=False, rid=None):
    return q(uid, 'select import_sales_history(%s, %s::jsonb, %s, %s)',
             (rid or r1, json.dumps(rows), dry, skip))

ROWS = [
    {"line": 2, "ref": "B001", "at": "2026-09-01 12:05", "item": "ผัดกะเพราหมูสับ", "qty": 2, "price": ""},
    {"line": 3, "ref": "B001", "at": "2026-09-01 12:05", "item": "ผัดกะเพราหมูสับ", "qty": 1, "price": "55"},
    {"line": 4, "ref": "B002", "at": "2026-09-01 18:30", "item": "  ผัดกะเพราหมูสับ ", "qty": 1, "price": ""},
    {"line": 5, "ref": "B001", "at": "2026-09-02 12:00", "item": "ผัดกะเพราหมูสับ", "qty": 1, "price": ""},
]
before_orders = one('select count(*) from orders where restaurant_id=%s', (r1,))
before_kap = qty('หมูสับ') if q('su', "select 1 from ingredients where restaurant_id=%s and name='หมูสับ'", (r1,))[1] else None
d = imp(U['owner'], ROWS, dry=True)
check('import: dry-run ได้ 3 ออเดอร์ 4 รายการ ไม่บันทึกจริง',
      d[0] == 'ok' and d[1][0][0]['orders'] == 3 and d[1][0][0]['lines'] == 4 and d[1][0][0]['batch_id'] is None
      and one('select count(*) from orders where restaurant_id=%s', (r1,)) == before_orders, d)
r = imp(U['owner'], ROWS)
res = r[1][0][0] if r[0] == 'ok' else {}
batch = res.get('batch_id')
check('import: นำเข้าจริงได้ batch_id', r[0] == 'ok' and batch, r)
check('import: B001 วันเดียวกันรวมเป็นบิลเดียว ยอด 2x60+55 = 175',
      float(one("select total from orders where import_batch=%s and created_at = (timestamp '2026-09-01 12:05' at time zone 'Asia/Bangkok')", (batch,))) == 175)
check('import: เลขบิลซ้ำคนละวันแยกออเดอร์', one('select count(*) from orders where import_batch=%s', (batch,)) == 3)
check('import: เวลาแปลงตามเขตเวลาร้าน (12:05 ไทย = 05:05 UTC)',
      one("select count(*) from orders where import_batch=%s and extract(hour from created_at at time zone 'UTC') = 5", (batch,)) == 2)
check('import: สถานะ paid และไม่มีเวลาครัว',
      one("select count(*) from orders where import_batch=%s and status='paid' and started_at is null and ready_at is null", (batch,)) == 3)
if before_kap is not None:
    check('import: ไม่ตัดสต็อก', qty('หมูสับ') == before_kap)
check('import: ฟังก์ชันวิเคราะห์นับออเดอร์ที่นำเข้า (ช่วง 400 วัน)',
      q(U['owner'], 'select coalesce(sum(order_count),0) from analytics_hourly(%s, 400)', (r1,))[1][0][0] >= 3)
bad = ROWS[:1] + [{"line": 9, "ref": "", "at": "2026-09-03 10:00", "item": "เมนูที่ไม่มี", "qty": 1, "price": ""}]
b = imp(U['owner'], bad)
check('import: เมนูไม่รู้จัก -> blocked ไม่นำเข้าอะไรเลย',
      b[0] == 'ok' and b[1][0][0]['blocked'] and b[1][0][0]['unknown_items'] == ['เมนูที่ไม่มี'] and b[1][0][0]['batch_id'] is None, b)
s2 = imp(U['owner'], bad, skip=True)
check('import: skip_unknown นำเข้าเฉพาะที่รู้จัก', s2[0] == 'ok' and s2[1][0][0]['orders'] == 1 and s2[1][0][0]['skipped_lines'] == 1, s2)
check('import: จำนวนติดลบถูกปฏิเสธ', imp(U['owner'], [dict(ROWS[0], qty=-1)])[0] == 'err')
check('import: วันที่ในอนาคตถูกปฏิเสธ', imp(U['owner'], [dict(ROWS[0], at='2099-01-01 10:00')])[0] == 'err')
check('import: วันที่ผิดรูปแบบถูกปฏิเสธ', imp(U['owner'], [dict(ROWS[0], at='hello')])[0] == 'err')
check('import: บัญชีนำเข้าไม่ได้', imp(U['acc'], ROWS)[0] == 'err')
check('import: anon นำเข้าไม่ได้', imp(None, ROWS)[0] == 'err')
check('import: เจ้าของร้านอื่นนำเข้าข้ามร้านไม่ได้', imp(U['other'], ROWS)[0] == 'err')
check('import: เรียกซ้ำใน session เดียวกันได้ (temp table)', imp(U['owner'], ROWS, dry=True)[0] == 'ok')
check('import: เจ้าของลบรอบนำเข้าได้ (RLS delete)',
      q(U['owner'], 'delete from orders where import_batch=%s', (batch,))[2] == 3)

# ไฟล์ตัวอย่างใน public/ ผ่านตัวอ่าน CSV ของ backend จริง แล้วนำเข้าฐานข้อมูลได้
APP = ROOT.parent
parsed = json.loads(subprocess.run(
    ['node', '-e', "import('./backend/src/csv.ts').then(m => process.stdout.write(JSON.stringify("
     "m.parseSales(require('fs').readFileSync('frontend/public/sample-sales.csv','utf8')))))"],
    cwd=APP, capture_output=True, text=True, check=True).stdout)
sp = imp(U['owner'], parsed['rows'], dry=True)
check('import: ไฟล์ตัวอย่าง sample-sales.csv ผ่านตัวอ่าน backend และตรงกับเมนูตัวอย่าง',
      parsed['errors'] == [] and sp[0] == 'ok' and sp[1][0][0]['orders'] == 3 and not sp[1][0][0]['blocked'], (parsed, sp))

# ---------- 9.55) จัดการพนักงาน ----------
q('su', "update app_users set email = 'kitchen@example.com' where id=%s", (U['kitchen'],))
check('staff_find_user: service_role หาได้ (ไม่สนตัวพิมพ์)',
      q('service', 'select staff_find_user(%s)', (' Kitchen@Example.com',))[1][0][0] == U['kitchen'])
check('staff_find_user: ผู้ใช้ล็อกอินเรียกไม่ได้', q(U['owner'], 'select staff_find_user(%s)', ('kitchen@example.com',))[0] == 'err')
check('staff_find_user: anon เรียกไม่ได้', q(None, 'select staff_find_user(%s)', ('kitchen@example.com',))[0] == 'err')
sl = q('service', 'select * from staff_list(%s)', (r1,))
check('staff_list: ได้รายชื่อพนักงานร้าน', sl[0] == 'ok' and len(sl[1]) >= 5, sl)
check('staff_list: เจ้าของเรียกตรงไม่ได้ (ต้องผ่าน backend)', q(U['owner'], 'select * from staff_list(%s)', (r1,))[0] == 'err')
check('last owner: ลบเจ้าของคนสุดท้ายไม่ได้',
      q(U['owner'], 'delete from staff_members where user_id=%s and restaurant_id=%s', (U['owner'], r1))[0] == 'err')
check('last owner: ลดบทบาทเจ้าของคนสุดท้ายไม่ได้',
      q(U['owner'], "update staff_members set role='staff' where user_id=%s and restaurant_id=%s", (U['owner'], r1))[0] == 'err')
q(U['owner'], "update staff_members set role='owner' where user_id=%s and restaurant_id=%s", (U['acc'], r1))
check('last owner: มีเจ้าของ 2 คน ลดบทบาทคนหนึ่งได้',
      q(U['owner'], "update staff_members set role='accountant' where user_id=%s and restaurant_id=%s", (U['acc'], r1))[2] == 1)
check('last owner: ลบร้านทั้งร้านได้ (cascade)', q('su', 'delete from restaurants where id=%s', (r2,))[0] == 'ok')

# ---------- 9.7) ผู้จัดการ (manager) + โปรโมชัน (0009) ----------
M = U['mgr']
# 1) พนักงาน: จัดการได้เฉพาะบทบาทต่ำกว่า
check('manager: เพิ่มพนักงานครัวได้',
      q(M, "insert into staff_members(user_id, restaurant_id, role) values (%s,%s,'kitchen')", (U['cook2'], r1))[0] == 'ok')
check('manager: เปลี่ยนบทบาทพนักงานเป็นบัญชีได้',
      q(M, "update staff_members set role='accountant' where user_id=%s and restaurant_id=%s", (U['cook2'], r1))[2] == 1)
check('manager: แต่งตั้งเจ้าของไม่ได้',
      q(M, "update staff_members set role='owner' where user_id=%s and restaurant_id=%s", (U['cook2'], r1))[0] == 'err')
check('manager: แต่งตั้งผู้จัดการคนอื่นไม่ได้',
      q(M, "update staff_members set role='manager' where user_id=%s and restaurant_id=%s", (U['cook2'], r1))[0] == 'err')
check('manager: เพิ่มคนเป็นเจ้าของไม่ได้',
      q(M, "insert into staff_members(user_id, restaurant_id, role) values (%s,%s,'owner')", (U['newbie'], r1))[0] == 'err')
check('manager: แก้/ลบเจ้าของไม่ได้ (0 แถว)',
      q(M, "update staff_members set role='staff' where user_id=%s and restaurant_id=%s", (U['owner'], r1))[2] == 0
      and q(M, "delete from staff_members where user_id=%s and restaurant_id=%s", (U['owner'], r1))[2] == 0)
check('manager: เปลี่ยนบทบาทตัวเองไม่ได้ (0 แถว)',
      q(M, "update staff_members set role='staff' where user_id=%s and restaurant_id=%s", (M, r1))[2] == 0)
check('manager: นำพนักงานออกได้',
      q(M, "delete from staff_members where user_id=%s and restaurant_id=%s", (U['cook2'], r1))[2] == 1)
check('staff: จัดการพนักงานไม่ได้',
      q(U['staff'], "insert into staff_members(user_id, restaurant_id, role) values (%s,%s,'kitchen')", (U['cook2'], r1))[0] == 'err')
check('owner: แต่งตั้งผู้จัดการได้',
      q(U['owner'], "insert into staff_members(user_id, restaurant_id, role) values (%s,%s,'manager')", (U['cook2'], r1))[0] == 'ok')
q('su', "delete from staff_members where user_id=%s", (U['cook2'],))

# ---------- 9.75) ผู้ใช้ของระบบเอง (0021) ----------
nu = q('service', "select app_create_user(' New.Cook@Example.com ', 'temp-pass-1', 'ต้น', true)")
check('app_users: service สร้างผู้ใช้ได้ (อีเมลเก็บเป็นตัวเล็ก)', nu[0] == 'ok'
      and one("select email from app_users where id=%s", (nu[1][0][0],)) == 'new.cook@example.com', nu)
NU = nu[1][0][0]
lg = q('service', "select id, must_change_password from app_login('NEW.cook@example.com', 'temp-pass-1')")
check('app_login: รหัสถูก -> ได้ผู้ใช้ และบอกว่าต้องเปลี่ยนรหัส', lg[0] == 'ok' and len(lg[1]) == 1 and lg[1][0] == (NU, True), lg)
check('app_login: รหัสผิด -> ไม่มีแถว', q('service', "select * from app_login('new.cook@example.com', 'wrong-pass')")[1] == [])
check('app_login: ไม่มีอีเมลนี้ -> ไม่มีแถว', q('service', "select * from app_login('none@example.com', 'temp-pass-1')")[1] == [])
check('app_login: บันทึกเวลาล็อกอินล่าสุด', one("select last_login_at is not null from app_users where id=%s", (NU,)))
check('app_set_password: รหัสสั้นกว่า 8 ไม่ได้', q('service', "select app_set_password(%s, 'short')", (NU,))[0] == 'err')
q('service', "select app_set_password(%s, 'my-new-pass', false)", (NU,))
check('app_set_password: รหัสใหม่ใช้ได้ รหัสเก่าใช้ไม่ได้',
      len(q('service', "select * from app_login('new.cook@example.com', 'my-new-pass')")[1]) == 1
      and q('service', "select * from app_login('new.cook@example.com', 'temp-pass-1')")[1] == [])
check('app_set_password: ไม่ต้องเปลี่ยนรหัสแล้ว', one("select must_change_password from app_users where id=%s", (NU,)) is False)
check('app_set_password: เก็บแบบเข้ารหัส ไม่ใช่ข้อความตรงๆ', one("select password_hash <> 'my-new-pass' from app_users where id=%s", (NU,)))
q('su', "update app_users set is_active=false where id=%s", (NU,))
check('app_login: บัญชีที่ปิดแล้วล็อกอินไม่ได้', q('service', "select * from app_login('new.cook@example.com', 'my-new-pass')")[1] == [])
check('app_user_active: บัญชีที่ปิดแล้ว = false', q('service', 'select app_user_active(%s)', (NU,))[1][0][0] is False)
check('app_user_active: บัญชีปกติ = true', q('service', 'select app_user_active(%s)', (U['owner'],))[1][0][0] is True)
check('app_users: อีเมลซ้ำไม่ได้', q('service', "select app_create_user('new.cook@example.com', 'temp-pass-2')")[0] == 'err')
check('app_users: ผู้ใช้ที่ล็อกอินอ่านตารางไม่ได้ (เห็นรหัสผ่านไม่ได้)', q(U['owner'], 'select count(*) from app_users')[0] == 'err')
check('app_users: anon อ่านตารางไม่ได้', q(None, 'select count(*) from app_users')[0] == 'err')
check('app_login: ผู้ใช้ที่ล็อกอินเรียกไม่ได้', q(U['owner'], "select * from app_login('a@b.c', 'x')")[0] == 'err')
check('app_login: anon เรียกไม่ได้', q(None, "select * from app_login('a@b.c', 'x')")[0] == 'err')
check('app_create_user: ผู้ใช้ที่ล็อกอินเรียกไม่ได้', q(U['owner'], "select app_create_user('x@y.z', 'temp-pass-1')")[0] == 'err')
check('app_set_password: ผู้ใช้ที่ล็อกอินเรียกไม่ได้', q(U['owner'], "select app_set_password(%s, 'hacked-pass')", (U['owner'],))[0] == 'err')
check('app_users: foreign key ของ staff_members ชี้ app_users',
      one("select confrelid::regclass::text from pg_constraint where conrelid='staff_members'::regclass and contype='f' and conkey = array[(select attnum from pg_attribute where attrelid='staff_members'::regclass and attname='user_id')]::smallint[]") == 'app_users')
check('app_users: ไม่มี foreign key ชี้ auth.users เหลืออยู่',
      one("select count(*) from pg_constraint where contype='f' and confrelid='auth.users'::regclass") == 0)
q('su', 'delete from app_users where id=%s', (NU,))

# ---------- 9.8) พนักงานหลายบทบาท (0020) ----------
C2 = U['cook2']
check('หลายบทบาท: เจ้าของตั้งบทบาท หน้าร้าน + สต็อก ให้คนเดียวได้',
      q(U['owner'], "insert into staff_members(user_id, restaurant_id, role) values (%s,%s,'staff'),(%s,%s,'stock')", (C2, r1, C2, r1))[0] == 'ok')
check('หลายบทบาท: ได้สิทธิ์ของทุกบทบาทรวมกัน (อ่านวัตถุดิบได้ เพราะมีบทบาทสต็อก)',
      q(C2, 'select count(*) from ingredients')[1][0][0] > 0)
check('หลายบทบาท: ได้สิทธิ์หน้าร้านด้วย (เห็นออเดอร์)',
      q(C2, 'select count(*) from orders where restaurant_id=%s', (r1,))[0] == 'ok'
      and q(C2, 'select count(*) from orders where restaurant_id=%s', (r1,))[1][0][0] > 0)
check('หลายบทบาท: ยังไม่ได้สิทธิ์บทบาทที่ไม่มี (บันทึกรายจ่ายไม่ได้)',
      q(C2, "insert into expenses(restaurant_id,category,amount) values (%s,'other',1)", (r1,))[0] == 'err')
sl = q('su', 'select roles from staff_list(%s) where user_id=%s', (r1, C2))
check('staff_list: คืนบทบาทเป็น array 1 แถวต่อคน', sl[0] == 'ok' and len(sl[1]) == 1 and sl[1][0][0] == ['staff', 'stock'], sl)
sr = q(U['owner'], "select staff_set_roles(%s, %s, array['kitchen','stock'])", (r1, C2))
check('staff_set_roles: แทนที่ทั้งชุด (เพิ่มครัว เอาหน้าร้านออก)', sr[0] == 'ok' and sr[1][0][0] == ['kitchen', 'stock'], sr)
check('staff_set_roles: บทบาทว่างไม่ได้', q(U['owner'], "select staff_set_roles(%s, %s, array[]::text[])", (r1, C2))[0] == 'err')
check('staff_set_roles: คนที่ไม่อยู่ในร้านไม่ได้', q(U['owner'], "select staff_set_roles(%s, %s, array['staff'])", (r1, U['nobody']))[0] == 'err')
check('staff_set_roles: บทบาทที่ไม่รู้จักไม่ได้', q(U['owner'], "select staff_set_roles(%s, %s, array['chef'])", (r1, C2))[0] == 'err')
check('staff_set_roles: ผู้จัดการตั้งบทบาทพนักงานได้', q(M, "select staff_set_roles(%s, %s, array['staff','accountant'])", (r1, C2))[0] == 'ok')
check('staff_set_roles: ผู้จัดการเพิ่มบทบาทผู้จัดการให้คนอื่นไม่ได้',
      q(M, "select staff_set_roles(%s, %s, array['staff','manager'])", (r1, C2))[0] == 'err')
check('staff_set_roles: ผู้จัดการเพิ่มบทบาทให้ตัวเองไม่ได้',
      q(M, "select staff_set_roles(%s, %s, array['manager','stock'])", (r1, M))[0] == 'err')
check('staff_set_roles: พนักงานทั่วไปใช้ไม่ได้', q(U['staff'], "select staff_set_roles(%s, %s, array['staff'])", (r1, C2))[0] == 'err')
# ผู้จัดการห้ามแตะคนที่มีบทบาทเจ้าของ แม้แถวที่แก้จะเป็นบทบาทต่ำกว่า
q(U['owner'], "insert into staff_members(user_id, restaurant_id, role) values (%s,%s,'kitchen')", (U['owner'], r1))
check('ผู้จัดการ: ลบบทบาทครัวของเจ้าของไม่ได้ (0 แถว)',
      q(M, "delete from staff_members where user_id=%s and restaurant_id=%s and role='kitchen'", (U['owner'], r1))[2] == 0)
check('ผู้จัดการ: เพิ่มบทบาทให้เจ้าของไม่ได้',
      q(M, "insert into staff_members(user_id, restaurant_id, role) values (%s,%s,'stock')", (U['owner'], r1))[0] == 'err')
check('เจ้าของคนสุดท้าย: เปลี่ยนเป็นครัวอย่างเดียวไม่ได้',
      q(U['owner'], "select staff_set_roles(%s, %s, array['kitchen'])", (r1, U['owner']))[0] == 'err'
      and one("select count(*) from staff_members where user_id=%s and role='owner'", (U['owner'],)) == 1)
check('เจ้าของ: ลบบทบาทเสริมของตัวเองได้ (ยังเป็นเจ้าของ)',
      q(U['owner'], "select staff_set_roles(%s, %s, array['owner'])", (r1, U['owner']))[0] == 'ok')
q('su', "delete from staff_members where user_id=%s", (C2,))

# 2) เมนู
cat = q(M, "insert into menu_categories(restaurant_id, name, sort_order) values (%s,'ของหวาน',9) returning id", (r1,))
check('manager: เพิ่มหมวดเมนูได้', cat[0] == 'ok', cat)
new_item = q(M, "insert into menu_items(restaurant_id, category_id, name, price) values (%s,%s,'บัวลอย',35) returning id", (r1, cat[1][0][0]))
check('manager: เพิ่มเมนูได้', new_item[0] == 'ok', new_item)
BUA = new_item[1][0][0]
check('manager: แก้ราคาเมนูได้', q(M, "update menu_items set price=40 where id=%s", (BUA,))[2] == 1)
check('manager: ตั้งเมนูหมดได้', q(M, "select set_menu_availability(%s, true)", (BUA,))[0] == 'ok')
check('manager: ลบเมนูที่เคยขายแล้วไม่ได้ (ต้องปิดขายแทน)', q(M, "delete from menu_items where id=%s", (KAPRAO,))[0] == 'err')
check('staff: แก้ราคาเมนูไม่ได้ (0 แถว)', q(U['staff'], "update menu_items set price=1 where id=%s", (BUA,))[2] == 0)
check('manager: ลบเมนูที่ยังไม่เคยขายได้', q(M, "delete from menu_items where id=%s", (BUA,))[2] == 1)
check('manager: แก้โต๊ะไม่ได้ (0 แถว)', q(M, "update dining_tables set label='x' where restaurant_id=%s", (r1,))[2] == 0)

# 3) นำเข้า CSV
mi = imp(M, ROWS)
check('manager: นำเข้า CSV ได้', mi[0] == 'ok' and mi[1][0][0]['orders'] == 3, mi)
mb = mi[1][0][0]['batch_id']
real = place(1)[1][0][0]
check('manager: ไม่เห็นออเดอร์จริง', q(M, 'select count(*) from orders where import_batch is null')[1][0][0] == 0)
check('manager: ลบออเดอร์จริงไม่ได้ (0 แถว)', q(M, "delete from orders where id=%s", (real,))[2] == 0)
_du = q(M, "delete from orders where import_batch=%s", (mb,))
check('manager: ย้อนการนำเข้าได้', _du[2] == 3)

# 4) ผู้จัดการไม่ได้รับออเดอร์ · ดูบัญชีได้อย่างเดียว (0016)
check('manager: รับออเดอร์ไม่ได้', order_as(M, items(1))[0] == 'err')
check('manager: เห็นรายจ่าย (0016)', q(M, 'select count(*) from expenses')[1][0][0] >= 1)
check('manager: เรียกสรุปบัญชีได้ (0016)', q(M, 'select * from accounting_summary(%s, 1)', (r1,))[0] == 'ok')
check('manager: บันทึกรายจ่ายไม่ได้',
      q(M, "insert into expenses(restaurant_id, category, amount, spent_on) values (%s, 'other', 10, current_date)", (r1,))[0] == 'err')
check('manager: แก้รายจ่ายไม่ได้ (0 แถว)', q(M, 'update expenses set amount = 1 where restaurant_id=%s', (r1,))[2] == 0)
check('manager: ลบรายจ่ายไม่ได้ (0 แถว)', q(M, 'delete from expenses where restaurant_id=%s', (r1,))[2] == 0)
check('manager: เห็นต้นทุนต่อเมนู (มีสูตร)',
      q(M, 'select count(*) from menu_item_costs where restaurant_id=%s and ingredient_count > 0', (r1,))[1][0][0] > 0)
check('manager: จัดการวัตถุดิบได้ (0030: owner / manager / stock)', q(M, "update ingredients set storage_location='ตู้แช่ 1' where restaurant_id=%s and name='หมูสับ'", (r1,))[2] == 1)
check('manager: ร้านอื่นยังไม่เห็นรายจ่ายร้านเรา',
      q(U['other'], 'select count(*) from expenses where restaurant_id=%s', (r1,))[1][0][0] == 0)

# 5) โปรโมชัน
def promo(uid, name, **kw):
    cols = {'restaurant_id': r1, 'name': name, 'discount_type': 'percent', 'value': 10}
    cols.update(kw)
    keys = ','.join(cols)
    ph = ','.join(['%s'] * len(cols))
    return q(uid, f"insert into promotions({keys}) values ({ph}) returning id", tuple(cols.values()))

p10 = promo(M, 'ลด 10% ทั้งบิล')
check('manager: สร้างโปรโมชันได้', p10[0] == 'ok', p10)
P10 = p10[1][0][0]
check('staff: สร้างโปรโมชันไม่ได้', promo(U['staff'], 'แอบลด')[0] == 'err')
check('staff: เห็นโปรโมชัน', q(U['staff'], 'select count(*) from promotions where id=%s', (P10,))[1][0][0] == 1)
check('โปร: ลดเกิน 100% ไม่ได้', promo(M, 'ผิด', value=150)[0] == 'err')
TODAY = one("select (now() at time zone 'Asia/Bangkok')::date")
check('โปร: วันสิ้นสุดก่อนวันเริ่มไม่ได้', promo(M, 'ผิด', starts_on=TODAY + datetime.timedelta(days=10), ends_on=TODAY + datetime.timedelta(days=5))[0] == 'err')
check('โปร: วันในสัปดาห์ผิดไม่ได้', promo(M, 'ผิด', days_of_week=[7])[0] == 'err')

def order_promo(pid, js=None, uid=None):
    pids = pid if isinstance(pid, list) else [pid]
    return q(uid or U['staff'], "select staff_place_order(%s, %s::jsonb, %s, 'dine_in', null, null, %s::uuid[])",
             (r1, js or items(2), tables[0], [str(x) for x in pids]))

o = order_promo(P10)
check('โปร: ลด 10% (2 x 60 = 120 ลด 12 = 108)', o[0] == 'ok' and
      one("select (subtotal, discount_total, total) = (120.00, 12.00, 108.00) and promotion_id = %s from orders where id=%s", (P10, o[1][0][0])), o)
amt = promo(M, 'ลด 500 บาท', discount_type='amount', value=500)[1][0][0]
o = order_promo(amt)
check('โปร: ลดเป็นบาทไม่เกินยอดบิล (ลด 500 จากบิล 120 = 0)', one("select discount_total = 120 and total = 0 from orders where id=%s", (o[1][0][0],)))
tea = menu['ชาเย็น']
only_tea = promo(M, 'ชาเย็นลด 50%', value=50)[1][0][0]
check('manager: ผูกโปรกับเมนูได้', q(M, "insert into promotion_items(promotion_id, menu_item_id) values (%s,%s)", (only_tea, tea))[0] == 'ok')
mixed = json.dumps([{"menu_item_id": str(KAPRAO), "quantity": 1}, {"menu_item_id": str(tea), "quantity": 2}])
o = order_promo(only_tea, mixed)
check('โปร: ลดเฉพาะเมนูที่ผูก (ชาเย็น 2 x 30 = 60 ลด 50% = 30, กะเพราไม่ลด)',
      o[0] == 'ok' and one("select subtotal = 120 and discount_total = 30 and total = 90 from orders where id=%s", (o[1][0][0],)), o)
check('โปร: บิลไม่มีเมนูที่ร่วมโปรใช้ไม่ได้', order_promo(only_tea, items(1))[0] == 'err')
check('โปร: ผูกเมนูร้านอื่นไม่ได้',
      q(M, "insert into promotion_items(promotion_id, menu_item_id) values (%s,%s)", (only_tea, uuid.uuid4()))[0] == 'err')
minp = promo(M, 'ซื้อครบ 500 ลด 10%', min_subtotal=500)[1][0][0]
check('โปร: ยอดไม่ถึงขั้นต่ำใช้ไม่ได้', order_promo(minp)[0] == 'err')
off = promo(M, 'ปิดอยู่', is_active=False)[1][0][0]
check('โปร: โปรที่ปิดใช้ไม่ได้', order_promo(off)[0] == 'err')
ended = promo('su', 'หมดแล้ว', starts_on='2020-01-01', ends_on='2020-01-31')[1][0][0]  # วันที่ย้อนหลังสร้างได้เฉพาะระบบ (0012)
check('โปร: โปรหมดอายุใช้ไม่ได้', order_promo(ended)[0] == 'err')
dow_now = one("select extract(dow from now() at time zone 'Asia/Bangkok')::int")
wrong_day = promo(M, 'วันอื่น', days_of_week=[(dow_now + 1) % 7])[1][0][0]
check('โปร: ไม่ใช่วันที่กำหนดใช้ไม่ได้ (ตามเวลาร้าน)', order_promo(wrong_day)[0] == 'err')
today = promo(M, 'วันนี้', days_of_week=[dow_now])[1][0][0]
check('โปร: ตรงวันที่กำหนดใช้ได้', order_promo(today)[0] == 'ok')
h = one("select extract(hour from now() at time zone 'Asia/Bangkok')::int")
if 1 <= h <= 21:
    later = promo(M, 'ช่วงอื่น', start_time=f'{h+1:02d}:00', end_time=f'{h+2:02d}:00')[1][0][0]
    check('โปร: นอกช่วงเวลาใช้ไม่ได้ (ตามเวลาร้าน)', order_promo(later)[0] == 'err')
avail = q(U['staff'], 'select id from promotions_available(%s)', (r1,))
ids = {r[0] for r in avail[1]} if avail[0] == 'ok' else set()
check('promotions_available: มีเฉพาะโปรที่ใช้ได้ตอนนี้', P10 in ids and today in ids and off not in ids and ended not in ids and wrong_day not in ids, avail)
check('โปร: ใช้โปรร้านอื่นไม่ได้/ไม่มีอยู่', order_promo(uuid.uuid4())[0] == 'err')
check('โปร: ลบโปรที่เคยใช้แล้วไม่ได้ (ให้ปิดใช้งานแทน)', q(M, "delete from promotions where id=%s", (P10,))[0] == 'err')
check('โปร: ปิดใช้งานได้', q(M, "update promotions set is_active=false where id=%s", (P10,))[2] == 1)
check('โปร: ลบโปรที่ยังไม่เคยใช้ได้', q(M, "delete from promotions where id=%s", (off,))[2] == 1)
check('staff: แก้ส่วนลดในออเดอร์ตรงไม่ได้', q(U['staff'], "update orders set discount_total=999 where id=%s", (o[1][0][0],))[0] == 'err')
check('ครัว: รับออเดอร์ด้วยโปรไม่ได้', order_promo(today, uid=U['kitchen'])[0] == 'err')
check('anon: เห็นโปรโมชันไม่ได้', q(None, 'select count(*) from promotions')[0] == 'err')

# 6) บัญชีเห็นยอดส่วนลด
pd = order_promo(today)[1][0][0]
for who, st_ in [('kitchen', 'preparing'), ('kitchen', 'ready'), ('kitchen', 'served'), ('staff', 'paid')]:
    q(U[who], "update orders set status=%s where id=%s", (st_, pd))
want_disc = float(one("select coalesce(sum(discount_total),0) from orders where restaurant_id=%s and status='paid' and (paid_at at time zone 'Asia/Bangkok')::date = (now() at time zone 'Asia/Bangkok')::date", (r1,)))
ac = q(U['acc'], 'select discount_total, revenue_total from accounting_summary(%s, 1)', (r1,))
check('accounting_summary: แสดงยอดส่วนลดโปรของบิลที่ชำระแล้ว', ac[0] == 'ok' and float(ac[1][0][0]) == want_disc and want_disc > 0, (ac, want_disc))

# 7) กฎวันที่ + จำนวนครั้ง + เลือกโปรตอนรับชำระ (0012)
D = datetime.timedelta
check('โปร: วันเริ่มย้อนหลังไม่ได้', promo(M, 'ย้อนหลัง', starts_on=TODAY - D(days=1))[0] == 'err')
check('โปร: วันสิ้นสุดย้อนหลังไม่ได้', promo(M, 'ย้อนหลัง', ends_on=TODAY - D(days=1))[0] == 'err')
check('โปร: เริ่มและจบวันนี้ได้', promo(M, 'วันเดียว', starts_on=TODAY, ends_on=TODAY)[0] == 'ok')
check('โปร: แก้ชื่อโปรเก่าที่วันที่ผ่านไปแล้วได้', q(M, "update promotions set name='หมดแล้ว (เก่า)' where id=%s", (ended,))[2] == 1)
check('โปร: แก้วันที่โปรเก่าเป็นวันย้อนหลังไม่ได้', q(M, "update promotions set ends_on='2020-02-01' where id=%s", (ended,))[0] == 'err')
check('โปร: จำนวนครั้งต้องมากกว่า 0', promo(M, 'ผิด', max_uses=0)[0] == 'err')

once = promo(M, 'ใช้ได้ครั้งเดียว', max_uses=1)[1][0][0]
o1 = order_promo(once)
check('โปรจำกัดครั้ง: ครั้งแรกใช้ได้', o1[0] == 'ok', o1)
check('โปรจำกัดครั้ง: นับการใช้ 1 ครั้ง', q(M, 'select used from promotion_usage(%s) where promotion_id=%s', (r1, once))[1][0][0] == 1)
check('โปรจำกัดครั้ง: ครบแล้วใช้ไม่ได้', order_promo(once)[0] == 'err')
check('โปรจำกัดครั้ง: ครบแล้วไม่อยู่ใน promotions_available',
      once not in [x[0] for x in q(U['staff'], 'select id from promotions_available(%s)', (r1,))[1]])
q(U['staff'], "update orders set status='cancelled' where id=%s", (o1[1][0][0],))
check('โปรจำกัดครั้ง: ยกเลิกออเดอร์แล้วคืนสิทธิ์', order_promo(once)[0] == 'ok')
check('staff: สร้างการใช้โปรเองไม่ได้', q(U['staff'], 'insert into promotion_uses(promotion_id, restaurant_id) values (%s,%s)', (once, r1))[0] == 'err')


def served_order(js=None, table=None):
    oid_ = order_as(U['staff'], js or items(2), table=table or tables[1])[1][0][0]
    for st_ in ['preparing', 'ready', 'served']:
        q(U['kitchen'], "update orders set status=%s where id=%s", (st_, oid_))
    return oid_


def pay(ids, pid=None, uid=None):
    pids = None if pid is None else [str(x) for x in (pid if isinstance(pid, list) else [pid])]
    return q(uid or U['staff'], 'select counter_pay_bill(%s, %s::uuid[], %s::uuid[])', (r1, [str(i) for i in ids], pids))


b1, b2 = served_order(items(2)), served_order(items(1))  # 120 + 60 = 180
r = pay([b1, b2], P10_LIVE := promo(M, 'ลด 10% ตอนจ่าย')[1][0][0])
check('รับชำระ: เลือกโปร 10% ให้ทั้งบิลได้ (180 ลด 18 = 162)', r[0] == 'ok' and
      float(r[1][0][0]['discount']) == 18 and float(r[1][0][0]['total']) == 162, r)
check('รับชำระ: ทุกออเดอร์ในบิลเป็น paid', one("select count(*) from orders where id = any(%s::uuid[]) and status='paid'", ([str(b1), str(b2)],)) == 2)
check('รับชำระ: กระจายส่วนลดลงแต่ละออเดอร์ (12 + 6)',
      one("select array_agg(discount_total order by discount_total) = array[6.00, 12.00]::numeric[] from orders where id = any(%s::uuid[])", ([str(b1), str(b2)],)))
check('รับชำระ: นับเป็นการใช้โปร 1 ครั้งต่อบิล', q(M, 'select used from promotion_usage(%s) where promotion_id=%s', (r1, P10_LIVE))[1][0][0] == 1)
check('รับชำระ: บิลที่จ่ายแล้วจ่ายซ้ำไม่ได้', pay([b1, b2])[0] == 'err')

b3 = served_order(items(1))
b4 = order_as(U['staff'], items(1), table=tables[1])[1][0][0]
check('รับชำระ: บิลที่ยังเสิร์ฟไม่ครบจ่ายไม่ได้', pay([b3, b4])[0] == 'err')
q(U['staff'], "update orders set status='cancelled' where id=%s", (b4,))
check('รับชำระ: ยอดไม่ถึงขั้นต่ำใช้โปรไม่ได้', pay([b3], minp)[0] == 'err')
check('รับชำระ: บิลไม่มีเมนูที่ร่วมโปรใช้ไม่ได้', pay([b3], only_tea)[0] == 'err')
check('รับชำระ: โปรหมดอายุใช้ไม่ได้', pay([b3], ended)[0] == 'err')
check('รับชำระ: ครัวรับชำระไม่ได้', pay([b3], uid=U['kitchen'])[0] == 'err')
check('รับชำระ: ร้านอื่นรับชำระไม่ได้', q(U['other'], 'select counter_pay_bill(%s, %s::uuid[], null::uuid[])', (r2, [str(b3)]))[0] == 'err')
check('รับชำระ: ไม่เลือกโปร = จ่ายตามยอดเดิม', pay([b3])[0] == 'ok' and one('select total = 60 and discount_total = 0 from orders where id=%s', (b3,)))

b5 = order_promo(today)  # ใส่โปร 10% ไว้ตอนรับออเดอร์ (120 ลด 12)
b5 = b5[1][0][0]
for st_ in ['preparing', 'ready', 'served']:
    q(U['kitchen'], "update orders set status=%s where id=%s", (st_, b5))
r = pay([b5], amt)
check('รับชำระ: เลือกโปรใหม่แทนโปรตอนรับออเดอร์ (ลด 500 บาท จาก 120 = 0)', r[0] == 'ok' and
      one('select discount_total = 120 and total = 0 and promotion_id = %s from orders where id=%s', (amt, b5)), r)


# 8) ใช้หลายโปรพร้อมกัน (เมนูไม่ซ้ำ + โปรทั้งบิลได้ 1 อัน คิดหลังหักโปรรายเมนู)
o = order_promo([only_tea, today], mixed)  # กะเพรา 60 x1 + ชาเย็น 30 x2 = 120
check('หลายโปร: ชาเย็นลด 50% (−30) + ทั้งบิลลด 10% จาก 90 (−9) = 81', o[0] == 'ok' and
      one('select (subtotal, discount_total, total) = (120.00, 39.00, 81.00) from orders where id=%s', (o[1][0][0],)), o)
check('หลายโปร: บันทึกส่วนลดแยกตามโปร',
      one('select array_agg(discount order by discount) = array[9.00, 30.00]::numeric[] from order_promotions where order_id=%s', (o[1][0][0],)))
check('หลายโปร: โปรทั้งบิล 2 อันพร้อมกันไม่ได้', order_promo([today, P10_LIVE])[0] == 'err')
tea2 = promo(M, 'ชาเย็นลด 5 บาท', discount_type='amount', value=5)[1][0][0]
q(M, "insert into promotion_items(promotion_id, menu_item_id) values (%s,%s)", (tea2, tea))
check('หลายโปร: โปรรายเมนูที่เมนูซ้ำกันใช้พร้อมกันไม่ได้', order_promo([only_tea, tea2], mixed)[0] == 'err')
kap = promo(M, 'กะเพราลด 10 บาท', discount_type='amount', value=10)[1][0][0]
q(M, "insert into promotion_items(promotion_id, menu_item_id) values (%s,%s)", (kap, KAPRAO))
o = order_promo([only_tea, kap, today], mixed)
check('หลายโปร: รายเมนูไม่ซ้ำ 2 อัน + ทั้งบิล 1 อัน (−30 −10 −8 = 72)', o[0] == 'ok' and
      one('select total = 72 and discount_total = 48 from orders where id=%s', (o[1][0][0],)), o)
check('หลายโปร: โปรเดียวกันซ้ำนับครั้งเดียว', order_promo([kap, kap])[0] == 'ok')

b6, b7 = served_order(mixed), served_order(items(1))  # 120 + 60 = 180
r = pay([b6, b7], [only_tea, today])
check('รับชำระ: หลายโปรทั้งบิล (ชา −30, ทั้งบิล 10% จาก 150 = −15 → 135)', r[0] == 'ok' and float(r[1][0][0]['total']) == 135, r)

lim = promo(M, 'ครั้งเดียว (ใช้ต่อตอนจ่าย)', max_uses=1)[1][0][0]
b8 = order_promo(lim)[1][0][0]
for st_ in ['preparing', 'ready', 'served']:
    q(U['kitchen'], "update orders set status=%s where id=%s", (st_, b8))
q(M, "update promotions set is_active=false where id=%s", (lim,))
r = pay([b8], [lim])
check('รับชำระ: โปรที่ได้ตอนรับออเดอร์ใช้ต่อได้ แม้ครบจำนวน/ปิดไปแล้ว', r[0] == 'ok' and float(r[1][0][0]['discount']) == 12, r)
check('รับชำระ: ใช้ต่อแล้วยังนับเป็น 1 ครั้ง', q(M, 'select used from promotion_usage(%s) where promotion_id=%s', (r1, lim))[1][0][0] == 1)

# ---------- 9.5) จอแสดงผล iPad (0013) ----------
check('จอ: พนักงานสร้างลิงก์จอไม่ได้', q(U['staff'], 'select display_rotate_token(%s)', (r1,))[0] == 'err')
check('จอ: ร้านอื่นสร้างลิงก์ให้ร้านเราไม่ได้', q(U['other'], 'select display_rotate_token(%s)', (r1,))[0] == 'err')
tok = q(U['mgr'], 'select display_rotate_token(%s)', (r1,))[1][0][0]
check('จอ: ผู้จัดการสร้างลิงก์ได้ (โทเค็นยาว 64 ตัว)', len(tok) == 64)
check('จอ: พนักงานอ่านโทเค็นไม่ได้', q(U['staff'], 'select count(*) from display_screens')[1][0][0] == 0)
check('จอ: เจ้าของอ่านโทเค็นได้', q(U['owner'], 'select token from display_screens where restaurant_id=%s', (r1,))[1][0][0] == tok)
check('จอ: ไม่ล็อกอินก็เขียนตารางลิงก์ไม่ได้',
      q(None, "insert into display_screens(restaurant_id, token) values (%s, repeat('a', 64))", (r2,))[0] == 'err')
check('จอ: ข้อมูลทดลองมีเมนูแนะนำ 4 เมนู + สื่อหลายชิ้น + คลิปโฆษณาร้าน',
      one('select count(*) from menu_items where is_recommended') == 4
      and one('select count(*) from display_media where menu_item_id=%s', (KAPRAO,)) == 2
      and one("select count(*) from display_media where menu_item_id is null and kind='video' and is_active") == 1)
# เริ่มจากศูนย์สำหรับชุดทดสอบนี้
q('su', 'update menu_items set is_recommended=false')
q('su', 'delete from display_media')
q('su', "update promotions set is_active=false where name like '%%(ทดลอง)'")
q(M, 'update menu_items set is_recommended=true, description=%s where id=%s', ('เผ็ดกำลังดี', KAPRAO))
med = "insert into display_media(restaurant_id, menu_item_id, kind, storage_path, url, sort_order) values (%s,%s,%s,%s,%s,%s) returning id"
check('จอ: เพิ่มวิดีโอที่อัปโหลด', q(M, med, (r1, KAPRAO, 'video', f'{r1}/kaprao.mp4', None, 2))[0] == 'ok')
check('จอ: เพิ่มรูปจากลิงก์ https', q(M, med, (r1, KAPRAO, 'image', None, 'https://example.com/a.jpg', 1))[0] == 'ok')
check('จอ: เพิ่มลิงก์ YouTube (สไลด์โฆษณาร้าน)',
      q(M, med, (r1, None, 'youtube', None, 'https://www.youtube.com/watch?v=SGCANs-B8js', 0))[0] == 'ok')
check('จอ: ลิงก์ YouTube รูปแบบผิดไม่ได้',
      q(M, med, (r1, None, 'youtube', None, 'https://evil.example/watch?v=SGCANs-B8js', 0))[0] == 'err')
check('จอ: ลิงก์ http (ไม่ปลอดภัย) ไม่ได้', q(M, med, (r1, None, 'image', None, 'http://example.com/a.jpg', 0))[0] == 'err')
check('จอ: ลิงก์ javascript: ไม่ได้', q(M, med, (r1, None, 'image', None, 'javascript:alert(1)', 0))[0] == 'err')
check('จอ: ไฟล์อัปโหลดต้องอยู่ในโฟลเดอร์ร้านตัวเอง', q(M, med, (r1, None, 'image', f'{r2}/x.jpg', None, 0))[0] == 'err')
check('จอ: ต้องมีไฟล์หรือลิงก์อย่างใดอย่างหนึ่ง', q(M, med, (r1, None, 'image', f'{r1}/x.jpg', 'https://e.com/x.jpg', 0))[0] == 'err')
check('จอ: ประเภทสื่อต้องเป็น image/video/youtube', q(M, med, (r1, None, 'gif', None, 'https://e.com/x.gif', 0))[0] == 'err')
check('จอ: ผูกสื่อกับเมนูร้านอื่นไม่ได้',
      q(U['other'], med, (r2, KAPRAO, 'image', None, 'https://e.com/x.jpg', 0))[0] == 'err')
check('จอ: พนักงานเพิ่มสื่อไม่ได้', q(U['staff'], med, (r1, None, 'image', None, 'https://e.com/x.jpg', 0))[0] == 'err')
check('จอ: พนักงานไม่เห็นรายการสื่อ', q(U['staff'], 'select count(*) from display_media')[1][0][0] == 0)
check('จอ: คำอธิบายยาวเกิน 200 ตัวไม่ได้',
      q(M, "update menu_items set description=repeat('ก', 201) where id=%s", (KAPRAO,))[0] == 'err')
c = q(None, 'select display_content(%s)', (tok,))
check('จอ: ไม่ล็อกอินเปิดด้วยโทเค็นได้ เห็นเมนูแนะนำ',
      c[0] == 'ok' and [i['name'] for i in c[1][0][0]['items']] == ['ผัดกะเพราหมูสับ'], c)
check('จอ: สื่อหลายชิ้นเรียงตามลำดับ (รูปลิงก์ก่อน วิดีโอทีหลัง)',
      c[0] == 'ok' and [m['kind'] for m in c[1][0][0]['items'][0]['media']] == ['image', 'video'], c)
check('จอ: สไลด์โฆษณาร้านขึ้นจอ', c[0] == 'ok' and [a['kind'] for a in c[1][0][0]['ads']] == ['youtube'], c)
check('จอ: ไม่ส่งข้อมูลอื่นของร้าน (มีแค่ชื่อร้าน เมนู โปร โฆษณา)',
      c[0] == 'ok' and set(c[1][0][0]) == {'restaurant', 'settings', 'items', 'promotions', 'ads'})
check('จอ: ยังไม่ตั้งค่า ได้ค่าว่าง (ใช้ค่าเริ่มต้นที่หน้าจอ)', c[0] == 'ok' and c[1][0][0]['settings'] == {})
st = "insert into display_settings(restaurant_id, settings) values (%s, %s::jsonb) on conflict (restaurant_id) do update set settings = excluded.settings"
check('ตั้งค่าจอ: พนักงานตั้งค่าไม่ได้', q(U['staff'], st, (r1, '{"accent": "#ff0000"}'))[0] == 'err')
check('ตั้งค่าจอ: ร้านอื่นตั้งค่าให้ร้านเราไม่ได้', q(U['other'], st, (r1, '{"accent": "#ff0000"}'))[0] == 'err')
check('ตั้งค่าจอ: ผู้จัดการตั้งค่าได้', q(M, st, (r1, '{"accent": "#16a34a", "theme": "dark"}'))[0] == 'ok')
check('ตั้งค่าจอ: ต้องเป็น object', q(M, st, (r1, '[1, 2]'))[0] == 'err')
check('ตั้งค่าจอ: ใหญ่เกินไม่ได้', q(M, st, (r1, json.dumps({'x': 'ก' * 3000})))[0] == 'err')
check('ตั้งค่าจอ: จอเห็นค่าที่ตั้ง',
      q(None, 'select display_content(%s)', (tok,))[1][0][0]['settings'] == {'accent': '#16a34a', 'theme': 'dark'})
check('โปสเตอร์: เก็บค่าที่ใช้สร้างไว้แก้ต่อได้',
      q(M, med.replace('sort_order)', 'sort_order, poster)').replace('%s) returning', '%s, %s::jsonb) returning'),
        (r1, KAPRAO, 'image', f'{r1}/poster-1.jpg', None, 3, '{"template": "bold", "title": "กะเพรา"}'))[0] == 'ok')
check('โปสเตอร์: ใช้ได้กับรูปเท่านั้น',
      q(M, med.replace('sort_order)', 'sort_order, poster)').replace('%s) returning', '%s, %s::jsonb) returning'),
        (r1, KAPRAO, 'video', f'{r1}/poster-2.mp4', None, 4, '{"template": "bold"}'))[0] == 'err')
q(M, "delete from display_media where storage_path like %s", (f'{r1}/poster-%',))
q(M, 'update display_media set is_active=false where menu_item_id is null')
check('จอ: ปิดสื่อแล้วไม่ขึ้นจอ', q(None, 'select display_content(%s)', (tok,))[1][0][0]['ads'] == [])
check('จอ: โปรที่ใช้ได้ตอนนี้ขึ้นจอ', c[0] == 'ok' and len(c[1][0][0]['promotions']) > 0, c)
q('su', 'update menu_items set is_available=false where id=%s', (KAPRAO,))
check('จอ: เมนูที่หมดไม่ขึ้นจอ', q(None, 'select display_content(%s)', (tok,))[1][0][0]['items'] == [])
q('su', 'update menu_items set is_available=true where id=%s', (KAPRAO,))
check('จอ: โทเค็นผิดได้ null', q(None, 'select display_content(%s)', ('x' * 64,))[1][0][0] is None)
check('จอ: ไม่ล็อกอินอ่านเมนูตรงๆ ไม่ได้', q(None, 'select count(*) from menu_items')[1][0][0] == 0)
tok2 = q(U['owner'], 'select display_rotate_token(%s)', (r1,))[1][0][0]
check('จอ: เปลี่ยนลิงก์แล้วลิงก์เก่าใช้ไม่ได้', tok2 != tok and q(None, 'select display_content(%s)', (tok,))[1][0][0] is None
      and q(None, 'select display_content(%s)', (tok2,))[1][0][0] is not None)
q(U['owner'], 'select display_disable(%s)', (r1,))
check('จอ: ปิดลิงก์แล้วเปิดไม่ได้', q(None, 'select display_content(%s)', (tok2,))[1][0][0] is None)
check('จอ: สิทธิ์อัปโหลดสื่อ เฉพาะโฟลเดอร์ร้านตัวเอง',
      q(M, 'select can_manage_menu_media(%s), can_manage_menu_media(%s), can_manage_menu_media(%s)',
        (f'{r1}/a.jpg', f'{r2}/a.jpg', 'ไม่ใช่uuid/a.jpg'))[1][0] == (True, False, False))
check('จอ: พนักงานอัปโหลดสื่อไม่ได้', q(U['staff'], 'select can_manage_menu_media(%s)', (f'{r1}/a.jpg',))[1][0][0] is False)

# ---------- 9.6) พร้อมเพย์ ใบเสร็จ แต้มสมาชิก (0017) ----------
SET = "insert into shop_settings(restaurant_id, promptpay_id, loyalty_enabled) values (%s, %s, %s) on conflict (restaurant_id) do update set promptpay_id = excluded.promptpay_id, loyalty_enabled = excluded.loyalty_enabled"
check('ตั้งค่าร้าน: ผู้จัดการแก้พร้อมเพย์ไม่ได้ (เจ้าของเท่านั้น)', q(M, SET, (r1, '0812345678', True))[0] == 'err')
check('ตั้งค่าร้าน: พนักงานแก้ไม่ได้', q(U['staff'], SET, (r1, '0812345678', True))[0] == 'err')
check('ตั้งค่าร้าน: เลขพร้อมเพย์ผิดรูปแบบไม่ได้', q(U['owner'], SET, (r1, '12345', True))[0] == 'err')
check('ตั้งค่าร้าน: เจ้าของตั้งพร้อมเพย์ได้', q(U['owner'], SET, (r1, '0812345678', False))[0] == 'ok')
check('ตั้งค่าร้าน: พนักงานอ่านได้ (ใช้ทำ QR)',
      q(U['staff'], 'select promptpay_id from shop_settings where restaurant_id=%s', (r1,))[1] == [('0812345678',)])
check('ตั้งค่าร้าน: ร้านอื่นอ่านไม่ได้', q(U['other'], 'select count(*) from shop_settings where restaurant_id=%s', (r1,))[1][0][0] == 0)

b = served_order(items(2))  # 120
r = q(U['staff'], "select counter_pay_bill(%s, %s::uuid[], null, 'promptpay')", (r1, [str(b)]))
check('รับชำระ: บันทึกวิธีชำระ', r[0] == 'ok' and one('select payment_method from orders where id=%s', (b,)) == 'promptpay', r)
check('รับชำระ: วิธีชำระแปลกๆ ไม่ได้',
      q(U['staff'], "select counter_pay_bill(%s, %s::uuid[], null, 'bitcoin')", (r1, [str(served_order(items(1)))]))[0] == 'err')

mem = "insert into members(restaurant_id, phone, name) values (%s, %s, %s) returning id"
check('สมาชิก: เบอร์ผิดรูปแบบไม่ได้', q(U['staff'], mem, (r1, '12345', 'x'))[0] == 'err')
m1 = q(U['staff'], mem, (r1, '0899999999', 'คุณเอ'))[1][0][0]
check('สมาชิก: เบอร์ซ้ำในร้านเดียวกันไม่ได้', q(U['staff'], mem, (r1, '0899999999', 'ซ้ำ'))[0] == 'err')
check('สมาชิก: สมัครพร้อมแต้มเองไม่ได้',
      q(U['staff'], 'insert into members(restaurant_id, phone, points) values (%s, %s, 999)', (r1, '0811111111'))[0] == 'err')
check('สมาชิก: แก้แต้มตรงๆ ไม่ได้', q(U['staff'], 'update members set points = 999 where id=%s', (m1,))[0] == 'err')
check('สมาชิก: ครัวไม่เห็นสมาชิก', q(U['kitchen'], 'select count(*) from members')[1][0][0] == 0)
check('สมาชิก: ร้านอื่นไม่เห็นสมาชิก', q(U['other'], 'select count(*) from members where restaurant_id=%s', (r1,))[1][0][0] == 0)

PAYM = "select counter_pay_bill(%s, %s::uuid[], null, 'cash', %s, %s)"
check('แต้ม: ปิดระบบแต้มอยู่ ใช้สมาชิกไม่ได้',
      q(U['staff'], PAYM, (r1, [str(served_order(items(1)))], m1, 0))[0] == 'err')
q(U['owner'], SET, (r1, '0812345678', True))
b = served_order(items(4))  # 240 → 24 แต้ม
r = q(U['staff'], PAYM, (r1, [str(b)], m1, 0))
check('แต้ม: จ่าย 240 ได้ 24 แต้ม', r[0] == 'ok' and r[1][0][0]['points_earned'] == 24 and r[1][0][0]['member_points'] == 24, r)
check('แต้ม: บันทึกประวัติ', one("select sum(change) from point_ledger where member_id=%s", (m1,)) == 24)
check('แต้ม: แลกเกินที่มีไม่ได้', q(U['staff'], PAYM, (r1, [str(served_order(items(1)))], m1, 100))[0] == 'err')
check('แต้ม: แลกต่ำกว่าขั้นต่ำ (10) ไม่ได้', q(U['staff'], PAYM, (r1, [str(served_order(items(1)))], m1, 5))[0] == 'err')
check('แต้ม: แลกแต้มต้องมีสมาชิก', q(U['staff'], PAYM, (r1, [str(served_order(items(1)))], None, 10))[0] == 'err')
b1_, b2_ = served_order(items(1)), served_order(items(2))  # 60 + 120 = 180
r = q(U['staff'], PAYM, (r1, [str(b1_), str(b2_)], m1, 20))
check('แต้ม: แลก 20 แต้ม ลด 20 บาท (180 → 160) ได้แต้มใหม่จาก 160 = 16',
      r[0] == 'ok' and float(r[1][0][0]['total']) == 160 and float(r[1][0][0]['points_discount']) == 20
      and r[1][0][0]['member_points'] == 24 - 20 + 16, r)
check('แต้ม: ส่วนลดจากแต้มแบ่งลงทุกออเดอร์ รวมเท่ากับที่แลก',
      one('select sum(points_discount) = 20 and sum(total) = 160 from orders where id = any(%s::uuid[])', ([str(b1_), str(b2_)],)))
rc = q(U['staff'], 'select bill_receipt(%s::uuid[])', ([str(b1_), str(b2_)],))
rj = rc[1][0][0] if rc[0] == 'ok' else {}
check('ใบเสร็จ: รายการ ยอด แต้ม ถูกต้อง และซ่อนเบอร์สมาชิก',
      rc[0] == 'ok' and float(rj['total']) == 160 and float(rj['points_discount']) == 20 and rj['payment_method'] == 'cash'
      and sum(i['quantity'] for i in rj['items']) == 3 and rj['member']['phone'] == '***9999', rc)
check('ใบเสร็จ: ครัวเปิดไม่ได้', q(U['kitchen'], 'select bill_receipt(%s::uuid[])', ([str(b1_)],))[0] == 'err')
check('ใบเสร็จ: ร้านอื่นเปิดไม่ได้', q(U['other'], 'select bill_receipt(%s::uuid[])', ([str(b1_)],))[0] == 'err')
before = one('select points from members where id=%s', (m1,))
q(U['owner'], "update orders set status='cancelled', cancel_reason='ทดสอบคืนแต้ม' where id=%s", (b2_,))
check('แต้ม: ยกเลิกบิลแล้วคืนแต้มที่แลก (+20) และหักแต้มที่ได้ (−16)',
      one('select points from members where id=%s', (m1,)) == before + 20 - 16)
check('แต้ม: พนักงานปรับแต้มเองไม่ได้', q(U['staff'], 'select member_adjust_points(%s, 50, %s)', (m1, 'ให้ฟรี'))[0] == 'err')
check('แต้ม: ผู้จัดการปรับแต้มต้องมีเหตุผล', q(M, 'select member_adjust_points(%s, 50, %s)', (m1, ' '))[0] == 'err')
check('แต้ม: ผู้จัดการปรับแต้มได้ (มีประวัติ)', q(M, 'select member_adjust_points(%s, 50, %s)', (m1, 'ชดเชยอาหารช้า'))[0] == 'ok'
      and one("select count(*) from point_ledger where member_id=%s and reason='adjust'", (m1,)) == 1)
check('แต้ม: ปรับจนติดลบไม่ได้', q(M, 'select member_adjust_points(%s, -100000, %s)', (m1, 'x'))[0] == 'err')

# ---------- 9.7) รายงานรายวัน + ข้อมูลแนะนำโปร (0018) ----------
rep_ = q(M, 'select daily_report(%s)', (r1,))
rj = rep_[1][0][0] if rep_[0] == 'ok' else {}
check('รายงาน: ผู้จัดการเปิดได้ มียอดวันนี้และเมนูขายดี', rep_[0] == 'ok' and rj['orders'] > 0 and len(rj['top_items']) > 0, rep_)
check('รายงาน: แยกวิธีชำระ', rep_[0] == 'ok' and 'promptpay' in rj['payments'], rj.get('payments'))
check('รายงาน: พนักงานเปิดไม่ได้', q(U['staff'], 'select daily_report(%s)', (r1,))[0] == 'err')
check('รายงาน: ร้านอื่นเปิดไม่ได้', q(U['other'], 'select daily_report(%s)', (r1,))[0] == 'err')
check('รายงาน: ผู้ใช้เรียกฟังก์ชันภายในตรงๆ ไม่ได้', q(U['owner'], 'select daily_report_data(%s, current_date)', (r1,))[0] == 'err')
check('รายงาน: รายชื่อผู้รับ LINE เรียกได้เฉพาะระบบ', q(U['owner'], 'select * from daily_report_targets()')[0] == 'err'
      and q('service', 'select count(*) from daily_report_targets()')[0] == 'ok')
check('รายงาน: LINE ID ผิดรูปแบบไม่ได้',
      q(U['owner'], "update shop_settings set line_to='hello' where restaurant_id=%s", (r1,))[0] == 'err')
ins = q(U['owner'], 'select promo_insights(%s, 28)', (r1,))
ij = ins[1][0][0] if ins[0] == 'ok' else {}
check('แนะนำโปร: มียอดตามชั่วโมงและกำไรต่อเมนู', ins[0] == 'ok' and len(ij['hours']) > 0 and 'unit_cost' in ij['items'][0], ins)
check('แนะนำโปร: พนักงานเปิดไม่ได้', q(U['staff'], 'select promo_insights(%s, 28)', (r1,))[0] == 'err')

# ---------- 9.9) สต็อก: yield · ชั่งขาย · สูตรย่อย · ใบรับของ · ส่วนต่าง (0023 -> 0027-0029) ----------
O, K, S_ = U['owner'], U['kitchen'], U['stock']
def ing(name, unit, qty, cost, trim=100, cook=100):
    return one("""insert into ingredients(restaurant_id,name,recipe_unit,unit,quantity_on_hand,cost_per_unit,trim_yield_pct,cook_yield_pct)
                  values (%s,%s,%s,%s,%s,%s,%s,%s) returning id""", (r1, name, unit, unit, qty, cost, trim, cook))
def qty_of(i):
    return float(one('select quantity_on_hand from ingredients where id=%s', (i,)))
def cook(order_id):
    return q(K, "update orders set status='preparing' where id=%s", (order_id,))
def recipe_for(menu_id, name, lines, output=1, unit='จาน'):
    rid_ = one("insert into recipes(restaurant_id,name,menu_item_id,output_qty,output_unit) values (%s,%s,%s,%s,%s) returning id",
               (r1, name, menu_id, output, unit))
    for i_, sub_, qn in lines:
        q('su', 'insert into recipe_lines(recipe_id,ingredient_id,sub_recipe_id,qty) values (%s,%s,%s,%s)', (rid_, i_, sub_, qn))
    return rid_
def menu_cost(menu_id):
    return float(one('select unit_cost from menu_item_costs where menu_item_id=%s', (menu_id,)))

# 1) yield: สูตรกรอกน้ำหนักสุทธิ ระบบตัดดิบ = สุทธิ ÷ (trim x cook)
SHRIMP = ing('กุ้งสด', 'g', 10000, 0.4, 60)
GARLIC_DISH = one("insert into menu_items(restaurant_id,name,price) values (%s,'กุ้งกระเทียม',180) returning id", (r1,))
recipe_for(GARLIC_DISH, 'กุ้งกระเทียม', [(SHRIMP, None, 150)])
o1 = order_as(U['staff'], items(2, GARLIC_DISH))[1][0][0]
cook(o1)
check('yield: ตัดน้ำหนักดิบ = สุทธิ ÷ trim yield (150g x 2 / 60% = 500g)', qty_of(SHRIMP) == 9500, qty_of(SHRIMP))
check('yield: ต้นทุนต่อเมนู = ราคาซื้อ ÷ yield (150 / 60% x 0.4 = 100 บาท)', menu_cost(GARLIC_DISH) == 100, menu_cost(GARLIC_DISH))
check('yield: ตั้ง yield 0 ไม่ได้', q(S_, 'update ingredients set yield_pct=0 where id=%s', (SHRIMP,))[0] == 'err')
check('yield: ตั้ง trim yield เกิน 100 ไม่ได้', q(S_, 'update ingredients set trim_yield_pct=120 where id=%s', (SHRIMP,))[0] == 'err')
check('yield: พนักงานสต็อกแก้ yield ได้ (ค่าแบบเดิม = trim yield)',
      q(S_, 'update ingredients set yield_pct=60, variance_threshold_pct=5 where id=%s', (SHRIMP,))[2] == 1
      and one('select (trim_yield_pct, cook_yield_pct) = (60, 100) from ingredients where id=%s', (SHRIMP,)))
RICE = ing('ข้าวสาร', 'g', 5000, 0.04, 100, 250)
RICE_DISH = one("insert into menu_items(restaurant_id,name,price) values (%s,'ข้าวเปล่า',10) returning id", (r1,))
recipe_for(RICE_DISH, 'ข้าวเปล่า', [(RICE, None, 250)])
cook(order_as(U['staff'], items(1, RICE_DISH))[1][0][0])
check('cook yield: ข้าวสุก 250g / 250% = ข้าวสาร 100g · ต้นทุน 4 บาท', qty_of(RICE) == 4900 and menu_cost(RICE_DISH) == 4,
      (qty_of(RICE), menu_cost(RICE_DISH)))

# 2) ขายตามน้ำหนักจริง (หน่วยฐานกรัม)
CRAB = ing('ปูม้าเป็น', 'g', 20000, 0.35)
CRAB_MENU = one("insert into menu_items(restaurant_id,name,price,sold_by_weight,weight_ingredient_id) values (%s,'ปูม้านึ่ง (ชั่ง)',800,true,%s) returning id", (r1, CRAB))
wo = order_as(U['staff'], json.dumps([{"menu_item_id": str(CRAB_MENU), "quantity": 3, "weight_g": 1250}]))
check('ชั่งขาย: รับออเดอร์พร้อมน้ำหนักได้', wo[0] == 'ok', wo)
WO = wo[1][0][0]
li = q('su', 'select quantity, unit_price, weight_g from order_items where order_id=%s', (WO,))[1][0]
check('ชั่งขาย: ราคา = ราคาต่อ กก. x น้ำหนัก (800 x 1.25 = 1000) และนับเป็น 1 บรรทัด', li[0] == 1 and float(li[1]) == 1000 and float(li[2]) == 1250, li)
check('ชั่งขาย: ยอดออเดอร์ถูกต้อง', float(one('select total from orders where id=%s', (WO,))) == 1000)
cook(WO)
check('ชั่งขาย: ตัดสต็อกตามน้ำหนักจริง ไม่หาร yield (20000 - 1250 = 18750 g)', qty_of(CRAB) == 18750, qty_of(CRAB))
check('ชั่งขาย: ไม่ใส่น้ำหนักไม่ได้',
      order_as(U['staff'], json.dumps([{"menu_item_id": str(CRAB_MENU), "quantity": 1}]))[0] == 'err')
check('ชั่งขาย: น้ำหนักติดลบไม่ได้',
      order_as(U['staff'], json.dumps([{"menu_item_id": str(CRAB_MENU), "quantity": 1, "weight_g": -5}]))[0] == 'err')
nw = order_as(U['staff'], json.dumps([{"menu_item_id": str(GARLIC_DISH), "quantity": 1, "weight_g": 999}]))
check('ชั่งขาย: เมนูปกติไม่สนน้ำหนักที่ส่งมา', nw[0] == 'ok'
      and one('select weight_g is null and unit_price = 180 from order_items where order_id=%s', (nw[1][0][0],)))

# 3) สูตรย่อย (สูตรซ้อน) แทนของเตรียมแบบผลิตทีละถัง
LIME = ing('มะนาว', 'g', 5000, 0.08, 40)
CHILI = ing('พริกขี้หนู', 'g', 2000, 0.2)
sr = q(S_, "insert into recipes(restaurant_id,name,output_qty,output_unit) values (%s,'น้ำจิ้มซีฟู้ด',5000,'g') returning id", (r1,))
check('สูตรย่อย: พนักงานสต็อกสร้างได้ (output 5000 g ต่อหม้อ)', sr[0] == 'ok', sr)
SAUCE = sr[1][0][0]
check('สูตรย่อย: ใส่วัตถุดิบได้',
      q(S_, 'insert into recipe_lines(recipe_id,ingredient_id,qty) values (%s,%s,1000),(%s,%s,300)', (SAUCE, LIME, SAUCE, CHILI))[0] == 'ok')
check('สูตรย่อย: วัตถุดิบข้ามร้านไม่ได้', q(S_, 'insert into recipe_lines(recipe_id,ingredient_id,qty) values (%s,%s,1)', (SAUCE, ing2))[0] == 'err')
check('สูตรย่อย: บรรทัดต้องเป็นวัตถุดิบหรือสูตรย่อยอย่างใดอย่างหนึ่ง',
      q(S_, 'insert into recipe_lines(recipe_id,ingredient_id,sub_recipe_id,qty) values (%s,%s,%s,1)', (SAUCE, LIME, SAUCE))[0] == 'err')
BASE = one("insert into recipes(restaurant_id,name,output_qty,output_unit) values (%s,'ซอสฐาน',1000,'g') returning id", (r1,))
q(S_, 'insert into recipe_lines(recipe_id,sub_recipe_id,qty) values (%s,%s,100)', (BASE, SAUCE))
check('สูตรซ้อน: วนกลับหาตัวเองไม่ได้', q(S_, 'insert into recipe_lines(recipe_id,sub_recipe_id,qty) values (%s,%s,1)', (SAUCE, BASE))[0] == 'err')
check('สูตรซ้อน: ใช้สูตรของเมนูเป็นสูตรย่อยไม่ได้',
      q(S_, 'insert into recipe_lines(recipe_id,sub_recipe_id,qty) values (%s,%s,1)',
        (SAUCE, one('select id from recipes where menu_item_id=%s', (GARLIC_DISH,))))[0] == 'err')
check('ของเตรียม: ผลิตแยกไม่ได้แล้ว (ใช้สูตรย่อย)', q(K, "select produce_prep(%s, 2500, 'ถังเช้า')", (LIME,))[0] == 'err')
check('ของเตรียม: บันทึกรอบผลิตเองไม่ได้', q(K, "insert into prep_batches(restaurant_id,prep_id,output_qty) values (%s,%s,1)", (r1, LIME))[0] == 'err')
CRAB_RECIPE = recipe_for(CRAB_MENU, 'ปูม้านึ่ง (ชั่ง)', [(None, SAUCE, 30)], unit='ถ้วย')
# ต้นทุนน้ำจิ้มต่อ g = (1000 / 40% x 0.08 + 300 x 0.2) / 5000 = 0.052 · ต่อถ้วย 30 g = 1.56
check('สูตรซ้อน: ต้นทุนสูตรแม่รวมสูตรย่อย (30 g x 0.052 = 1.56)', menu_cost(CRAB_MENU) == 1.56, menu_cost(CRAB_MENU))
wo2 = order_as(U['staff'], json.dumps([{"menu_item_id": str(CRAB_MENU), "quantity": 1, "weight_g": 800}]))[1][0][0]
cook(wo2)
# ตัดดิบตอนขาย: มะนาว 30/5000 x 1000 / 40% = 15 g · พริก 30/5000 x 300 = 1.8 g · ปูตามน้ำหนัก 800 g
check('สูตรซ้อน: ขายแล้วตัดวัตถุดิบดิบผ่านสูตรย่อย และตัดปูตามน้ำหนัก',
      (qty_of(LIME), qty_of(CHILI), qty_of(CRAB)) == (4985, 1998.2, 17950), (qty_of(LIME), qty_of(CHILI), qty_of(CRAB)))

# 4) ใบรับของ -> ล็อต (FIFO) + ราคาซื้อล่าสุด -> คำนวณต้นทุนสูตรใหม่ รวมสูตรแม่
rc = q(S_, "select submit_stock_receipt(%s, %s::jsonb, 'แพปลาสมชาย', 'INV-001', current_date, null, true)",
       (r1, json.dumps([{"ingredient_id": str(CRAB), "pack_qty": 2, "pack_size": 5000, "pack_price": 2000, "expiry_date": "2099-01-01"}])))
check('รับของ: พนักงานสต็อกบันทึกใบรับของแบบแพ็คได้', rc[0] == 'ok', rc)
RC = rc[1][0][0]
check('รับของ: เพิ่มสต็อก 2 แพ็ค x 5000 g', qty_of(CRAB) == 27950, qty_of(CRAB))
check('รับของ: สร้างล็อตพร้อมวันหมดอายุและต้นทุนต่อหน่วย (2000 / 5000 = 0.4)',
      one("select (qty, raw_unit_cost, expiry_date::text) = (10000, 0.4, '2099-01-01') from stock_lots where receipt_id=%s", (RC,)))
fifo = round((17950 * 0.35 + 10000 * 0.4) / 27950, 7)
check('รับของ: ต้นทุนในระบบ = เฉลี่ยของชั้น FIFO ที่เหลือ', float(one('select cost_per_unit from ingredients where id=%s', (CRAB,))) == fifo)
check('รับของ: บันทึกเป็นรายจ่ายค่าวัตถุดิบ 4,000 บาท',
      float(one("select e.amount from stock_receipts r join expenses e on e.id = r.expense_id where r.id=%s", (RC,))) == 4000)
check('รับของ: ประวัติสต็อกผูกกับใบรับของ (ประเภท receive)', one("select count(*) from stock_movements where receipt_id=%s and type='receive'", (RC,)) == 1)
check('รับของ: บัญชีบันทึกไม่ได้แต่อ่านได้',
      q(U['acc'], "select submit_stock_receipt(%s, %s::jsonb)", (r1, json.dumps([{"ingredient_id": str(CRAB), "quantity": 1, "unit_cost": 1}])))[0] == 'err'
      and q(U['acc'], 'select count(*) from stock_receipt_lines where receipt_id=%s', (RC,))[1][0][0] == 1)
check('รับของ: จำนวน 0 ไม่ได้',
      q(S_, "select submit_stock_receipt(%s, %s::jsonb)", (r1, json.dumps([{"ingredient_id": str(CRAB), "quantity": 0, "unit_cost": 1}])))[0] == 'err')
check('รับของ: ราคาติดลบไม่ได้',
      q(S_, "select submit_stock_receipt(%s, %s::jsonb)", (r1, json.dumps([{"ingredient_id": str(CRAB), "quantity": 1, "unit_cost": -1}])))[0] == 'err')
check('รับของ: วันหมดอายุก่อนวันรับไม่ได้',
      q(S_, "select submit_stock_receipt(%s, %s::jsonb)", (r1, json.dumps([{"ingredient_id": str(CRAB), "quantity": 1, "unit_cost": 1, "expiry_date": "2000-01-01"}])))[0] == 'err')
check('รับของ: วัตถุดิบร้านอื่นไม่ได้',
      q(S_, "select submit_stock_receipt(%s, %s::jsonb)", (r1, json.dumps([{"ingredient_id": str(ing2), "quantity": 1, "unit_cost": 1}])))[0] == 'err')
check('รับของ: แก้ใบรับของไม่ได้', q(S_, 'update stock_receipts set total_cost=0 where id=%s', (RC,))[0] == 'err')
check('รับของ: แก้ล็อตตรงไม่ได้', q(S_, 'update stock_lots set qty_remaining=0 where receipt_id=%s', (RC,))[2] == 0)
rl = q(S_, "select stock_receive(%s, null, %s::jsonb)", (r1, json.dumps([{"ingredient_id": str(LIME), "quantity": 1000, "unit_cost": 0.1}])))
# มะนาว 0.08 -> 0.10: น้ำจิ้มต่อ g = (1000 / 40% x 0.10 + 60) / 5000 = 0.062 · ปูนึ่ง 30 g = 1.86 · ซอสฐาน (ใช้น้ำจิ้ม) ก็คำนวณใหม่
check('ราคาเปลี่ยน: คำนวณต้นทุนสูตรย่อยและสูตรแม่ใหม่ (1.56 -> 1.86)', rl[0] == 'ok' and menu_cost(CRAB_MENU) == 1.86, (rl, menu_cost(CRAB_MENU)))
check('ราคาเปลี่ยน: รายงานจำนวนสูตรที่คำนวณใหม่ (น้ำจิ้ม ซอสฐาน ปูนึ่ง)', rl[0] == 'ok' and rl[1][0][0]['recosted_recipes'] == 3, rl)
check('รับเข้าครั้งแรก: ยังไม่มีใบรับก่อนหน้า จึงไม่เตือน', rl[0] == 'ok' and rl[1][0][0]['warnings'] == [], rl)
rl2 = q(S_, "select stock_receive(%s, null, %s::jsonb)", (r1, json.dumps([{"ingredient_id": str(LIME), "pack_qty": 1, "pack_size": 500, "pack_price": 60}])))
w2 = rl2[1][0][0]['warnings'] if rl2[0] == 'ok' else []
check('รับเข้า: เตือนเมื่อราคาต่อหน่วยเปลี่ยนจากครั้งก่อน (0.10 -> 0.12 = +20%)',
      len(w2) == 1 and float(w2[0]['price_change_pct']) == 20, rl2)

# 5) ไม่มีของเสียแยก
check('ของเสีย: บันทึกแยกไม่ได้ (ไปโผล่เป็นส่วนต่างตอนนับ)',
      q(K, "insert into stock_movements(restaurant_id,ingredient_id,change,reason,waste_type,note) values (%s,%s,-500,'waste','spoiled','ปูตาย')", (r1, CRAB))[0] == 'err')

# 6) ส่วนต่างตอนนับ (Actual vs Theoretical)
def count_now(lines):
    return q(S_, "select submit_stock_count(%s, %s::jsonb)", (r1, json.dumps(lines)))[1][0][0]
# ในชุดทดสอบ now() เท่ากันทั้งธุรกรรม: ย้อนเวลารายการก่อนหน้าให้อยู่ก่อนใบต้นงวด (ledger แก้ไม่ได้ ปิด guard ชั่วคราว)
q('su', 'alter table stock_movements disable trigger stock_movements_guard')
q('su', "update stock_movements set created_at = now() - interval '8 days' where restaurant_id=%s", (r1,))
q('su', 'alter table stock_movements enable trigger stock_movements_guard')
C_A = count_now([{"ingredient_id": str(CRAB), "counted_qty": 27000}, {"ingredient_id": str(SHRIMP), "counted_qty": 9500}])
q('su', "update stock_counts set created_at = now() - interval '7 days' where id=%s", (C_A,))
# ระหว่างรอบ: รับปู 10000 g · ชั่งขายปู 2000 + 1000 g · กุ้งกระเทียม 4 จาน (ดิบ 1000 g)
q(S_, "select submit_stock_receipt(%s, %s::jsonb, 'แพปลา', 'INV-002', current_date, null, false)",
  (r1, json.dumps([{"ingredient_id": str(CRAB), "quantity": 10000, "unit_cost": 0.4}])))
for g in (2000, 1000):
    cook(order_as(U['staff'], json.dumps([{"menu_item_id": str(CRAB_MENU), "quantity": 1, "weight_g": g}]))[1][0][0])
cook(order_as(U['staff'], items(4, GARLIC_DISH))[1][0][0])
# นับรอบนี้ (blind): ปูเหลือ 30000 g · กุ้งเหลือ 8450 g
C_B = count_now([{"ingredient_id": str(CRAB), "counted_qty": 30000, "note": "ปูตายระหว่างสัปดาห์"},
                 {"ingredient_id": str(SHRIMP), "counted_qty": 8450}])
var = q(U['acc'], """select ingredient_name, opening_qty, received_qty, deducted_qty, expected_qty, counted_qty,
                            variance_qty, variance_pct, color, note from stock_variance_report(%s,%s)""", (r1, C_B))
check('ส่วนต่าง: บัญชีเปิดรายงานได้', var[0] == 'ok' and len(var[1]) == 2, var)
vr = {r[0]: r for r in var[1]} if var[0] == 'ok' else {}
crab = vr.get('ปูม้าเป็น')
# ปู: ควรเหลือ = นับรอบก่อน 27000 + นำเข้า 10000 − ตัดตามสูตร 3000 = 34000 · นับจริง 30000 -> ส่วนต่าง −4000 (−11.76%) แดง
check('ส่วนต่าง: ยอดที่ควรเหลือ = นับรอบก่อน + นำเข้า − ตัดตามสูตร (27000 + 10000 − 3000)',
      crab and [float(x) for x in crab[1:5]] == [27000, 10000, 3000, 34000], crab)
check('ส่วนต่าง: นับจริง − ควรเหลือ = −4000 (−11.76%) -> แดง พร้อมเหตุผลที่กรอก',
      crab and float(crab[6]) == -4000 and float(crab[7]) == -11.76 and crab[8] == 'red' and crab[9] == 'ปูตายระหว่างสัปดาห์', crab)
shrimp = vr.get('กุ้งสด')
# กุ้ง: ควรเหลือ 9500 − 1000 = 8500 · นับ 8450 -> −50 (−0.59%) เขียว
check('ส่วนต่าง: กุ้ง −50 g (−0.59%) -> เขียว', shrimp and float(shrimp[4]) == 8500 and float(shrimp[6]) == -50 and shrimp[8] == 'green', shrimp)
check('ส่วนต่าง: เรียงตามมูลค่า (ปูมาก่อน)', var[0] == 'ok' and var[1][0][0] == 'ปูม้าเป็น')
check('ส่วนต่าง: หน้าร้านเปิดไม่ได้', q(U['staff'], 'select count(*) from stock_variance_report(%s,%s)', (r1, C_B))[0] == 'err')
check('ส่วนต่าง: ใช้ใบนับร้านอื่นไม่ได้', q(U['other'], 'select count(*) from stock_variance_report(%s,%s)', (r2, C_B))[0] == 'err')
check('ใบนับ: ผู้นับรับรองใบของตัวเองไม่ได้ (พนักงานสต็อกไม่มีสิทธิ์รับรอง)', q(S_, 'select verify_stock_count(%s)', (C_B,))[0] == 'err')
check('ใบนับ: ผู้จัดการรับรองได้', q(M, 'select verify_stock_count(%s)', (C_B,))[0] == 'ok'
      and one('select verified_by from stock_counts where id=%s', (C_B,)) == M)
check('ใบนับ: รับรองซ้ำไม่ได้', q(O, 'select verify_stock_count(%s)', (C_B,))[0] == 'err')

# ---------- 9.95) หน่วยนับ (0024) ----------
check('หน่วย: ร้านมีหน่วยเริ่มต้น (kg, ลัง ...)', one("select count(*) from units where restaurant_id=%s and name in ('kg','ลัง','ตัว')", (r1,)) == 3)
r3 = one("insert into restaurants(name) values ('ร้านใหม่ทดสอบหน่วย') returning id")
check('หน่วย: ร้านใหม่ได้หน่วยเริ่มต้นอัตโนมัติ', one("select count(*) from units where restaurant_id=%s", (r3,)) == 12)
q('su', 'delete from restaurants where id=%s', (r3,))
check('หน่วย: พนักงานสต็อกเพิ่มหน่วยได้', q(S_, "insert into units(restaurant_id,name) values (%s,'เข่ง')", (r1,))[0] == 'ok')
check('หน่วย: ชื่อซ้ำไม่ได้ (ไม่สนตัวพิมพ์)', q(S_, "insert into units(restaurant_id,name) values (%s,' KG ')", (r1,))[0] == 'err')
check('หน่วย: หน้าร้านเพิ่มไม่ได้', q(U['staff'], "insert into units(restaurant_id,name) values (%s,'ถาด')", (r1,))[0] == 'err')
check('หน่วย: ผู้จัดการอ่านได้', q(M, 'select count(*) from units where restaurant_id=%s', (r1,))[1][0][0] > 0)
check('หน่วยแปลง: กุ้ง 1 ลัง = 10000 g', q(S_, "insert into ingredient_units(ingredient_id,unit_name,factor) values (%s,'ลัง',10000)", (SHRIMP,))[0] == 'ok')
check('หน่วยแปลง: ซ้ำกับหน่วยหลักไม่ได้', q(S_, "insert into ingredient_units(ingredient_id,unit_name,factor) values (%s,'g',1)", (SHRIMP,))[0] == 'err')
check('หน่วยแปลง: ตัวคูณ 0 ไม่ได้', q(S_, "insert into ingredient_units(ingredient_id,unit_name,factor) values (%s,'ถุง',0)", (SHRIMP,))[0] == 'err')
check('หน่วยแปลง: ร้านอื่นแก้ไม่ได้', q(U['other'], "insert into ingredient_units(ingredient_id,unit_name,factor) values (%s,'ถุง',1)", (SHRIMP,))[0] == 'err')
check('หน่วยแปลง: ครัวอ่านไม่ได้ (0030: ข้อมูลสต็อกเฉพาะ owner / manager / stock / บัญชี)', q(K, 'select count(*) from ingredient_units where ingredient_id=%s', (SHRIMP,))[1][0][0] == 0)
ru = q(S_, "select submit_stock_receipt(%s, %s::jsonb, 'แพ', 'INV-U', current_date, null, false)",
       (r1, json.dumps([{"ingredient_id": str(SHRIMP), "quantity": 30000, "unit_cost": 0.04, "entered_unit": "ลัง", "entered_qty": 3, "entered_unit_cost": 400}])))
check('รับของด้วยหน่วยแปลง: บันทึกได้', ru[0] == 'ok', ru)
rl = q('su', 'select quantity, entered_unit, entered_qty, entered_unit_cost from stock_receipt_lines where receipt_id=%s', (ru[1][0][0],))[1][0]
check('รับของด้วยหน่วยแปลง: เก็บทั้งหน่วยหลัก (30000 g) และที่กรอก (3 ลัง @ 400)',
      float(rl[0]) == 30000 and rl[1] == 'ลัง' and float(rl[2]) == 3 and float(rl[3]) == 400, rl)
cu = q(S_, "select submit_stock_count(%s, %s::jsonb)", (r1, json.dumps([{"ingredient_id": str(SHRIMP), "counted_qty": 23500, "entered_text": "2 ลัง + 3500 g"}])))
check('ตรวจนับด้วยหน่วยแปลง: เก็บข้อความที่กรอก',
      cu[0] == 'ok' and one('select entered_text from stock_count_lines where count_id=%s', (cu[1][0][0],)) == '2 ลัง + 3500 g', cu)

# ---------- 9.97) นับตอนรับเข้า (0025) ----------
FROZEN = ing('กุ้งแช่แข็ง', 'g', 0, 0)   # 0027: หน่วยฐานเป็นกรัม
LEMON = ing('มะนาวลูก', 'g', 0, 0)
def receive(lines, supplier='แพปลาสมชาย', inv='INV-0412', expense=True, who=None):
    return q(who or S_, "select submit_stock_receipt(%s, %s::jsonb, %s, %s, current_date, null, %s)",
             (r1, json.dumps(lines), supplier, inv, expense))
rv = receive([
    {"ingredient_id": str(FROZEN), "quantity": 25400, "unit_cost": 0.04, "invoice_qty": 30000, "invoice_unit": "ลัง", "invoice_unit_qty": 3, "gross_qty": 30200},
    {"ingredient_id": str(CRAB), "quantity": 19700, "unit_cost": 0.35, "invoice_qty": 20000},
    {"ingredient_id": str(LEMON), "quantity": 0, "unit_cost": 0.03, "invoice_qty": 10000, "note": "เน่า ตีกลับ"},
])
check('รับเข้า: บันทึกใบรับของแบบตามบิล/รับจริงได้', rv[0] == 'ok', rv)
RV = rv[1][0][0]
def line(i):
    return q('su', "select status, claim_value, claim_status, invoice_qty, gross_qty from stock_receipt_lines where receipt_id=%s and ingredient_id=%s", (RV, i))[1][0]
fl, cl, ll = line(FROZEN), line(CRAB), line(LEMON)
check('รับเข้า: กุ้งขาด 4.6 kg เกินเกณฑ์ 2% -> ขาด รอทวง 184 บาท', fl[0] == 'short' and float(fl[1]) == 184 and fl[2] == 'pending', fl)
check('รับเข้า: ปูขาด 1.5% อยู่ในเกณฑ์ -> ตรง ไม่มียอดทวง', cl[0] == 'ok' and float(cl[1]) == 0 and cl[2] == 'none', cl)
check('รับเข้า: รับ 0 = ตีกลับ ทวงเต็มบิล 300 บาท', ll[0] == 'rejected' and float(ll[1]) == 300, ll)
check('รับเข้า: สต็อกเพิ่มตามรับจริง (กุ้ง 25400g · มะนาว 0)', qty_of(FROZEN) == 25400 and qty_of(LEMON) == 0)
check('รับเข้า: ตีกลับไม่ลงประวัติสต็อก', one("select count(*) from stock_movements where receipt_id=%s and ingredient_id=%s", (RV, LEMON)) == 0)
hd = q('su', "select invoice_total, total_cost, claim_total, (select amount from expenses where id=expense_id) from stock_receipts where id=%s", (RV,))[1][0]
check('รับเข้า: ยอดบิล 8,500 · รับจริง 7,911 · รอทวง 484 · รายจ่ายตามบิล',
      float(hd[0]) == 8500 and float(hd[1]) == round(25400 * 0.04 + 19700 * 0.35, 2) and float(hd[2]) == 484 and float(hd[3]) == 8500, hd)
check('รับเข้า: ต้นทุนวัตถุดิบ = ราคาบิลต่อหน่วยที่รับจริง', float(one('select cost_per_unit from ingredients where id=%s', (FROZEN,))) == 0.04)
check('รับเข้า: น้ำหนักรวมน้อยกว่าสุทธิไม่ได้',
      receive([{"ingredient_id": str(FROZEN), "quantity": 10000, "unit_cost": 0.04, "gross_qty": 9000}])[0] == 'err')
check('รับเข้า: ตามบิล 0 และรับ 0 ไม่ได้',
      receive([{"ingredient_id": str(FROZEN), "quantity": 0, "unit_cost": 0.04, "invoice_qty": 0}])[0] == 'err')
check('ทวง: ได้ลดหนี้ -> หักรายจ่ายและยอดรอทวง',
      q(S_, "select set_receipt_claim(%s, %s, 'credited')", (RV, FROZEN))[0] == 'ok'
      and float(one('select amount from expenses where id=(select expense_id from stock_receipts where id=%s)', (RV,))) == 8316
      and float(one('select claim_total from stock_receipts where id=%s', (RV,))) == 300)
check('ทวง: ยอมรับ ไม่ทวง -> ยอดรอทวงหมด',
      q(U['acc'], "select set_receipt_claim(%s, %s, 'accepted')", (RV, LEMON))[0] == 'ok'
      and float(one('select claim_total from stock_receipts where id=%s', (RV,))) == 0)
check('ทวง: บรรทัดที่ไม่มียอดขาดเปลี่ยนไม่ได้', q(S_, "select set_receipt_claim(%s, %s, 'credited')", (RV, CRAB))[0] == 'err')
check('ทวง: หน้าร้านเปลี่ยนไม่ได้', q(U['staff'], "select set_receipt_claim(%s, %s, 'pending')", (RV, LEMON))[0] == 'err')
# ราคาขึ้นจากครั้งก่อน (ผู้ขายเดิม)
rv2 = receive([{"ingredient_id": str(FROZEN), "quantity": 10000, "unit_cost": 0.046, "invoice_qty": 10000, "gross_qty": 11000}], inv='INV-0413')
check('รับเข้า: จำราคาครั้งก่อนของผู้ขายเดิม', rv2[0] == 'ok'
      and float(one('select prev_unit_cost from stock_receipt_lines where receipt_id=%s', (rv2[1][0][0],))) == 0.04
      and float(one('select price_change_pct from stock_receipt_lines where receipt_id=%s', (rv2[1][0][0],))) == 15)
rep_s = q(U['acc'], "select supplier, invoice_value, claim_pending, claim_credited, gap_pct, short_lines, rejected_lines, glaze_pct, glaze_over_lines, price_up_lines from supplier_receiving_report(%s, current_date - 1, current_date) where supplier='แพปลาสมชาย'", (r1,))
check('รายงานผู้ขาย: บัญชีเปิดได้', rep_s[0] == 'ok' and len(rep_s[1]) == 1, rep_s)
sr = rep_s[1][0] if rep_s[0] == 'ok' and rep_s[1] else None
# กุ้ง: รวม 30.2+11 = 41.2 สุทธิ 25.4+10 = 35.4 -> น้ำแข็ง 14.08% · ใบแรก 15.89% เกิน 12% · ใบสอง 9.09%
check('รายงานผู้ขาย: % น้ำแข็งถ่วงน้ำหนัก และนับครั้งที่เกินเกณฑ์', sr and float(sr[7]) == 14.08 and sr[8] == 1, sr)
check('รายงานผู้ขาย: นับครั้งที่ขาด/ตีกลับ/ราคาขึ้นเกิน 10%', sr and sr[5] == 1 and sr[6] == 1 and sr[9] == 1, sr)
check('รายงานผู้ขาย: หน้าร้านเปิดไม่ได้', q(U['staff'], "select count(*) from supplier_receiving_report(%s, current_date - 1, current_date)", (r1,))[0] == 'err')
# ใบตรวจนับ รายสัปดาห์ / รายเดือน
wk = q(S_, "select submit_stock_count(%s, %s::jsonb, 'สัปดาห์ที่ 4', 'weekly')", (r1, json.dumps([{"ingredient_id": str(FROZEN), "counted_qty": 35000}])))
check('ตรวจนับ: บันทึกแบบรายสัปดาห์ได้', wk[0] == 'ok' and one('select count_type from stock_counts where id=%s', (wk[1][0][0],)) == 'weekly', wk)
check('ตรวจนับ: ประเภทที่ไม่รู้จักไม่ได้', q(S_, "select submit_stock_count(%s, %s::jsonb, null, 'hourly')", (r1, json.dumps([{"ingredient_id": str(FROZEN), "counted_qty": 35000}])))[0] == 'err')
check('วัตถุดิบ: ติ๊กนับทุกสัปดาห์ได้', q(S_, 'update ingredients set count_weekly=true where id=%s', (FROZEN,))[2] == 1)
q('su', "update stock_receipts set created_at = now() - interval '1 hour' where id=%s", (RV,))  # now() เท่ากันทั้งธุรกรรม
la = q(S_, 'select received_qty, received_invoice_qty, received_status, counted_qty, count_diff from ingredient_last_activity(%s) where ingredient_id=%s', (r1, FROZEN))
check('สรุป: รับเข้าล่าสุด / นับล่าสุดต่อวัตถุดิบ', la[0] == 'ok' and float(la[1][0][0]) == 10000 and la[1][0][2] == 'ok'
      and float(la[1][0][3]) == 35000 and float(la[1][0][4]) == -400, la)
check('สรุป: หน้าร้านไม่เห็นวัตถุดิบ', q(U['staff'], 'select count(*) from ingredient_last_activity(%s)', (r1,))[1][0][0] == 0)
check('ตั้งค่า: เจ้าของตั้งเกณฑ์รับของและ % น้ำแข็งได้',
      q(O, "insert into shop_settings(restaurant_id, receive_tolerance_pct, glaze_max_pct) values (%s, 3, 10) on conflict (restaurant_id) do update set receive_tolerance_pct=3, glaze_max_pct=10", (r1,))[0] == 'ok')

# ---------- 10) Realtime ----------
check('realtime: ตาราง menu_items อยู่ใน publication (หน้ารับออเดอร์เห็นเมนูหมดทันที)',
      one("select count(*) from pg_publication_tables where pubname='supabase_realtime' and tablename='menu_items'") == 1)
check('realtime: ตาราง orders อยู่ใน publication',
      one("select count(*) from pg_publication_tables where pubname='supabase_realtime' and tablename='orders'") == 1)

check('realtime: ตาราง order_items อยู่ใน publication (ครัวหลายเครื่องเห็นติ๊กเสร็จตรงกัน)',
      one("select count(*) from pg_publication_tables where pubname='supabase_realtime' and tablename='order_items'") == 1)
# ---------- 11) บัญชีคู่ (0026): ทุกเหตุการณ์ข้างบนลงบัญชีอัตโนมัติ ----------
r = q('su', 'set constraints all immediate')
check('บัญชี: ทุกรายการที่ลงอัตโนมัติระหว่างทดสอบ เดบิต = เครดิต', r[0] == 'ok', r)
rec = one('select acct_stock_reconcile_data(%s)', (r1,))
check('บัญชี: บัญชีสต็อก = มูลค่าในโมดูลสต็อก หลังทดสอบสต็อกทั้งหมด', rec['ok'], rec)

tx.rollback()
passed, total = sum(results), len(results)
print(f'\nสรุป: ผ่าน {passed}/{total}')
sys.exit(0 if passed == total else 1)
