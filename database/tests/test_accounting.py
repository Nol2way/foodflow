"""ทดสอบโมดูลบัญชี (0026) บน Postgres จริง: การลงบัญชีแต่ละเหตุการณ์ reversal กระทบยอดสต็อก ปิดวัน และสิทธิ์

วิธีรัน:
  pip install pixeltable-pgserver "psycopg[binary]"
  python database/tests/test_accounting.py
"""
import json
import uuid

import psycopg

from harness import Runner, start

srv, uri, admin = start()
T = Runner(uri)
q, one, check = T.q, T.one, T.check

# ---------- เตรียมข้อมูล ----------
r1 = one("select id from restaurants order by created_at limit 1")
table1 = one("select id from dining_tables where restaurant_id=%s order by label limit 1", (r1,))
menu = {n: i for i, n in q('su', "select id, name from menu_items where restaurant_id=%s", (r1,))[1]}
KAPRAO, TEA = menu['ผัดกะเพราหมูสับ'], menu['ชาเย็น']
ING = {n: i for i, n in q('su', "select id, name from ingredients where restaurant_id=%s", (r1,))[1]}

U = {k: uuid.uuid4() for k in ['owner', 'mgr', 'acc', 'staff', 'kitchen', 'stock', 'other']}
for u in U.values():
    q('su', 'insert into app_users(id, email) values (%s, %s)', (u, f'{u}@test.local'))
r2 = one("insert into restaurants(name) values ('ร้านอื่น') returning id")
for k, rid, role in [('owner', r1, 'owner'), ('mgr', r1, 'manager'), ('acc', r1, 'accountant'), ('staff', r1, 'staff'),
                     ('kitchen', r1, 'kitchen'), ('stock', r1, 'stock'), ('other', r2, 'owner')]:
    q('su', 'insert into staff_members(user_id, restaurant_id, role) values (%s,%s,%s)', (U[k], rid, role))
O, M, A, S, K, ST = U['owner'], U['mgr'], U['acc'], U['staff'], U['kitchen'], U['stock']
TODAY = one("select acct_today(%s)", (r1,))


def entries(source_type, source_id):
    return [r[0] for r in q('su', "select id from journal_entries where source_type=%s and source_id=%s order by entry_no",
                            (source_type, source_id))[1]]


def lines(entry_id):
    """{system_key หรือ code: (เดบิต, เครดิต)} รวมต่อบัญชี"""
    rows = q('su', """select coalesce(a.system_key, a.code), sum(jl.debit), sum(jl.credit)
                      from journal_lines jl join accounts a on a.id = jl.account_id
                      where jl.entry_id=%s group by 1""", (entry_id,))[1]
    return {k: (float(d), float(c)) for k, d, c in rows}


def net(entry_id):
    """{บัญชี: เดบิต - เครดิต}"""
    return {k: round(d - c, 2) for k, (d, c) in lines(entry_id).items()}


def balanced(entry_id):
    return one("select sum(debit) = sum(credit) and count(*) >= 2 from journal_lines where entry_id=%s", (entry_id,))


def reconcile():
    return one("select acct_stock_reconcile_data(%s)", (r1,))


def order(js, uid=S):
    r = q(uid, "select staff_place_order(%s, %s::jsonb, %s)", (r1, json.dumps(js), table1))
    assert r[0] == 'ok', r
    return r[1][0][0]


def walk(oid, *steps):
    for st in steps:
        r = q(K if st in ('preparing', 'ready', 'served') else S, "update orders set status=%s where id=%s", (st, oid))
        assert r[0] == 'ok' and r[2] == 1, (st, r)


def pay(oid, method='cash'):
    r = q(S, "select counter_pay_bill(%s, %s::uuid[], null, %s)", (r1, [str(oid)], method))
    assert r[0] == 'ok', r
    return r


def summary(frm=None, to=None):
    return one("select acct_summary_data(%s, %s, %s)", (r1, frm or TODAY, to or TODAY))


# ---------- 1) ผังบัญชีเริ่มต้น ----------
check('ผังบัญชี: สร้างให้ร้านเดิมและร้านใหม่อัตโนมัติ (24 บัญชี)',
      one("select count(*) from accounts where restaurant_id=%s", (r1,)) == 24
      and one("select count(*) from accounts where restaurant_id=%s", (r2,)) == 24)
check('ผังบัญชี: มีบัญชีที่ระบบต้องใช้ครบ',
      one("""select count(*) from accounts where restaurant_id=%s and system_key = any(array[
             'cash','bank','stock','ap','rev_food','rev_drink','cogs','variance','labor','rent','utilities',
             'marketing','delivery_gp','packaging','vat_out','vat_in'])""", (r1,)) == 16)
check('ผังบัญชี: หมวดเมนู "เครื่องดื่ม" ผูกกับรายได้เครื่องดื่มอัตโนมัติ',
      one("""select a.system_key from menu_categories c join accounts a on a.id = c.revenue_account_id
             where c.restaurant_id=%s and c.name='เครื่องดื่ม'""", (r1,)) == 'rev_drink')
