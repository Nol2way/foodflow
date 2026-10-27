"""ทดสอบโมดูลสต็อกวัตถุดิบ (0027-0030) บน Postgres จริง

ครอบคลุม: ledger (ยอด = ผลรวมรายการ = ผลรวมล็อต) · FEFO/FIFO · คืนสต็อกลงล็อตเดิม · กลับรายการ · append-only
         · ไม่ติดลบ + ปิด/เปิดเมนูอัตโนมัติ · นับแบบ blind + AvT + สี + ติดลบต่อเนื่อง 3 รอบ · ผู้ตรวจรับรอง
         · yield test · par / แนะนำสั่ง · ภาพรวม · สิทธิ์รายร้าน/รายบทบาท · seed ทดลอง
         · ย้ายข้อมูลเดิม (kg -> g, ของเตรียม -> สูตรย่อย, ของเสีย -> legacy) โดยมูลค่าและบัญชีไม่เปลี่ยน

วิธีรัน:
  pip install pixeltable-pgserver "psycopg[binary]"
  python database/tests/test_stock.py
"""
import itertools
import json
import pathlib
import tempfile
import uuid

try:
    import pgserver
except ImportError:
    import pixeltable_pgserver as pgserver
import psycopg

from harness import ROOT, STUB, Runner, files, start

srv, uri, admin = start()
T = Runner(uri)
q, one, check = T.q, T.one, T.check

# ---------- เตรียมข้อมูล ----------
r1 = one("select id from restaurants order by created_at limit 1")
table1 = one("select id from dining_tables where restaurant_id=%s order by label limit 1", (r1,))
MENU = {n: i for i, n in q('su', "select id, name from menu_items where restaurant_id=%s", (r1,))[1]}
ING = {n: i for i, n in q('su', "select id, name from ingredients where restaurant_id=%s", (r1,))[1]}

U = {k: uuid.uuid4() for k in ['owner', 'mgr', 'acc', 'staff', 'kitchen', 'stock', 'other']}
for u in U.values():
    q('su', 'insert into app_users(id, email) values (%s, %s)', (u, f'{u}@test.local'))
r2 = one("insert into restaurants(name) values ('ร้านอื่น') returning id")
for k, rid, role in [('owner', r1, 'owner'), ('mgr', r1, 'manager'), ('acc', r1, 'accountant'), ('staff', r1, 'staff'),
                     ('kitchen', r1, 'kitchen'), ('stock', r1, 'stock'), ('other', r2, 'owner')]:
    q('su', 'insert into staff_members(user_id, restaurant_id, role) values (%s,%s,%s)', (U[k], rid, role))
O, M, A, S, K, ST, X = (U[k] for k in ['owner', 'mgr', 'acc', 'staff', 'kitchen', 'stock', 'other'])


def ing(name, qty=0, cost=0, unit='g', **kw):
    cols = {'restaurant_id': r1, 'name': name, 'recipe_unit': unit, 'unit': unit, 'quantity_on_hand': qty, 'cost_per_unit': cost, **kw}
    sql = f"insert into ingredients({','.join(cols)}) values ({','.join(['%s'] * len(cols))}) returning id"
    return one(sql, tuple(cols.values()))


def qty(i):
    return float(one('select quantity_on_hand from ingredients where id=%s', (i,)))


def menu_with(name, lines, price=50):
    m = one("insert into menu_items(restaurant_id,name,price) values (%s,%s,%s) returning id", (r1, name, price))
    rec = one("insert into recipes(restaurant_id,name,menu_item_id) values (%s,%s,%s) returning id", (r1, name, m))
    for i, n in lines:
        q('su', 'insert into recipe_lines(recipe_id,ingredient_id,qty) values (%s,%s,%s)', (rec, i, n))
    return m


def order(menu_id, n=1):
    r = q(S, "select staff_place_order(%s, %s::jsonb, %s)", (r1, json.dumps([{"menu_item_id": str(menu_id), "quantity": n}]), table1))
    assert r[0] == 'ok', r
    return r[1][0][0]


def start_cooking(oid):
    return q(K, "update orders set status='preparing' where id=%s", (oid,))


def receive(lines, who=ST, supplier=None):
    return q(who, "select stock_receive(%s, %s, %s::jsonb, null, null, null, false)", (r1, supplier, json.dumps(lines)))


def count(lines, who=ST, kind='spot'):
    return q(who, "select submit_stock_count(%s, %s::jsonb, null, %s)", (r1, json.dumps(lines), kind))


def lot(receipt_ing):
    """(qty_remaining, fifo_remaining) ของล็อตต่อวัตถุดิบ เรียงตามวันรับ"""
    return [(float(a), float(b)) for a, b in q('su', 'select qty_remaining, fifo_remaining from stock_lots where ingredient_id=%s order by received_at, id', (receipt_ing,))[1]]


def invariants(rid):
    """ยอดคงเหลือ = ผลรวม ledger = ผลรวมล็อต (ของจริง) = ผลรวมล็อต (ชั้นต้นทุน) ทุกวัตถุดิบ"""
    return one("""
      select count(*) from ingredients i
      where i.restaurant_id = %s and not (
        i.quantity_on_hand = coalesce((select sum(change) from stock_movements m where m.ingredient_id = i.id), 0)
        and i.quantity_on_hand = coalesce((select sum(qty_remaining) from stock_lots l where l.ingredient_id = i.id), 0)
        and i.quantity_on_hand = coalesce((select sum(fifo_remaining) from stock_lots l where l.ingredient_id = i.id), 0))""", (rid,)) == 0


def overview():
    r = q(ST, 'select stock_overview(%s)', (r1,))
    assert r[0] == 'ok', r
    return r[1][0][0]


def reconcile():
    return one("select acct_stock_reconcile_data(%s)", (r1,))


# ---------- 1) ledger หลังรัน migration + seed ----------
check('ledger: ยอด = ผลรวมรายการ = ผลรวมล็อต ทุกวัตถุดิบหลัง seed', invariants(r1))
check('ledger: ยอดยกมาของ seed เป็นรายการ count_adjust ประเภทยกมา (ไม่มี legacy ในร้านใหม่)',
      one("select count(*) from stock_movements where restaurant_id=%s and type='legacy'", (r1,)) == 0
      and one("select bool_and(note = 'ยอดยกมา') from stock_movements where restaurant_id=%s", (r1,)))
