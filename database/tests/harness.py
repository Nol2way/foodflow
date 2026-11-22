"""ตัวช่วยทดสอบบน Postgres ชั่วคราว (ใช้กับ test_accounting.py)

สร้างเซิร์ฟเวอร์ Postgres ในเครื่อง จำลอง auth/role ของ Supabase แล้วรัน migrations ทุกไฟล์ตามลำดับเลข + seed
"""
import pathlib
import os
import sys
import tempfile

try:
    import pgserver
except ImportError:
    import pixeltable_pgserver as pgserver
import psycopg

ROOT = pathlib.Path(__file__).resolve().parent.parent

def quoted_payment(cur, sql, args):
    """Legacy fixtures now explicitly preview the bill and send the reviewed amount."""
    if 'select counter_pay_bill(' not in sql or 'p_expected_total' in sql:
        return sql, args
    cur.execute('savepoint quote_preview')
    cur.execute('reset role')
    if len(args) == 3 and '%s::uuid[])' in sql and args[2] is not None:
        cur.execute('select apply_promotions(%s,%s::uuid[],%s::uuid[])', args)
    cur.execute('select coalesce(sum(total),0) from orders where id=any(%s::uuid[])', (args[1],))
    total = cur.fetchone()[0]
    if len(args) == 4 and "'cash', %s, %s" in sql:
        cur.execute('select loyalty_point_value from shop_settings where restaurant_id=%s',(args[0],))
        row=cur.fetchone()
        if row: total -= args[3]*row[0]
    cur.execute('rollback to savepoint quote_preview')
    return sql[:-1]+', p_expected_total => %s)', (*args,total)

STUB = """
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create publication supabase_realtime;
create schema extensions;
create function extensions.gen_salt(text, int default 10) returns text language sql volatile as
  $$ select '$stub$' || substr(md5(random()::text), 1, 8) $$;
create function extensions.crypt(text, text) returns text language sql immutable as
  $$ select left($2, 14) || md5(left($2, 14) || $1) $$;
grant usage on schema public, auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated;
"""


def files():
    migrations = sorted((ROOT / 'migrations').glob('[0-9][0-9][0-9][0-9]_*.sql'))
    return migrations + [ROOT / 'seed' / 'seed.sql', ROOT / 'seed' / 'seed_demo.sql']


def start():
    """คืน (uri, admin connection แบบ autocommit) หลังรัน migrations + seed แล้ว"""
    service_url = os.environ.get('FOODFLOW_TEST_POSTGRES_URL')
    if service_url:
        from local_postgres import create_database
        srv, uri = create_database(service_url)
    else:
        scratch = pathlib.Path(tempfile.mkdtemp(prefix='plato-pg-'))
        srv = pgserver.get_server(scratch / 'pgdata', cleanup_mode='delete')
        uri = srv.get_uri()
    admin = psycopg.connect(uri, autocommit=True)
    stub = STUB
    if service_url:
        for statement in ['create role anon nologin;', 'create role authenticated nologin;', 'create role service_role nologin bypassrls;']:
            stub = stub.replace(statement, 'do $$ begin ' + statement + ' exception when duplicate_object then null; end $$;')
    admin.execute(stub)
    for f in files():
        text = f.read_text(encoding='utf-8')
        text = text.replace('create extension if not exists "pgcrypto";', '')
        text = text.replace('create extension if not exists pgcrypto with schema extensions;', '')
        try:
            admin.execute(text)
        except psycopg.Error as e:
            print('LOAD FAILED', f.name, '->', e)
            sys.exit(2)
    print('LOADED', len(files()), 'files')
    return srv, uri, admin


class Runner:
    """รัน SQL ในธุรกรรมเดียว (ย้อนทั้งหมดตอนจบ) ในฐานะผู้ใช้ต่างๆ"""

    def __init__(self, uri):
        self.tx = psycopg.connect(uri)
        self.cur = self.tx.cursor()
        self.results = []

    def check(self, name, ok, detail=''):
        self.results.append(bool(ok))
        print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail and not ok else ''))

    def q(self, uid, sql, args=None):
        """uid: 'su' = superuser, None = anon, UUID = ผู้ใช้ที่ล็อกอิน"""
        cur = self.cur
        cur.execute('savepoint sp')
        try:
            if uid == 'su':
                cur.execute('reset role')
                cur.execute("select set_config('request.jwt.claim.sub','',true)")
            elif uid is None:
                cur.execute('set local role anon')
                cur.execute("select set_config('request.jwt.claim.sub','',true)")
            else:
                cur.execute("select set_config('request.jwt.claims', json_build_object('credential_version',credential_version)::text,true) from app_users where id=%s", (str(uid),))
                cur.execute('set local role authenticated')
                cur.execute("select set_config('request.jwt.claim.sub',%s,true)", (str(uid),))
            sql, args = quoted_payment(cur, sql, args)
            cur.execute(sql, args)
            rows = cur.fetchall() if cur.description else None
            rc = cur.rowcount
            # ตรวจ constraint แบบ deferred (เดบิต = เครดิต) เหมือนตอน commit แล้วกลับเป็น deferred
            cur.execute('set constraints all immediate')
            cur.execute('set constraints all deferred')
            cur.execute('reset role')
            cur.execute('release savepoint sp')
            return ('ok', rows, rc)
        except psycopg.Error as e:
            cur.execute('rollback to savepoint sp')
            cur.execute('reset role')
            return ('err', str(e).splitlines()[0], 0)

    def one(self, sql, args=None):
        r = self.q('su', sql, args)
        assert r[0] == 'ok', r
        return r[1][0][0]

    def finish(self):
        self.tx.rollback()
        passed, total = sum(self.results), len(self.results)
        print(f'\nสรุป: ผ่าน {passed}/{total}')
        sys.exit(0 if passed == total else 1)