check('กระทบยอด: วัตถุดิบตั้งต้นลงเป็นยอดยกมา บัญชีสต็อก = มูลค่าในโมดูลสต็อก', reconcile()['ok'], reconcile())
check('ยอดยกมา: ไม่ลงเป็นต้นทุนขาย (เครดิตทุนเจ้าของ)',
      one("select count(*) from journal_entries where restaurant_id=%s and source_type='opening'", (r1,)) > 0
      and float(summary()['food_cost']) == 0)

# ---------- 2) ตัดตามสูตร + บิลจ่ายแล้ว ----------
# กะเพรา: ข้าว 200g x .03 + หมู 100g x .18 + ใบกะเพรา 15g x .15 + ไข่ 1 x 4.5 = 30.75 ต่อจาน
# ชาเย็น: ผงชา 15g x .30 + นมข้น 30ml x .06 = 6.30
b1 = order([{"menu_item_id": str(KAPRAO), "quantity": 2}, {"menu_item_id": str(TEA), "quantity": 1}])
walk(b1, 'preparing')
d1 = entries('recipe_deduct', b1)
check('ตัดตามสูตร: 1 ออเดอร์ = 1 รายการ', len(d1) == 1, d1)
check('ตัดตามสูตร: Dr ต้นทุนขาย / Cr สต็อก = 67.80 (2 x 30.75 + 6.30)',
      net(d1[0]) == {'cogs': 67.8, 'stock': -67.8}, net(d1[0]))
check('ตัดตามสูตร: เก็บรายละเอียดวัตถุดิบในบรรทัดสต็อก',
      one("select count(distinct ingredient_id) from journal_lines where entry_id=%s and ingredient_id is not null", (d1[0],)) == 6)
walk(b1, 'ready', 'served')
check('บิล: ยังไม่จ่าย ยังไม่ลงรายได้', entries('bill', b1) == [])
pay(b1)
e1 = entries('bill', b1)
check('บิลจ่ายแล้ว: Dr เงินสด 150 / Cr รายได้อาหาร 120 + รายได้เครื่องดื่ม 30',
      len(e1) == 1 and net(e1[0]) == {'cash': 150.0, 'rev_food': -120.0, 'rev_drink': -30.0}, e1 and net(e1[0]))
check('บิล: วันที่ลงบัญชี = วันที่จ่าย (เวลาร้าน)', one("select entry_date from journal_entries where id=%s", (e1[0],)) == TODAY)
check('กระทบยอด: หลังขายยังเท่ากัน', reconcile()['ok'], reconcile())

# พร้อมเพย์ + ส่วนลดโปร + ส่วนลดแต้ม (จำลองยอดที่ counter_pay_bill / apply_promotions ใส่ไว้)
b2 = order([{"menu_item_id": str(KAPRAO), "quantity": 2}])
walk(b2, 'preparing', 'ready', 'served')
q('su', "update orders set discount_total=20, points_discount=5, total=100 where id=%s", (b2,))
pay(b2, 'promptpay')
check('บิล QR + ส่วนลด: Dr ธนาคาร 100 + ส่วนลดโปร 15 + ส่วนลดแต้ม 5 / Cr รายได้อาหาร 120',
      net(entries('bill', b2)[0]) == {'bank': 100.0, 'disc_promo': 15.0, 'disc_points': 5.0, 'rev_food': -120.0},
      net(entries('bill', b2)[0]))

# จด VAT: ราคารวม VAT แล้ว แยกภาษีขายออก
q('su', "insert into shop_settings(restaurant_id, vat_registered, vat_rate) values (%s, true, 7) on conflict (restaurant_id) do update set vat_registered=true, vat_rate=7", (r1,))
b3 = order([{"menu_item_id": str(TEA), "quantity": 1}])
walk(b3, 'preparing', 'ready', 'served')
q('su', "update orders set subtotal=107, total=107 where id=%s", (b3,))
q('su', "update order_items set unit_price=107 where order_id=%s", (b3,))
pay(b3)
check('บิลจด VAT 7%: Dr เงินสด 107 / Cr รายได้เครื่องดื่ม 100 + ภาษีขาย 7',
      net(entries('bill', b3)[0]) == {'cash': 107.0, 'rev_drink': -100.0, 'vat_out': -7.0}, net(entries('bill', b3)[0]))
q('su', "update shop_settings set vat_registered=false where restaurant_id=%s", (r1,))

# ---------- 3) ยกเลิกบิลหลังจ่าย ----------
check('ยกเลิกบิล: พนักงานหน้าร้านยกเลิกบิลที่จ่ายแล้วไม่ได้',
      q(S, "update orders set status='cancelled', cancel_reason='x' where id=%s", (b1,))[0] == 'err')
check('ยกเลิกบิล: เจ้าของต้องใส่เหตุผล', q(O, "update orders set status='cancelled' where id=%s", (b1,))[0] == 'err')
r = q(O, "update orders set status='cancelled', cancel_reason='คิดเงินผิดโต๊ะ' where id=%s", (b1,))
check('ยกเลิกบิล: เจ้าของยกเลิกพร้อมเหตุผลได้', r[0] == 'ok' and r[2] == 1, r)
rev = q('su', "select id, reason from journal_entries where reverses_entry_id=%s", (e1[0],))[1]
check('ยกเลิกบิล: สร้างรายการกลับ (reversal) ของรายได้ พร้อมเหตุผล',
      len(rev) == 1 and rev[0][1] == 'คิดเงินผิดโต๊ะ' and net(rev[0][0]) == {'cash': -150.0, 'rev_food': 120.0, 'rev_drink': 30.0},
      rev)