check('บัญชี: มูลค่าสต็อก = บัญชีสต็อก', reconcile()['ok'], reconcile())
check('หน่วย: หน่วยฐานมีแค่ g / ml / pcs', one("select bool_and(recipe_unit in ('g','ml','pcs')) from ingredients"))

# ---------- 2) สร้างวัตถุดิบแบบเดิม (kg) -> แปลงเป็นหน่วยฐาน ----------
LEG = one("insert into ingredients(restaurant_id,name,unit,quantity_on_hand,cost_per_unit,reorder_level) values (%s,'หมูสามชั้น','kg',2,300,0.5) returning id", (r1,))
row = q('su', 'select recipe_unit, unit, quantity_on_hand, cost_per_unit, purchase_unit, conversion_factor, reorder_level from ingredients where id=%s', (LEG,))[1][0]
check('แปลงหน่วย: ส่ง kg มา -> เก็บเป็น g (2 kg @ 300 = 2000 g @ 0.3, หน่วยซื้อ kg x 1000)',
      (row[0], row[1], float(row[2]), float(row[3]), row[4], float(row[5]), float(row[6])) == ('g', 'g', 2000, 0.3, 'kg', 1000, 500), row)
check('ยอดเริ่มต้น: ไม่เขียนตรง แต่บันทึกเป็นรายการยกมา 1 รายการ + 1 ล็อต',
      one("select count(*) from stock_movements where ingredient_id=%s and type='count_adjust' and change=2000", (LEG,)) == 1
      and lot(LEG) == [(2000, 2000)])
check('ยอดเริ่มต้น: ลงบัญชีเป็นยอดยกมา (ทุนเจ้าของ) ไม่ใช่ส่วนต่าง',
      one("select count(*) from journal_entries where source_type='opening' and source_id=%s", (LEG,)) == 1)

# ---------- 3) ห้ามแก้ยอด/ต้นทุนตรง · append-only ----------
check('ห้ามแก้ยอดตรง (แม้ superuser)', q('su', 'update ingredients set quantity_on_hand=1 where id=%s', (LEG,))[0] == 'err')
check('ห้ามแก้ต้นทุนตรง (owner)', q(O, 'update ingredients set cost_per_unit=1 where id=%s', (LEG,))[0] == 'err')
check('ห้ามแก้ราคาซื้อล่าสุดตรง (owner)', q(O, 'update ingredients set last_unit_cost=1 where id=%s', (LEG,))[0] == 'err')
mv = one('select id from stock_movements where ingredient_id=%s limit 1', (LEG,))
check('ledger append-only: แก้รายการไม่ได้ (แม้ superuser)', q('su', 'update stock_movements set change=1 where id=%s', (mv,))[0] == 'err')
check('ledger append-only: ลบรายการไม่ได้ (แม้ superuser)', q('su', 'delete from stock_movements where id=%s', (mv,))[0] == 'err')
check('ledger: เขียนตรงไม่ได้ (owner ต้องผ่านฟังก์ชัน)',
      q(O, "insert into stock_movements(restaurant_id,ingredient_id,change,type) values (%s,%s,1,'count_adjust')", (r1, LEG))[0] == 'err')
check('ledger: ประเภท legacy สร้างใหม่ไม่ได้',
      q('su', "insert into stock_movements(restaurant_id,ingredient_id,change,type) values (%s,%s,1,'legacy')", (r1, LEG))[0] == 'err')
check('ledger: ของเสียแยกไม่มีแล้ว',
      q('su', "insert into stock_movements(restaurant_id,ingredient_id,change,reason) values (%s,%s,-1,'waste')", (r1, LEG))[0] == 'err')
check('วัตถุดิบที่มีประวัติลบไม่ได้ (ใช้ปิดใช้งานแทน)', q(O, 'delete from ingredients where id=%s', (LEG,))[0] == 'err')
check('วัตถุดิบที่ยังไม่มีประวัติลบได้', q(O, 'delete from ingredients where id=%s', (ing('ทดลองลบ'),))[2] == 1)
check('หน่วยฐานเปลี่ยนไม่ได้หลังมีประวัติ', q(ST, "update ingredients set recipe_unit='ml' where id=%s", (LEG,))[0] == 'err')

# ---------- 4) FEFO (ของจริง) vs FIFO (ต้นทุน) ----------
FISH = ing('ปลากะพง', supplier_id=None)
r = receive([{"ingredient_id": str(FISH), "quantity": 1000, "unit_cost": 0.10, "expiry_date": "2099-12-31"}])
check('รับเข้า: ล็อตแรก (รับก่อน หมดอายุช้า)', r[0] == 'ok', r)
q('su', "update stock_lots set received_at = now() - interval '2 days' where ingredient_id=%s", (FISH,))
receive([{"ingredient_id": str(FISH), "quantity": 1000, "unit_cost": 0.20, "expiry_date": "2099-01-01"}])
FISH_DISH = menu_with('ปลานึ่ง', [(FISH, 300)])
o1 = order(FISH_DISH)
check('ตัดตามสูตร: เริ่มทำได้', start_cooking(o1)[0] == 'ok')
check('FEFO: หยิบของจากล็อตที่หมดอายุก่อน (ล็อตสอง) · FIFO: คิดต้นทุนจากล็อตที่รับก่อน (ล็อตแรก)',
      lot(FISH) == [(1000, 700), (700, 1000)], lot(FISH))
d = q('su', "select change, cost, unit_cost from stock_movements where order_id=%s and ingredient_id=%s", (o1, FISH))[1][0]
check('FIFO: มูลค่าที่ตัด = 300 x 0.10 = 30 บาท', (float(d[0]), float(d[1]), float(d[2])) == (-300, -30, 0.1), d)
check('ต้นทุนในระบบ = เฉลี่ยชั้น FIFO ที่เหลือ ((700 x 0.1 + 1000 x 0.2) / 1700)',
      float(one('select cost_per_unit from ingredients where id=%s', (FISH,))) == round(270 / 1700, 7))
check('ledger: บันทึกรายละเอียดล็อตทั้งสองแบบ', one("select count(distinct basis) from stock_movement_lots ml join stock_movements m on m.id = ml.movement_id where m.order_id=%s", (o1,)) == 2)
check('บัญชี: ตัดตามสูตรลงต้นทุนขาย 30 บาท',
      one("""select sum(jl.debit) from journal_lines jl join journal_entries e on e.id = jl.entry_id
             join accounts a on a.id = jl.account_id and a.system_key='cogs' where e.source_type='recipe_deduct' and e.source_id=%s""", (o1,)) == 30)
check('ตัดซ้ำไม่ได้: เปลี่ยนสถานะต่อไม่ตัดเพิ่ม',
      q(K, "update orders set status='ready' where id=%s", (o1,))[0] == 'ok'
      and q(K, "update orders set status='served' where id=%s", (o1,))[0] == 'ok' and qty(FISH) == 1700)

# ---------- 5) ยกเลิกออเดอร์ = คืนสต็อกลงล็อตเดิม ----------
r = q(O, "update orders set status='cancelled', cancel_reason='ลูกค้าเปลี่ยนใจ' where id=%s", (o1,))
check('ยกเลิกออเดอร์: เจ้าของยกเลิกได้', r[0] == 'ok', r)
check('คืนสต็อก: ยอดกลับ 2000 และคืนลงล็อตเดิมทั้ง FEFO และ FIFO', qty(FISH) == 2000 and lot(FISH) == [(1000, 1000), (1000, 1000)], lot(FISH))
ret = q('su', "select type, change, cost, reverses_id is not null from stock_movements where order_id=%s and change > 0", (o1,))[1]
check('คืนสต็อก: เป็นรายการ recipe_return ที่อ้างรายการตัดเดิม มูลค่า +30', ret == [('recipe_return', 300, 30, True)], ret)
check('บัญชี: คืนสต็อกกลับต้นทุนขาย (Dr สต็อก / Cr ต้นทุนขาย)', one("select count(*) from journal_entries where source_type='recipe_return' and source_id=%s", (o1,)) == 1)
check('คืนซ้ำไม่ได้ (unique reverses_id)',
      q('su', "insert into stock_movements(restaurant_id,ingredient_id,change,type,reverses_id) select restaurant_id, ingredient_id, -change, 'recipe_return', id from stock_movements where order_id=%s and type='recipe_deduct'", (o1,))[0] == 'err')
o_new = order(FISH_DISH)
q(O, "update orders set status='cancelled', cancel_reason='x' where id=%s", (o_new,))
check('ยกเลิกก่อนเริ่มทำ: ไม่มีอะไรต้องคืน', one('select count(*) from stock_movements where order_id=%s', (o_new,)) == 0)
check('ledger: ยังสอดคล้องหลังตัด/คืน', invariants(r1))
check('บัญชี: ยังกระทบยอดได้', reconcile()['ok'], reconcile())

# ---------- 6) ไม่ติดลบ + ปิด/เปิดเมนูอัตโนมัติ (รวมผ่านสูตรย่อย) ----------
o_big = order(FISH_DISH, 7)       # ต้องใช้ 2100 g มี 2000 g
r = start_cooking(o_big)
check('ไม่ติดลบ: ของไม่พอเริ่มทำไม่ได้ และไม่มีอะไรถูกตัด', r[0] == 'err' and 'insufficient_stock: ปลากะพง' in r[1] and qty(FISH) == 2000, r)
o6 = order(FISH_DISH, 6)
start_cooking(o6)
check('เหลือ 200 g < 300 g ต่อจาน -> ปิดเมนูอัตโนมัติ', one('select not is_available and stock_disabled from menu_items where id=%s', (FISH_DISH,)))
receive([{"ingredient_id": str(FISH), "quantity": 100, "unit_cost": 0.2}])
check('รับเข้าแล้วพอ -> เปิดเมนูให้อัตโนมัติ', one('select is_available and not stock_disabled from menu_items where id=%s', (FISH_DISH,)))
q(K, 'select set_menu_availability(%s, false)', (FISH_DISH,))
receive([{"ingredient_id": str(FISH), "quantity": 100, "unit_cost": 0.2}])
check('ปิดเมนูเองด้วยมือ: ระบบไม่ไปเปิดให้', one('select not is_available and not stock_disabled from menu_items where id=%s', (FISH_DISH,)))
q(K, 'select set_menu_availability(%s, true)', (FISH_DISH,))
SOY = ING['เต้าเจี้ยว']
CHICKEN = MENU['ข้าวมันไก่']
count([{"ingredient_id": str(SOY), "counted_qty": 0}])
check('สูตรย่อย: เต้าเจี้ยว (ในน้ำจิ้ม) หมด -> ข้าวมันไก่ปิดอัตโนมัติ', one('select stock_disabled from menu_items where id=%s', (CHICKEN,)))
check('ภาพรวม: แสดงเมนูที่ระบบปิด',
      any(m['name'] == 'ข้าวมันไก่' for m in overview()['stock_disabled_menus']))
count([{"ingredient_id": str(SOY), "counted_qty": 700}])
check('สูตรย่อย: นับเจอเต้าเจี้ยว -> ข้าวมันไก่เปิดคืน', one('select is_available and not stock_disabled from menu_items where id=%s', (CHICKEN,)))
check('นับเจอของหลังเป็น 0: ต้นทุนใช้ล็อตล่าสุด (0.05)',
      float(one("select unit_cost from stock_movements where ingredient_id=%s order by created_at desc, change desc limit 1", (SOY,))) == 0.05)

# ---------- 7) กลับรายการ ----------
BEEF = ing('เนื้อวัว')
rb = receive([{"ingredient_id": str(BEEF), "quantity": 500, "unit_cost": 0.5}])
mv_beef = one("select id from stock_movements where ingredient_id=%s and type='receive'", (BEEF,))
check('กลับรายการ: พนักงานสต็อกทำไม่ได้', q(ST, "select stock_reverse_movement(%s, 'รับผิด')", (mv_beef,))[0] == 'err')
check('กลับรายการ: ต้องมีเหตุผล', q(O, "select stock_reverse_movement(%s, ' ')", (mv_beef,))[0] == 'err')
rv = q(M, "select stock_reverse_movement(%s, 'คีย์ผิดวัตถุดิบ')", (mv_beef,))
check('กลับรายการ: ผู้จัดการกลับใบรับได้ ยอดและล็อตเป็น 0', rv[0] == 'ok' and qty(BEEF) == 0 and lot(BEEF) == [(0, 0)], rv)
check('กลับรายการ: รายการเดิมยังอยู่ไม่ถูกแก้', float(one('select change from stock_movements where id=%s', (mv_beef,))) == 500)
check('กลับรายการ: ซ้ำไม่ได้', q(O, "select stock_reverse_movement(%s, 'ซ้ำ')", (mv_beef,))[0] == 'err')
check('กลับรายการ: กลับรายการกลับอีกทีไม่ได้', q(O, "select stock_reverse_movement(%s, 'x')", (rv[1][0][0],))[0] == 'err')
receive([{"ingredient_id": str(BEEF), "quantity": 500, "unit_cost": 0.5}])
BEEF_DISH = menu_with('เนื้อผัด', [(BEEF, 100)])
start_cooking(order(BEEF_DISH))
mv_beef2 = one("select m.id from stock_movements m where m.ingredient_id=%s and m.type='receive' and m.change > 0 and not exists (select 1 from stock_movements x where x.reverses_id = m.id)", (BEEF,))
check('กลับรายการ: ใบรับที่ของถูกใช้ไปแล้วกลับไม่ได้', 'lot_already_used' in str(q(O, "select stock_reverse_movement(%s, 'x')", (mv_beef2,))))
check('กลับรายการ: ตัดตามสูตรกลับตรงไม่ได้ (ใช้ยกเลิกออเดอร์)',
      q(O, "select stock_reverse_movement(%s, 'x')", (one("select id from stock_movements where ingredient_id=%s and type='recipe_deduct'", (BEEF,)),))[0] == 'err')