ret1 = entries('recipe_return', b1)
check('ยกเลิกบิล: คืนสต็อกอัตโนมัติ (0028) -> Dr สต็อก / Cr ต้นทุนขาย 67.80 คืนลงล็อตเดิม',
      len(ret1) == 1 and net(ret1[0]) == {'stock': 67.8, 'cogs': -67.8}, ret1 and net(ret1[0]))
check('ยกเลิกบิล: ไม่ย้ายต้นทุนไปส่วนต่างสต็อกซ้ำอีก',
      q('su', "select id from journal_entries where reverses_entry_id=%s", (d1[0],))[1] == [])
check('ยกเลิกบิล: รายการเดิมยังอยู่ ไม่ถูกแก้', net(e1[0]) == {'cash': 150.0, 'rev_food': -120.0, 'rev_drink': -30.0})
check('ยกเลิกบิล: ลบออเดอร์ที่ลงบัญชีแล้วไม่ได้', q(O, "delete from orders where id=%s", (b2,))[0] == 'err')
b4 = order([{"menu_item_id": str(KAPRAO), "quantity": 1}])
walk(b4, 'preparing')
q(O, "update orders set status='cancelled' where id=%s", (b4,))
check('ยกเลิกออเดอร์ที่ครัวทำแล้ว (ยังไม่จ่าย): คืนสต็อก กลับต้นทุนขายเต็มจำนวน ไม่มีรายได้',
      entries('bill', b4) == [] and net(entries('recipe_return', b4)[0]) == {'stock': 30.75, 'cogs': -30.75})

# ---------- 4) รับวัตถุดิบ ----------
PORK, EGG = ING['หมูสับ'], ING['ไข่ไก่']
pork_before = float(one("select quantity_on_hand from ingredients where id=%s", (PORK,)))
rc = q(ST, "select submit_stock_receipt(%s, %s::jsonb, 'ตลาดสด', 'B-01', current_date, null, true)", (r1, json.dumps([
    {"ingredient_id": str(PORK), "quantity": 1000, "unit_cost": 0.2},                       # ตรงบิล 200
    {"ingredient_id": str(EGG), "quantity": 25, "unit_cost": 4, "invoice_qty": 30},          # ขาด 5 ฟอง รอทวง 20
])))
check('รับของ: บันทึกได้', rc[0] == 'ok', rc)
RC = rc[1][0][0]
er = entries('stock_receipt', RC)
n_r = net(er[0])
check('รับของ: 1 ใบ = 1 รายการ', len(er) == 1, er)
# สต็อกเพิ่มตามผลต่างมูลค่าจริงในโมดูลสต็อก (ต้นทุนเฉลี่ยปัดทศนิยม 4 ตำแหน่ง) เศษลงส่วนต่างรับสินค้า
check('รับของ: Dr สต็อก ≈300 (รับจริง) + Dr ลูกหนี้ผู้ขาย 20 (ของขาด) + เศษ / Cr เงินสด 320 (ตามบิล)',
      abs(n_r.get('stock') - 300) < 0.5 and n_r.get('claim') == 20.0 and n_r.get('cash') == -320.0
      and round(n_r.get('stock') + n_r.get('claim') + n_r.get('recv_variance', 0), 2) == 320, n_r)
check('รับของ: รายจ่ายจากใบรับของไม่ลงซ้ำ (สต็อกลงบัญชีแล้ว)',
      one("select source from expenses where id=(select expense_id from stock_receipts where id=%s)", (RC,)) == 'stock_receipt'
      and entries('expense', one("select expense_id from stock_receipts where id=%s", (RC,))) == [])
check('กระทบยอด: หลังรับของ (ต้นทุนเฉลี่ยเปลี่ยน) ยังเท่ากัน', reconcile()['ok'], reconcile())
r = q(A, "select set_receipt_claim(%s, %s, 'credited')", (RC, EGG))
check('ทวงของขาด: ได้ลดหนี้ -> Dr เจ้าหนี้ / Cr ลูกหนี้ผู้ขาย 20',
      r[0] == 'ok' and net(entries('supplier_claim', RC)[0]) == {'ap': 20.0, 'claim': -20.0}, r)
q(A, "select set_receipt_claim(%s, %s, 'accepted')", (RC, EGG))
cl = entries('supplier_claim', RC)
check('ทวงของขาด: เปลี่ยนเป็นยอมรับ -> ย้อนลดหนี้ แล้วลงส่วนต่างรับสินค้า (1 การเปลี่ยน = 1 รายการ)',
      len(cl) == 2 and net(cl[1]) == {'ap': -20.0, 'recv_variance': 20.0, 'claim': 0.0}, [net(x) for x in cl])