cb = count([{"ingredient_id": str(BEEF), "counted_qty": 350}])
mv_cnt = one("select id from stock_movements where count_id=%s", (cb[1][0][0],))
check('กลับรายการ: ใบนับผิด กลับได้ ยอดกลับเป็นก่อนนับ',
      q(O, "select stock_reverse_movement(%s, 'นับผิดชั้น')", (mv_cnt,))[0] == 'ok' and qty(BEEF) == 400)
check('ledger: ยังสอดคล้องหลังกลับรายการ', invariants(r1))
check('บัญชี: ยังกระทบยอดได้หลังกลับรายการ', reconcile()['ok'], reconcile())

# ---------- 8) นับสต็อก: blind sheet · AvT · สี · ผู้ตรวจ · ติดลบต่อเนื่อง ----------
sheet = q(ST, 'select to_jsonb(s) from stock_count_sheet(%s) s', (r1,))
rows_ = [r[0] for r in sheet[1]] if sheet[0] == 'ok' else []
cols = sorted(rows_[0]) if rows_ else []
check('ใบนับ blind: ไม่มีคอลัมน์ยอดในระบบ/ยอดที่ควรเหลือ', rows_ and not any('qty' in c or 'quantity' in c or 'expected' in c or 'cost' in c for c in cols), cols)
locs = [r['storage_location'] for r in rows_]
groups = [k for k, _ in itertools.groupby(locs)]
check('ใบนับ: เรียงตามตำแหน่งจัดเก็บ (shelf-to-sheet) ตำแหน่งเดียวกันอยู่ติดกัน ไม่ระบุอยู่ท้าย',
      len(groups) == len(set(groups)) and (None not in groups or groups[-1] is None), locs)
abc = q(ST, "select distinct abc_class from stock_count_sheet(%s, array['A'])", (r1,))
check('ใบนับ: กรองคลาส ABC ได้', abc[0] == 'ok' and abc[1] == [('A',)], abc)
check('ใบนับ: บัญชีเปิดใบนับไม่ได้', q(A, 'select count(*) from stock_count_sheet(%s)', (r1,))[0] == 'err')
color = lambda e, v: one('select stock_variance_color(%s::numeric, %s::numeric)', (e, v))
check('สี: <2% เขียว · 2-5% เหลือง · >5% แดง (ของยอดที่ควรเหลือ)',
      [color(100, -1.99), color(100, -2), color(100, 5), color(100, 5.01), color(100, -12)] == ['green', 'yellow', 'yellow', 'red', 'red'])
check('สี: ควรเหลือ 0 นับได้ 0 เขียว · ได้มากกว่า 0 แดง', [color(0, 0), color(0, 3)] == ['green', 'red'])

TOFU = ing('เต้าหู้', 1000, 0.02)
ids = []
for n_, (got, days) in enumerate([(950, 9), (900, 6), (860, 3)]):
    c_ = count([{"ingredient_id": str(TOFU), "counted_qty": got}], kind='daily')
    ids.append(c_[1][0][0])
    q('su', "update stock_counts set created_at = now() - make_interval(days => %s) where id=%s", (days, c_[1][0][0]))
rep = q(M, 'select variance_qty, color, negative_streak, recipe_alert from stock_variance_report(%s, %s)', (r1, ids[-1]))
check('ติดลบต่อเนื่อง 3 รอบ: เตือนว่าสูตรหรือ yield อาจไม่ตรง', rep[0] == 'ok' and rep[1][0][2] == 3 and rep[1][0][3] is True, rep)
rep1 = q(M, 'select negative_streak, recipe_alert from stock_variance_report(%s, %s)', (r1, ids[0]))
check('รายงานใบเก่า: นับย้อนเฉพาะรอบก่อนหน้านั้น (รอบแรก = 1 ยังไม่เตือน)', rep1[1][0] == (1, False), rep1)
check('ภาพรวม: เตือนเต้าหู้ในรายการสูตร/yield', any(a['name'] == 'เต้าหู้' for a in overview()['recipe_alerts']))
c4 = count([{"ingredient_id": str(TOFU), "counted_qty": 870}])
check('นับแล้วเกิน: ตัดลำดับติดลบ (ไม่เตือนแล้ว)',
      not any(a['name'] == 'เต้าหู้' for a in overview()['recipe_alerts']))
check('ผู้ตรวจ: ผู้จัดการรับรองใบที่ตัวเองนับไม่ได้',
      q(M, 'select verify_stock_count(%s)', (count([{"ingredient_id": str(TOFU), "counted_qty": 870}], who=M)[1][0][0],))[0] == 'err')
c_own = count([{"ingredient_id": str(TOFU), "counted_qty": 870}], who=O)[1][0][0]
check('ผู้ตรวจ: เจ้าของรับรองใบตัวเองได้ (ร้านคนเดียว)', q(O, 'select verify_stock_count(%s)', (c_own,))[0] == 'ok')
check('ผู้ตรวจ: บัญชีรับรองไม่ได้', q(A, 'select verify_stock_count(%s)', (c4[1][0][0],))[0] == 'err')
check('ใบนับ: บันทึกเหตุผลได้ (ไม่บังคับ)',
      count([{"ingredient_id": str(TOFU), "counted_qty": 860, "note": "หล่นแตก"}])[0] == 'ok'
      and one("select note from stock_count_lines where ingredient_id=%s and note is not null", (TOFU,)) == 'หล่นแตก')