q('su', "update shop_settings set receipt_payment_default='credit' where restaurant_id=%s", (r1,))
rc2 = q(ST, "select submit_stock_receipt(%s, %s::jsonb, 'แม็คโคร', 'M-9', current_date, null, false)",
        (r1, json.dumps([{"ingredient_id": str(PORK), "quantity": 500, "unit_cost": 0.2}])))
check('รับของแบบเครดิต: Cr เจ้าหนี้การค้า 100',
      net(entries('stock_receipt', rc2[1][0][0])[0]).get('ap') == -100.0, rc2)
r = q(A, "select acct_pay_supplier(%s, 100, 'bank', 'แม็คโคร')", (r1,))
check('จ่ายเจ้าหนี้: Dr เจ้าหนี้ / Cr ธนาคาร', r[0] == 'ok' and net(r[1][0][0]) == {'ap': 100.0, 'bank': -100.0}, r)
check('จ่ายเจ้าหนี้: ผู้จัดการทำไม่ได้', q(M, "select acct_pay_supplier(%s, 1, 'cash')", (r1,))[0] == 'err')

# ---------- 5) ตรวจนับ ของเสีย ปรับต้นทุน ----------
pork_qty = float(one("select quantity_on_hand from ingredients where id=%s", (PORK,)))
pork_cost = float(one("select cost_per_unit from ingredients where id=%s", (PORK,)))
cn = q(ST, "select submit_stock_count(%s, %s::jsonb, null, 'weekly')",
       (r1, json.dumps([{"ingredient_id": str(PORK), "counted_qty": pork_qty - 100}])))
check('ตรวจนับ: บันทึกได้', cn[0] == 'ok', cn)
nc = net(entries('count_adjust', cn[1][0][0])[0])
check('นับแล้วขาด: Dr ส่วนต่างสต็อก / Cr สต็อก',
      nc.get('variance', 0) > 0 and nc.get('variance') == -nc.get('stock'), nc)
cn2 = q(ST, "select submit_stock_count(%s, %s::jsonb)", (r1, json.dumps([{"ingredient_id": str(EGG), "counted_qty":
        float(one("select quantity_on_hand from ingredients where id=%s", (EGG,))) + 2}])))
nc2 = net(entries('count_adjust', cn2[1][0][0])[0])
check('นับแล้วเกิน: กลับด้าน Dr สต็อก / Cr ส่วนต่างสต็อก', nc2.get('stock', 0) > 0 and nc2['variance'] == -nc2['stock'], nc2)

# 0027: ไม่มีของเสียแยก (ไปโผล่เป็นส่วนต่างตอนนับ) · ยอด/ต้นทุนมาจาก ledger เท่านั้น
w = q(ST, "insert into stock_movements(restaurant_id, ingredient_id, change, reason, waste_type) values (%s,%s,-50,'waste','spoiled') returning id", (r1, PORK))
check('ของเสีย: บันทึกแยกไม่ได้แล้ว (เขียน ledger ตรงไม่ได้)', w[0] == 'err', w)
r = q(O, "update ingredients set cost_per_unit = cost_per_unit + 0.01 where id=%s", (PORK,))
check('แก้ต้นทุนต่อหน่วยตรงๆ ไม่ได้ (ต้นทุนมาจากล็อต FIFO)', r[0] == 'err', r)
check('กระทบยอด: ทุกเหตุการณ์สต็อกแล้ว ยังเท่ากัน', reconcile()['ok'], reconcile())
r = q('su', "update ingredients set quantity_on_hand = quantity_on_hand + 1 where id=%s", (PORK,))
check('แก้ยอดตรงในฐานข้อมูลไม่ได้แม้เป็น superuser (stock_balance_is_ledger)', r[0] == 'err' and 'stock_balance_is_ledger' in r[1], r)

# perpetual: ต้นทุนขายจริง = ตามสูตร + ส่วนต่าง = ต้นงวด + รับเข้า - ปลายงวด
sm = summary()
lhs = round(float(sm['cogs_recipe']) + float(sm['stock_variance']), 2)
rhs = round(float(sm['stock_open']) + float(sm['stock_in']) - float(sm['stock_close']), 2)
check(f'perpetual: ตามสูตร + ส่วนต่าง ({lhs}) = ต้นงวด + รับเข้า - ปลายงวด ({rhs})', lhs == rhs and lhs > 0, sm)

# ---------- 6) รายจ่าย ----------
MKT = one("select id from accounts where restaurant_id=%s and system_key='marketing'", (r1,))
ex = q(A, """insert into expenses(restaurant_id, category, account_id, amount, vat_amount, payment_method, spent_on, note)
             values (%s, 'other', %s, 1070, 70, 'bank', %s, 'โฆษณาเพจ') returning id""", (r1, MKT, TODAY))
check('รายจ่าย: พนักงานบัญชีบันทึกได้', ex[0] == 'ok', ex)
EX = ex[1][0][0]
check('รายจ่าย: Dr ค่าการตลาด 1,000 + ภาษีซื้อ 70 / Cr ธนาคาร 1,070',
      net(entries('expense', EX)[0]) == {'marketing': 1000.0, 'vat_in': 70.0, 'bank': -1070.0}, net(entries('expense', EX)[0]))
check('รายจ่าย: หมวดแบบเดิมตั้งจากบัญชีให้อัตโนมัติ (บันทึกผู้ทำ)',
      one("select category = 'other' and created_by = %s and source = 'manual' from expenses where id=%s", (A, EX)))
r = q(A, "insert into expenses(restaurant_id, category, amount) values (%s, 'rent', 5000) returning id", (r1,))
check('รายจ่าย: เลือกหมวดแบบเดิม (ค่าเช่า) -> ลงบัญชีค่าเช่า Cr เงินสด',
      r[0] == 'ok' and net(entries('expense', r[1][0][0])[0]) == {'rent': 5000.0, 'cash': -5000.0}, r)
check('รายจ่าย: ต้องเลือกหมวด', q(A, "insert into expenses(restaurant_id, amount) values (%s, 10)", (r1,))[0] == 'err')
check('รายจ่าย: ใช้บัญชีรายได้เป็นหมวดรายจ่ายไม่ได้',
      q(A, "insert into expenses(restaurant_id, category, account_id, amount) values (%s,'other',(select id from accounts where restaurant_id=%s and system_key='rev_food'),10)", (r1, r1))[0] == 'err')
check('รายจ่าย: ใช้บัญชีต้นทุนขายที่ระบบลงเองไม่ได้',
      q(A, "insert into expenses(restaurant_id, category, account_id, amount) values (%s,'other',(select id from accounts where restaurant_id=%s and system_key='cogs'),10)", (r1, r1))[0] == 'err')
check('รายจ่าย: VAT เกินยอดไม่ได้',
      q(A, "insert into expenses(restaurant_id, category, amount, vat_amount) values (%s,'other',10,20)", (r1,))[0] == 'err')
check('รายจ่าย: ผู้จัดการบันทึกไม่ได้', q(M, "insert into expenses(restaurant_id, category, amount) values (%s,'other',1)", (r1,))[0] == 'err')
check('รายจ่าย: ปลอมผู้บันทึก/แหล่งที่มาไม่ได้',
      q(A, "insert into expenses(restaurant_id, category, amount, source) values (%s,'other',1,'legacy')", (r1,))[0] == 'err')
r = q(A, "update expenses set amount=1 where id=%s", (EX,))
check('รายจ่ายลงบัญชีแล้ว: แก้ยอดไม่ได้', r[0] == 'err', r)
check('รายจ่ายลงบัญชีแล้ว: แก้หมายเหตุได้', q(A, "update expenses set note='โฆษณาเพจ ต.ค.' where id=%s", (EX,))[2] == 1)
check('รายจ่ายลงบัญชีแล้ว: ลบไม่ได้', q(O, "delete from expenses where id=%s", (EX,))[0] == 'err')
check('ยกเลิกรายจ่าย: ต้องใส่เหตุผล', q(A, "select acct_void_expense(%s, ' ')", (EX,))[0] == 'err')
check('ยกเลิกรายจ่าย: ผู้จัดการทำไม่ได้', q(M, "select acct_void_expense(%s, 'x')", (EX,))[0] == 'err')
v = q(A, "select acct_void_expense(%s, 'บันทึกซ้ำ')", (EX,))
check('ยกเลิกรายจ่าย: กลับรายการ (สลับเดบิต/เครดิต)',
      v[0] == 'ok' and net(v[1][0][0]) == {'marketing': -1000.0, 'vat_in': -70.0, 'bank': 1070.0}
      and one("select voided_at is not null and void_reason='บันทึกซ้ำ' from expenses where id=%s", (EX,)), v)
check('ยกเลิกรายจ่าย: ซ้ำไม่ได้', q(A, "select acct_void_expense(%s, 'x')", (EX,))[0] == 'err')

# หมวดที่ร้านเพิ่มเอง
r = q(A, "insert into accounts(restaurant_id, code, name, type, grp) values (%s, '5300', 'ค่าซ่อมบำรุง', 'expense', 'opex') returning id", (r1,))
check('ผังบัญชี: พนักงานบัญชีเพิ่มหมวดเองได้', r[0] == 'ok', r)
REPAIR = r[1][0][0]
r = q(A, "insert into expenses(restaurant_id, category, account_id, amount) values (%s,'other',%s,300) returning id", (r1, REPAIR))
check('รายจ่าย: ใช้หมวดที่เพิ่มเองได้', r[0] == 'ok' and net(entries('expense', r[1][0][0])[0]) == {'5300': 300.0, 'cash': -300.0}, r)
check('ผังบัญชี: ผู้จัดการเพิ่มหมวดไม่ได้',
      q(M, "insert into accounts(restaurant_id, code, name, type, grp) values (%s, '5301', 'x', 'expense', 'opex')", (r1,))[0] == 'err')
check('ผังบัญชี: ตั้ง system_key เองไม่ได้',
      q(O, "insert into accounts(restaurant_id, code, name, type, grp, system_key) values (%s, '5302', 'x', 'expense', 'opex', 'hack')", (r1,))[0] == 'err')
check('ผังบัญชี: กลุ่มไม่ตรงประเภทไม่ได้',
      q(O, "insert into accounts(restaurant_id, code, name, type, grp) values (%s, '5303', 'x', 'expense', 'sales')", (r1,))[0] == 'err')