# ---------- 9) Yield test ----------
BASIL = ING['ใบกะเพรา']
yt = q(ST, "select record_yield_test(%s, %s, 'trim', %s::jsonb, true, 'เด็ดก้าน')",
       (r1, BASIL, json.dumps([{"before": 500, "after": 350}, {"before": 400, "after": 300}, {"before": 1000, "after": 800}])))
check('yield test: ค่าเฉลี่ยของ 3 ครั้ง ((70 + 75 + 80) / 3 = 75%)', yt[0] == 'ok' and float(yt[1][0][0]['avg_pct']) == 75, yt)
check('yield test: นำไปใช้ -> ตั้ง trim yield ของวัตถุดิบ (80 -> 75)', float(one('select trim_yield_pct from ingredients where id=%s', (BASIL,))) == 75)
check('yield test: ต้องครบ 3 ครั้ง',
      q(ST, "select record_yield_test(%s, %s, 'trim', %s::jsonb)", (r1, BASIL, json.dumps([{"before": 1, "after": 1}] * 2)))[0] == 'err')
check('yield test: ตัดแต่งแล้วหนักขึ้นไม่ได้',
      q(ST, "select record_yield_test(%s, %s, 'trim', %s::jsonb)", (r1, BASIL, json.dumps([{"before": 100, "after": 120}] * 3)))[0] == 'err')
RICE = ing('ข้าวหอมมะลิ', 5000, 0.04)
RICE_DISH = menu_with('ข้าวสวยจาน', [(RICE, 200)])
before = float(one('select unit_cost from menu_item_costs where menu_item_id=%s', (RICE_DISH,)))
yc = q(ST, "select record_yield_test(%s, %s, 'cook', %s::jsonb, true)",
       (r1, RICE, json.dumps([{"before": 1000, "after": 2500}, {"before": 1000, "after": 2400}, {"before": 1000, "after": 2600}])))
check('yield test (หุงสุก): ได้มากกว่า 100% ได้ (250%)', yc[0] == 'ok' and float(yc[1][0][0]['avg_pct']) == 250, yc)
check('yield test: ตั้ง cook yield แล้วต้นทุนเมนูคำนวณใหม่ (8.00 -> 3.20)',
      before == 8 and float(one('select unit_cost from menu_item_costs where menu_item_id=%s', (RICE_DISH,))) == 3.2)
check('yield test: ครัว/บัญชีบันทึกไม่ได้',
      q(K, "select record_yield_test(%s, %s, 'trim', %s::jsonb)", (r1, BASIL, json.dumps([{"before": 1, "after": 1}] * 3)))[0] == 'err'
      and q(A, "select record_yield_test(%s, %s, 'trim', %s::jsonb)", (r1, BASIL, json.dumps([{"before": 1, "after": 1}] * 3)))[0] == 'err')
check('yield test: เก็บผลทุกครั้งไว้ดูย้อนหลัง', one('select count(*) from yield_tests where ingredient_id=%s', (BASIL,)) == 1)

# ---------- 10) Par และจำนวนแนะนำสั่ง ----------
SUP = q(M, "insert into suppliers(restaurant_id,name,lead_time_days,delivery_days) values (%s,'ฟาร์มเห็ด',2,'{1,4}') returning id", (r1,))
check('ผู้ขาย: ผู้จัดการเพิ่มได้', SUP[0] == 'ok', SUP)
SUP = SUP[1][0][0]
MUSH = ing('เห็ดฟาง', 3000, 0.08, supplier_id=SUP, safety_stock=200, purchase_unit='kg', conversion_factor=1000)
MUSH_DISH = menu_with('ผัดเห็ด', [(MUSH, 100)])
start_cooking(order(MUSH_DISH, 28))      # ใช้ไป 2800 g ใน 28 วัน = 100 g/วัน
sg = q(ST, "select daily_usage, cycle_days, par, par_source, suggested_qty, suggested_purchase_qty, order_today from stock_reorder_suggestions(%s) where ingredient_id=%s", (r1, MUSH))
want_today = one("select extract(dow from (now() at time zone 'Asia/Bangkok')::date + 2)::int in (1, 4)")
# par = 100 x (lead 2 + รอบสั่ง 7/2 = 3.5) + safety 200 = 750 · คงเหลือ 200 -> แนะนำ 550 g = 1 kg
check('par: ใช้ต่อวัน x (lead time + รอบสั่ง) + safety stock = 750',
      sg[0] == 'ok' and [float(x) for x in sg[1][0][:3]] == [100, 3.5, 750] and sg[1][0][3] == 'auto', sg)
check('แนะนำสั่ง: par − คงเหลือ = 550 g (ปัดขึ้นเป็นหน่วยซื้อ 1 kg)', sg[1][0][4] == 550 and sg[1][0][5] == 1, sg)
check('แนะนำสั่งวันนี้: ถ้าสั่งวันนี้ ของมาถึงในวันที่ผู้ขายมาส่ง', sg[1][0][6] == want_today, (sg, want_today))
q(ST, 'update ingredients set par_level=1000 where id=%s', (MUSH,))
sg2 = q(ST, "select par, par_source, suggested_qty from stock_reorder_suggestions(%s) where ingredient_id=%s", (r1, MUSH))[1][0]
check('par: ตั้งเองได้ (มาก่อนค่าที่คำนวณ)', (float(sg2[0]), sg2[1], float(sg2[2])) == (1000, 'manual', 800), sg2)
check('par: ผู้ขายร้านอื่นผูกไม่ได้',
      q(ST, 'update ingredients set supplier_id=%s where id=%s', (one("insert into suppliers(restaurant_id,name) values (%s,'x') returning id", (r2,)), MUSH))[0] == 'err')

# ---------- 11) ภาพรวม ----------
q('su', "update stock_lots set expiry_date = current_date + 1 where ingredient_id=%s", (MUSH,))
ing('ผงกะหรี่')
ov = q(ST, 'select stock_overview(%s)', (r1,))
o_ = ov[1][0][0] if ov[0] == 'ok' else {}
check('ภาพรวม: พนักงานสต็อกเปิดได้ มีครบทุกส่วน', ov[0] == 'ok' and {'out', 'low', 'expiring', 'stock_value', 'reorder_today', 'recipe_alerts'} <= set(o_), ov)
check('ภาพรวม: มูลค่าสต็อก = ผลรวมล็อต FIFO', o_.get('stock_value') == float(one(
    'select round(sum(fifo_remaining * raw_unit_cost), 2) from stock_lots where restaurant_id=%s', (r1,))))
check('ภาพรวม: ใกล้หมด (ต่ำกว่าจุดสั่ง/safety)', any(x['name'] == 'เห็ดฟาง' for x in o_.get('low', [])), o_.get('low'))
check('ภาพรวม: ใกล้หมดอายุ (ภายใน 3 วัน) พร้อมจำนวนวัน', any(x['name'] == 'เห็ดฟาง' and x['days_left'] == 1 for x in o_.get('expiring', [])))
check('ภาพรวม: แนะนำสั่งวันนี้ ตรงกับวันส่งของผู้ขาย', any(x['name'] == 'เห็ดฟาง' for x in o_.get('reorder_today', [])) == want_today)
check('ภาพรวม: หมด (คงเหลือ 0)', any(x['name'] == 'ผงกะหรี่' for x in o_.get('out', [])) and not any(x['name'] == 'เนื้อวัว' for x in o_.get('out', [])))
check('ภาพรวม: หน้าร้าน/ครัวเปิดไม่ได้', q(S, 'select stock_overview(%s)', (r1,))[0] == 'err' and q(K, 'select stock_overview(%s)', (r1,))[0] == 'err')

# ---------- 12) สิทธิ์ ----------
for who, name in [(O, 'owner'), (M, 'manager'), (ST, 'stock')]:
    check(f'สิทธิ์: {name} รับเข้าได้', receive([{"ingredient_id": str(MUSH), "quantity": 1, "unit_cost": 0.08}], who=who)[0] == 'ok')
    check(f'สิทธิ์: {name} นับได้', count([{"ingredient_id": str(MUSH), "counted_qty": qty(MUSH)}], who=who)[0] == 'ok')
check('สิทธิ์: บัญชีรับเข้าไม่ได้', receive([{"ingredient_id": str(MUSH), "quantity": 1, "unit_cost": 1}], who=A)[0] == 'err')
check('สิทธิ์: บัญชีนับไม่ได้', count([{"ingredient_id": str(MUSH), "counted_qty": 1}], who=A)[0] == 'err')
check('สิทธิ์: บัญชีอ่านล็อต/ledger ได้', q(A, 'select count(*) from stock_lots where restaurant_id=%s', (r1,))[1][0][0] > 0)
check('สิทธิ์: บัญชีเพิ่มผู้ขายไม่ได้', q(A, "insert into suppliers(restaurant_id,name) values (%s,'y')", (r1,))[0] == 'err')
for who, name in [(K, 'ครัว'), (S, 'หน้าร้าน')]:
    check(f'สิทธิ์: {name} มองไม่เห็นข้อมูลสต็อก',
          all(q(who, f'select count(*) from {t}')[1][0][0] == 0
              for t in ['ingredients', 'stock_lots', 'stock_movements', 'recipes', 'recipe_lines', 'suppliers', 'stock_counts', 'yield_tests']))
check('สิทธิ์: ครัวยังตัดสต็อกได้ผ่านการกดเริ่มทำ', start_cooking(order(MUSH_DISH))[0] == 'ok')
check('แยกร้าน: ร้านอื่นมองไม่เห็นข้อมูลสต็อกร้านนี้',
      all(q(X, f'select count(*) from {t} where restaurant_id=%s', (r1,))[1][0][0] == 0
          for t in ['ingredients', 'stock_lots', 'stock_movements', 'recipes', 'suppliers', 'stock_counts', 'yield_tests']))
check('แยกร้าน: ร้านอื่นเรียกฟังก์ชันของร้านนี้ไม่ได้',
      all(q(X, sql, (r1,))[0] == 'err' for sql in [
          'select stock_overview(%s)', 'select count(*) from stock_reorder_suggestions(%s)', 'select count(*) from stock_count_sheet(%s)',
          "select count(*) from stock_history(%s, now() - interval '1 day', now())"]))
check('แยกร้าน: เพิ่มบรรทัดสูตรด้วยวัตถุดิบร้านอื่นไม่ได้',
      q(ST, 'insert into recipe_lines(recipe_id,ingredient_id,qty) values (%s,%s,1)',
        (one('select id from recipes where menu_item_id=%s', (MUSH_DISH,)), one("insert into ingredients(restaurant_id,name,recipe_unit) values (%s,'x','g') returning id", (r2,))))[0] == 'err')

# ---------- 12.5) บันทึกสูตรทั้งชุด (stock_save_recipe) ----------
lines_ = json.dumps([{"ingredient_id": str(MUSH), "qty": 1000}])
sv = q(ST, "select stock_save_recipe(%s, null, 'ซอสเห็ด', null, 2000, 'ml', %s::jsonb)", (r1, lines_))
check('สูตร: บันทึกสูตรย่อยทั้งชุดได้ และคำนวณต้นทุนให้', sv[0] == 'ok'
      and float(one('select cost_per_output from recipes where id=%s', (sv[1][0][0],))) == 0.04, sv)
SAUCE2 = sv[1][0][0]
pr = q(ST, "select stock_save_recipe(%s, null, 'ผัดเห็ดซอส', null, 1, 'จาน', %s::jsonb)", (r1, json.dumps([{"sub_recipe_id": str(SAUCE2), "qty": 50}])))
PARENT = pr[1][0][0]
bad = q(ST, "select stock_save_recipe(%s, %s, 'ซอสเห็ด', null, 2000, 'ml', %s::jsonb)",
        (r1, SAUCE2, json.dumps([{"ingredient_id": str(MUSH), "qty": 500}, {"sub_recipe_id": str(PARENT), "qty": 1}])))
check('สูตร: บันทึกที่วนกลับถูกปฏิเสธทั้งชุด บรรทัดเดิมไม่หาย (ธุรกรรมเดียว)', bad[0] == 'err' and 'recipe_cycle' in bad[1]
      and one('select count(*) from recipe_lines where recipe_id=%s', (SAUCE2,)) == 1
      and float(one('select qty from recipe_lines where recipe_id=%s', (SAUCE2,))) == 1000, bad)