check('ผังบัญชี: ปิดใช้งานบัญชีระบบไม่ได้',
      q(O, "update accounts set is_active=false where restaurant_id=%s and system_key='cash'", (r1,))[0] == 'err')
check('ผังบัญชี: เปลี่ยนชื่อบัญชีระบบได้',
      q(O, "update accounts set name='เงินสดในลิ้นชัก' where restaurant_id=%s and system_key='cash'", (r1,))[2] == 1)
check('ผังบัญชี: ลบบัญชีที่มีรายการแล้วไม่ได้', q(O, "delete from accounts where id=%s", (REPAIR,))[0] == 'err')

# ---------- 7) สมุดรายวันแก้ไม่ได้ + เดบิต = เครดิต ----------
any_line = one("select id from journal_lines where restaurant_id=%s limit 1", (r1,))
check('สมุดรายวัน: เจ้าของแก้บรรทัดไม่ได้', q(O, "update journal_lines set debit=debit+1 where id=%s", (any_line,))[0] == 'err'
      or q(O, "update journal_lines set debit=debit+1 where id=%s", (any_line,))[2] == 0)
check('สมุดรายวัน: superuser ก็แก้ไม่ได้ (trigger)', q('su', "update journal_lines set debit=debit+1 where id=%s", (any_line,))[0] == 'err')
check('สมุดรายวัน: ลบไม่ได้', q('su', "delete from journal_entries where id=%s", (e1[0],))[0] == 'err')
check('สมุดรายวัน: ผู้ใช้เพิ่มรายการตรงไม่ได้',
      q(O, "insert into journal_entries(restaurant_id, entry_date, source_type) values (%s, current_date, 'expense')", (r1,))[0] == 'err')
check('สมุดรายวัน: เพิ่มบรรทัดจนเดบิต ≠ เครดิตไม่ได้',
      q('su', "insert into journal_lines(entry_id, restaurant_id, account_id, debit) values (%s,%s,(select id from accounts where restaurant_id=%s and system_key='cash'),1)",
        (e1[0], r1, r1))[0] == 'err')
check('สมุดรายวัน: บรรทัดเดียวมีทั้งเดบิตและเครดิตไม่ได้',
      'check' in q('su', """with e as (insert into journal_entries(restaurant_id, entry_date, source_type) values (%s, current_date, 'opening') returning id)
                            insert into journal_lines(entry_id, restaurant_id, account_id, debit, credit)
                            select e.id, %s, (select id from accounts where restaurant_id=%s and system_key='cash'), 1, 1 from e""", (r1, r1, r1))[1])
check('สมุดรายวัน: ทุกรายการเดบิต = เครดิต',
      one("""select count(*) from (select entry_id from journal_lines where restaurant_id=%s group by entry_id
             having sum(debit) <> sum(credit) or count(*) < 2) x""", (r1,)) == 0)

# รายการไม่สมดุลถูกปฏิเสธตอน commit (constraint trigger แบบ deferred)
with psycopg.connect(uri) as c2:
    cash1 = c2.execute("select id from accounts where restaurant_id=%s and system_key='cash'", (r1,)).fetchone()[0]
    eid = c2.execute("insert into journal_entries(restaurant_id, entry_date, source_type) values (%s, current_date - 400, 'opening') returning id", (r1,)).fetchone()[0]
    c2.execute("insert into journal_lines(entry_id, restaurant_id, account_id, debit) values (%s,%s,%s,100)", (eid, r1, cash1))
    try:
        c2.commit()
        ok = False
    except psycopg.Error as e:
        ok = 'journal_unbalanced' in str(e)
    c2.rollback()
    check('constraint: เดบิต ≠ เครดิต commit ไม่ผ่าน', ok)
    # รายการที่ commit แล้ว (ยอดยกมาจาก seed) เพิ่มบรรทัดไม่ได้อีก
    old_entry = c2.execute("select id from journal_entries where restaurant_id=%s and source_type='opening' limit 1", (r1,)).fetchone()[0]
    try:
        c2.execute("insert into journal_lines(entry_id, restaurant_id, account_id, debit) values (%s,%s,%s,1)", (old_entry, r1, cash1))
        ok = False
    except psycopg.Error as e:
        ok = 'journal_immutable' in str(e)
    c2.rollback()
    check('สมุดรายวัน: เพิ่มบรรทัดในรายการที่ commit แล้วไม่ได้', ok)

# ---------- 8) กลับรายการเอง ----------
op = q(O, "select acct_set_opening(%s, 2000, 5000)", (r1,))
check('ยอดยกมา: เจ้าของตั้งเงินสด/ธนาคารได้', op[0] == 'ok' and net(op[1][0][0]) == {'cash': 2000.0, 'bank': 5000.0, 'equity': -7000.0}, op)
check('ยอดยกมา: พนักงานบัญชีตั้งไม่ได้', q(A, "select acct_set_opening(%s, 1, 0)", (r1,))[0] == 'err')
check('กลับรายการ: พนักงานบัญชีทำไม่ได้', q(A, "select acct_reverse_entry(%s, 'x')", (op[1][0][0],))[0] == 'err')
check('กลับรายการ: บิลต้องใช้ยกเลิกบิล ไม่ใช่กลับรายการตรง', 'reverse_not_allowed' in q(O, "select acct_reverse_entry(%s, 'x')", (entries('bill', b2)[0],))[1])
r = q(O, "select acct_reverse_entry(%s, 'ใส่ยอดผิด')", (op[1][0][0],))
check('กลับรายการ: เจ้าของกลับรายการยอดยกมาได้', r[0] == 'ok' and net(r[1][0][0]) == {'cash': -2000.0, 'bank': -5000.0, 'equity': 7000.0}, r)
check('กลับรายการ: ซ้ำไม่ได้', 'already_reversed' in q(O, "select acct_reverse_entry(%s, 'x')", (op[1][0][0],))[1])

# ---------- 9) สิทธิ์ (RLS) ----------
for who, uid, ok in [('เจ้าของ', O, True), ('ผู้จัดการ', M, True), ('พนักงานบัญชี', A, True)]:
    check(f'สิทธิ์: {who} อ่านสมุดรายวันได้', q(uid, "select count(*) from journal_lines where restaurant_id=%s", (r1,))[1][0][0] > 0)
    check(f'สิทธิ์: {who} เปิดแดชบอร์ดบัญชีได้', q(uid, "select acct_dashboard(%s)", (r1,))[0] == 'ok')
for who, uid in [('หน้าร้าน', S), ('ครัว', K), ('สต็อก', ST), ('ร้านอื่น', U['other'])]:
    check(f'สิทธิ์: {who} อ่านสมุดรายวันไม่เห็น', q(uid, "select count(*) from journal_lines where restaurant_id=%s", (r1,))[1][0][0] == 0)
    check(f'สิทธิ์: {who} เปิดแดชบอร์ดบัญชีไม่ได้', q(uid, "select acct_dashboard(%s)", (r1,))[0] == 'err')
check('สิทธิ์: พนักงานสต็อกดูผลกระทบยอดสต็อกได้', q(ST, "select acct_stock_reconcile(%s)", (r1,))[0] == 'ok')
check('สิทธิ์: ผู้จัดการแก้ตั้งค่าบัญชีไม่ได้', q(M, "update shop_settings set accounting_mode='pro' where restaurant_id=%s", (r1,))[2] == 0)
check('สิทธิ์: เจ้าของเปลี่ยนโหมดได้', q(O, "update shop_settings set accounting_mode='pro' where restaurant_id=%s", (r1,))[2] == 1)
check('ตั้งค่า: โหมดผิดถูกปฏิเสธ', q(O, "update shop_settings set accounting_mode='expert' where restaurant_id=%s", (r1,))[0] == 'err')
check('ตั้งค่า: เป้า Food Cost ต่ำสุดเกินสูงสุดไม่ได้',
      q(O, "update shop_settings set food_cost_target_min=40, food_cost_target_max=30 where restaurant_id=%s", (r1,))[0] == 'err')

# ---------- 10) รายงาน ----------
d = q(A, "select acct_dashboard(%s)", (r1,))[1][0][0]
check('แดชบอร์ด: มีวันนี้/7 วัน/30 วัน/เดือนนี้/เดือนก่อน/ทั้งปี',
      set(d['periods']) == {'today', 'd7', 'd30', 'month', 'prev_month', 'ytd'}, list(d['periods']))
t = d['periods']['today']
check('แดชบอร์ด: ยอดขายวันนี้ = 120 (บิลส่วนลด) + 100 (บิล VAT ก่อนภาษี) · บิลที่ยกเลิกหักออกแล้ว · ส่วนลด 20',
      float(t['sales']) == 120 + 100 and float(t['discounts']) == 20, t)
check('แดชบอร์ด: Food cost รวมต้นทุนตามสูตร ส่วนต่างสต็อก และส่วนต่างรับสินค้า',
      abs(float(t['food_cost']) - (float(t['cogs_recipe']) + float(t['stock_variance'])
          + sum(float(x['amount']) for x in t['expenses_by_account'] if x['code'] in ('5030', '5040')))) < 0.01, t)
check('แดชบอร์ด: ภาษีขาย/ภาษีซื้อสุทธิหลังยกเลิกรายจ่าย', float(t['vat_output']) == 7 and float(t['vat_input']) == 0, t)
check('แดชบอร์ด: กระทบยอดสต็อกตรง', d['reconcile']['ok'], d['reconcile'])
mp = q(A, "select name, quantity, revenue, cost, gross_profit from acct_menu_profit(%s, %s, %s)", (r1, TODAY, TODAY))
kap = [x for x in mp[1] if x[0] == 'ผัดกะเพราหมูสับ']
check('กำไรขั้นต้นต่อเมนู: กะเพรา 2 จาน (บิลที่ยังไม่ยกเลิก) ขาย 120 ต้นทุนตามสูตร',
      mp[0] == 'ok' and kap and float(kap[0][1]) == 2 and float(kap[0][2]) == 120 and float(kap[0][4]) == round(120 - float(kap[0][3]), 2), mp)