q(ST, "select stock_save_recipe(%s, %s, 'ซอสเห็ด', null, 2000, 'ml', %s::jsonb)", (r1, SAUCE2, json.dumps([{"ingredient_id": str(MUSH), "qty": 1500}])))
check('สูตร: แก้สูตรย่อยแล้วสูตรแม่คำนวณใหม่ (50 ml x 1500 x 0.08 / 2000 = 3.00)',
      float(one('select cost_per_output from recipes where id=%s', (PARENT,))) == 3)
check('สูตร: บรรทัดเป็นทั้งวัตถุดิบและสูตรย่อยไม่ได้',
      q(ST, "select stock_save_recipe(%s, null, 'x', null, 1, 'จาน', %s::jsonb)",
        (r1, json.dumps([{"ingredient_id": str(MUSH), "sub_recipe_id": str(SAUCE2), "qty": 1}])))[0] == 'err')
check('สูตร: บัญชี/ร้านอื่นบันทึกไม่ได้',
      q(A, "select stock_save_recipe(%s, null, 'x', null, 1, 'จาน', '[]'::jsonb)", (r1,))[0] == 'err'
      and q(X, "select stock_save_recipe(%s, null, 'x', null, 1, 'จาน', '[]'::jsonb)", (r1,))[0] == 'err')
mi = q(ST, 'select name, stock_disabled, recipe_id is not null from stock_menu_items(%s)', (r1,))
check('เมนูสำหรับผูกสูตร: พนักงานสต็อกเห็นทุกเมนู (รวมที่ปิดอยู่) พร้อมสถานะสูตร', mi[0] == 'ok'
      and len(mi[1]) == one('select count(*) from menu_items where restaurant_id=%s', (r1,)), mi)
check('ผู้จัดการ: ทวงของขาด/รายงานผู้ขายได้ (0030)',
      q(M, "select count(*) from supplier_receiving_report(%s, current_date - 30, current_date)", (r1,))[0] == 'ok')

# ---------- 13) ประวัติ ----------
h = q(ST, "select type, actor_id from stock_history(%s, now() - interval '30 days', now() + interval '1 day', %s, %s, null)", (r1, FISH, ST))
check('ประวัติ: กรองตามวัตถุดิบ + ผู้ทำรายการ', h[0] == 'ok' and len(h[1]) > 0 and all(r[1] == ST for r in h[1]), h)
h2 = q(A, "select count(*) from stock_history(%s, now() - interval '30 days', now() + interval '1 day', null, null, 'recipe_return')", (r1,))
check('ประวัติ: กรองตามประเภท (คืนสต็อก)', h2[0] == 'ok' and h2[1][0][0] >= 1, h2)
h3 = q(ST, "select count(*) from stock_history(%s, now() + interval '1 day', now() + interval '2 days')", (r1,))
check('ประวัติ: กรองตามวันที่', h3[1][0][0] == 0)
check('ประวัติ: บอกว่ารายการถูกกลับแล้ว',
      q(ST, "select reversed_by is not null from stock_history(%s, now() - interval '1 day', now() + interval '1 day') where id=%s", (r1, mv_beef))[1] == [(True,)])

# ---------- 14) seed ทดลองของโมดูลสต็อก ----------
demo = q('su', (ROOT / 'seed' / 'seed_stock_demo.sql').read_text(encoding='utf-8'))
check('seed_stock_demo: รันได้', demo[0] == 'ok', demo)
ov = overview()
check('seed_stock_demo: หมูสับติดลบ 3 รอบ -> เตือนในภาพรวม', any(a['name'] == 'หมูสับ' for a in ov['recipe_alerts']), ov['recipe_alerts'])
check('seed_stock_demo: มีล็อตใกล้หมดอายุ', any(a['name'] == 'หมูสับ' for a in ov['expiring']))
check('seed_stock_demo: รันซ้ำไม่ซ้ำข้อมูล', q('su', (ROOT / 'seed' / 'seed_stock_demo.sql').read_text(encoding='utf-8'))[0] == 'ok'
      and one("select count(*) from stock_receipts where invoice_no='DEMO-STOCK-1'") == 1)
check('ledger: ทั้งร้านยังสอดคล้องหลังทุกขั้นตอน', invariants(r1))
check('บัญชี: ทั้งร้านยังกระทบยอดได้หลังทุกขั้นตอน', reconcile()['ok'], reconcile())

T.tx.rollback()

# ---------- 15) ย้ายข้อมูลเดิม: ฐานข้อมูลที่ใช้งานอยู่ (ถึง 0026) -> 0027-0030 ----------
legacy = pgserver.get_server(pathlib.Path(tempfile.mkdtemp(prefix='plato-legacy-')) / 'pgdata', cleanup_mode='delete')
db = psycopg.connect(legacy.get_uri(), autocommit=True)
db.execute(STUB)
mig = [f for f in files() if f.parent.name == 'migrations']
old, new = [f for f in mig if f.name < '0027'], [f for f in mig if f.name >= '0027']


def run(f):
    t = f.read_text(encoding='utf-8')
    t = t.replace('create extension if not exists "pgcrypto";', '').replace('create extension if not exists pgcrypto with schema extensions;', '')
    db.execute(t)


for f in old:
    run(f)
L = db.execute("insert into restaurants(name) values ('ร้านเดิม') returning id").fetchone()[0]
c = db.execute("insert into menu_categories(restaurant_id,name) values (%s,'อาหาร') returning id", (L,)).fetchone()[0]
dish = db.execute("insert into menu_items(restaurant_id,category_id,name,price) values (%s,%s,'ปูผัดผงกะหรี่',300) returning id", (L, c)).fetchone()[0]
crab = db.execute("insert into ingredients(restaurant_id,name,unit,quantity_on_hand,cost_per_unit,yield_pct,reorder_level) values (%s,'ปูม้า','kg',25,350,35,5) returning id", (L,)).fetchone()[0]
milk = db.execute("insert into ingredients(restaurant_id,name,unit,quantity_on_hand,cost_per_unit) values (%s,'กะทิ','ลิตร',4,60) returning id", (L,)).fetchone()[0]
egg = db.execute("insert into ingredients(restaurant_id,name,unit,quantity_on_hand,cost_per_unit) values (%s,'ไข่เป็ด','ฟอง',30,5) returning id", (L,)).fetchone()[0]
lime = db.execute("insert into ingredients(restaurant_id,name,unit,quantity_on_hand,cost_per_unit,yield_pct) values (%s,'มะนาว','g',3000,0.08,40) returning id", (L,)).fetchone()[0]
sauce = db.execute("insert into ingredients(restaurant_id,name,unit,quantity_on_hand,is_prep,batch_output_qty,cost_per_unit) values (%s,'น้ำจิ้มซีฟู้ด','g',0,true,5000,0.05) returning id", (L,)).fetchone()[0]
db.execute("insert into prep_components(prep_id,ingredient_id,quantity) values (%s,%s,1000)", (sauce, lime))
db.execute("insert into ingredient_units(ingredient_id,unit_name,factor) values (%s,'ลัง',10)", (crab,))
db.execute("insert into recipes(menu_item_id,ingredient_id,quantity_used) values (%s,%s,0.08),(%s,%s,0.05),(%s,%s,1),(%s,%s,30)",
           (dish, crab, dish, milk, dish, egg, dish, sauce))