tb = q(A, "select sum(closing), sum(debit), sum(credit) from acct_trial_balance(%s, %s, %s)", (r1, TODAY, TODAY))[1][0]
check('งบทดลอง: ยอดคงเหลือรวมทุกบัญชี = 0 และเดบิตรวม = เครดิตรวม', float(tb[0]) == 0 and tb[1] == tb[2], tb)
jr = q(M, "select count(*), count(distinct entry_id) from acct_journal_rows(%s, %s, %s)", (r1, TODAY, TODAY))
check('สมุดรายวัน (ส่งออก): ผู้จัดการดึงรายการได้', jr[0] == 'ok' and jr[1][0][0] > 0, jr)
check('สมุดรายวัน (ส่งออก): หน้าร้านดึงไม่ได้', q(S, "select count(*) from acct_journal_rows(%s, %s, %s)", (r1, TODAY, TODAY))[0] == 'err')

# ---------- 11) ปิดวัน ----------
q(O, "select acct_set_opening(%s, 10000, 0)", (r1,))  # เงินทอนตั้งต้นในลิ้นชัก
ds = q(M, "select acct_day_summary(%s, %s)", (r1, TODAY))[1][0][0]
system_cash = float(ds['system_cash'])
check('ปิดวัน: สรุปยอดวันนี้ก่อนนับเงิน', not ds['closed'] and float(ds['sales']) > 0, ds)
check('ปิดวัน: พนักงานบัญชีปิดวันไม่ได้', q(A, "select acct_close_day(%s, %s, 0)", (r1, TODAY))[0] == 'err')
check('ปิดวัน: หน้าร้านปิดวันไม่ได้', q(S, "select acct_close_day(%s, %s, 0)", (r1, TODAY))[0] == 'err')
check('ปิดวัน: ปิดวันในอนาคตไม่ได้', q(M, "select acct_close_day(%s, %s::date + 1, 0)", (r1, TODAY))[0] == 'err')
cd = q(M, "select acct_close_day(%s, %s, %s::numeric, 'นับ 2 รอบ')", (r1, TODAY, system_cash - 15))
check('ปิดวัน: ผู้จัดการนับเงินแล้วยืนยันได้', cd[0] == 'ok' and float(cd[1][0][0]['difference']) == -15, cd)
dc = q('su', "select id from journal_entries where restaurant_id=%s and source_type='day_close'", (r1,))[1]
check('ปิดวัน: เงินขาด 15 -> Dr เงินสดขาด/เกิน / Cr เงินสด',
      len(dc) == 1 and net(dc[0][0]) == {'cash_over_short': 15.0, 'cash': -15.0}, dc)
check('ปิดวัน: บันทึกผู้ยืนยันและยอด',
      one("select confirmed_by = %s and difference = -15 and system_cash = %s::numeric from day_closes where restaurant_id=%s and close_date=%s",
          (M, system_cash, r1, TODAY)))
check('ปิดวัน: ปิดซ้ำไม่ได้', 'already_closed' in q(O, "select acct_close_day(%s, %s, 0)", (r1, TODAY))[1])
check('ปิดวันแล้ว: บันทึกรายจ่ายลงวันนั้นไม่ได้',
      'day_closed' in q(A, "insert into expenses(restaurant_id, category, amount, spent_on) values (%s,'other',5,%s)", (r1, TODAY))[1])
b5 = order([{"menu_item_id": str(TEA), "quantity": 1}])
walk(b5, 'preparing', 'ready', 'served')
pay(b5)
check('ปิดวันแล้ว: บิลที่จ่ายหลังปิดวันเข้าวันถัดไป',
      one("select entry_date from journal_entries where id=%s", (entries('bill', b5)[0],)) == one("select %s::date + 1", (TODAY,)))
check('ปิดวันแล้ว: ตัดสต็อกหลังปิดวันเข้าวันถัดไป',
      one("select entry_date from journal_entries where id=%s", (entries('recipe_deduct', b5)[0],)) == one("select %s::date + 1", (TODAY,)))
r = q(O, "update orders set status='cancelled', cancel_reason='ลูกค้าขอคืน' where id=%s", (b2,))
check('ปิดวันแล้ว: แก้ได้เฉพาะ reversal (ยกเลิกบิลของวันที่ปิด -> กลับรายการลงวันถัดไป)',
      r[0] == 'ok' and one("select entry_date from journal_entries where reverses_entry_id=%s", (entries('bill', b2)[0],)) == one("select %s::date + 1", (TODAY,)), r)
check('ปิดวันแล้ว: ยอดของวันที่ปิดไม่เปลี่ยน',
      float(summary()['sales']) == float(t['sales']))
check('ปิดวันแล้ว: ผู้จัดการอ่านประวัติปิดวันได้ / หน้าร้านไม่เห็น',
      q(M, "select count(*) from day_closes")[1][0][0] == 1 and q(S, "select count(*) from day_closes")[1][0][0] == 0)
check('กระทบยอด: จบทุกขั้นตอนยังเท่ากัน', reconcile()['ok'], reconcile())

# ---------- 12) ข้อมูลทดลอง/นำเข้าไม่ลงบัญชี ----------
check('ออเดอร์ทดลอง (is_demo) ไม่ลงบัญชี',
      one("select count(*) from journal_entries e join orders o on o.id = e.source_id where o.is_demo") == 0)

T.finish()