db.execute("insert into stock_movements(restaurant_id,ingredient_id,change,reason,waste_type) values (%s,%s,-1.5,'waste','spoiled')", (L, crab))
db.execute("insert into stock_movements(restaurant_id,ingredient_id,change,reason) values (%s,%s,10,'purchase')", (L, crab))
val_before = db.execute("select sum(round(quantity_on_hand * cost_per_unit, 2)) from ingredients where restaurant_id=%s", (L,)).fetchone()[0]
ledger_before = db.execute("select acct_stock_reconcile_data(%s)", (L,)).fetchone()[0]
for f in new:
    run(f)
mres = []


def mcheck(name, ok, detail=''):
    mres.append(bool(ok))
    print(('PASS ' if ok else 'FAIL ') + 'ย้ายข้อมูล: ' + name + (f'  [{detail}]' if detail and not ok else ''))


cr = db.execute("select recipe_unit, quantity_on_hand, cost_per_unit, trim_yield_pct, reorder_level, purchase_unit, conversion_factor from ingredients where id=%s", (crab,)).fetchone()
mcheck('kg -> g: ปู 33.5 kg @ 350 -> 33500 g @ 0.35 (trim 35%, จุดสั่ง 5000 g, หน่วยซื้อ kg x 1000)',
       (cr[0], float(cr[1]), float(cr[2]), float(cr[3]), float(cr[4]), cr[5], float(cr[6])) == ('g', 33500, 0.35, 35, 5000, 'kg', 1000), cr)
mcheck('ลิตร -> ml และ ฟอง -> pcs (ชื่อหน่วยเดิมยังแสดง)',
       db.execute("select recipe_unit, quantity_on_hand::float from ingredients where id=%s", (milk,)).fetchone() == ('ml', 4000.0)
       and db.execute("select recipe_unit, unit from ingredients where id=%s", (egg,)).fetchone() == ('pcs', 'ฟอง'))
mcheck('มูลค่าสต็อกรวมไม่เปลี่ยน', db.execute("select sum(round(quantity_on_hand * cost_per_unit, 2)) from ingredients where restaurant_id=%s", (L,)).fetchone()[0] == val_before)
mcheck('บัญชียังกระทบยอดได้ ไม่มีรายการใหม่จากการแปลงหน่วย',
       db.execute("select acct_stock_reconcile_data(%s)", (L,)).fetchone()[0]['ok'] and ledger_before['ok']
       and db.execute("select count(*) from journal_entries where restaurant_id=%s and source_type='stock_revalue'", (L,)).fetchone()[0] == 0)
hist_ = [(t, float(ch)) for t, ch in db.execute("select type, change from stock_movements where ingredient_id=%s order by change", (crab,)).fetchall()]
mcheck('ประวัติแปลงหน่วยด้วย: ของเสีย -1.5 kg -> -1500 g (legacy) · รับ 10 kg -> 10000 g · ยอดตั้งต้น 25 kg เติมเป็นรายการยกมา',
       hist_ == [('legacy', -1500.0), ('receive', 10000.0), ('legacy', 25000.0)], hist_)
mcheck('ยอด = ผลรวม ledger (เติมรายการยกมาให้) = ผลรวมล็อต', db.execute("""
       select bool_and(i.quantity_on_hand = (select sum(change) from stock_movements m where m.ingredient_id = i.id)
                       and i.quantity_on_hand = coalesce((select sum(qty_remaining) from stock_lots l where l.ingredient_id = i.id), 0))
       from ingredients i where i.restaurant_id=%s and i.quantity_on_hand > 0""", (L,)).fetchone()[0])
mcheck('หน่วยแปลงเดิม: 1 ลัง = 10 kg -> 10000 g', float(db.execute("select factor from ingredient_units where ingredient_id=%s", (crab,)).fetchone()[0]) == 10000)
sub = db.execute("select id, output_qty::float, menu_item_id from recipes where restaurant_id=%s and name='น้ำจิ้มซีฟู้ด'", (L,)).fetchone()
mcheck('ของเตรียม -> สูตรย่อย (output 5000 g)', sub and sub[1] == 5000 and sub[2] is None, sub)
lines = dict(db.execute("""select coalesce(i.name, s.name), l.qty::float from recipe_lines l join recipes r on r.id = l.recipe_id
                          left join ingredients i on i.id = l.ingredient_id left join recipes s on s.id = l.sub_recipe_id
                          where r.menu_item_id=%s""", (dish,)).fetchall())
mcheck('สูตรเมนูเดิม -> สูตรใหม่ แปลงหน่วยแล้ว และของเตรียมเป็นบรรทัดสูตรย่อย',
       lines == {'ปูม้า': 80.0, 'กะทิ': 50.0, 'ไข่เป็ด': 1.0, 'น้ำจิ้มซีฟู้ด': 30.0}, lines)
# ต้นทุนเดิม = 0.08 kg / 35% x 350 + 0.05 ลิตร x 60 + 1 x 5 + 30 g น้ำจิ้ม (ต่อ g = 1000 / 40% x 0.08 / 5000 = 0.04) = 80 + 3 + 5 + 1.2
mcheck('ต้นทุนเมนูหลังย้าย = 89.20 บาท', float(db.execute("select unit_cost from menu_item_costs where menu_item_id=%s", (dish,)).fetchone()[0]) == 89.2)
db.close()

passed = sum(T.results) + sum(mres)
total = len(T.results) + len(mres)
print(f'\nสรุป: ผ่าน {passed}/{total}')
raise SystemExit(0 if passed == total else 1)
