-- FoodFlow — บัญชีทดสอบครบทุกบทบาท (ใช้ทดลองเท่านั้น ห้ามใช้กับร้านจริง)
-- รันใน Supabase SQL Editor หลัง migrations ทั้งหมด + seed.sql
--
-- สร้างผู้ใช้ใน Supabase Auth (ยืนยันอีเมลแล้ว ล็อกอินได้ทันที) และผูกบทบาทกับร้านแรกในตาราง restaurants
-- รันซ้ำได้: ถ้ามีอีเมลนี้อยู่แล้ว จะตั้งรหัสผ่านใหม่และอัปเดตบทบาทให้
-- อีเมลใช้โดเมน .test (โดเมนสำหรับทดสอบ ส่งอีเมลจริงไม่ได้)
--
-- รหัสผ่านของทุกบัญชี = ค่า v_password ด้านล่าง (เปลี่ยนได้ก่อนรัน)
--
-- | อีเมล                        | บทบาท       | เห็นหน้า                                          |
-- |------------------------------|-------------|---------------------------------------------------|
-- | owner@foodflow.test          | owner       | ทุกหน้า                                            |
-- | manager@foodflow.test        | manager     | เมนู, โปรโมชัน, นำเข้ายอดขาย, พนักงาน, บัญชี (ดูอย่างเดียว) |
-- | staff@foodflow.test          | staff       | รับออเดอร์, ครัว, เสิร์ฟ, รับชำระ                    |
-- | kitchen@foodflow.test        | kitchen     | หน้าจอครัว                                         |
-- | accountant@foodflow.test     | accountant  | บัญชี, วิเคราะห์ + AI                               |
-- | stock@foodflow.test          | stock       | สต็อก                                              |
-- | other-owner@foodflow.test    | owner       | เจ้าของ "ร้านทดสอบอื่น" ใช้ตรวจว่าเห็นข้อมูลร้านเราไม่ได้ |
-- | norole@foodflow.test         | (ไม่มี)      | ล็อกอินได้แต่ไม่ได้ผูกกับร้าน ต้องขึ้นข้อความว่าไม่มีสิทธิ์   |

do $$
declare
  v_password text := '12345678';
  rid uuid;
  rid_other uuid;
  r record;
  uid uuid;
begin
  select id into rid from restaurants order by created_at limit 1;
  if rid is null then
    raise exception 'ไม่พบร้านใน restaurants: รัน seed.sql ก่อน';
  end if;

  -- ร้านที่สอง สำหรับทดสอบว่าข้อมูลแต่ละร้านแยกกัน
  select id into rid_other from restaurants where name = 'ร้านทดสอบอื่น' limit 1;
  if rid_other is null then
    insert into restaurants (name) values ('ร้านทดสอบอื่น') returning id into rid_other;
  end if;

  for r in
    select * from (values
      ('owner@foodflow.test', 'owner', rid),
      ('manager@foodflow.test', 'manager', rid),
      ('staff@foodflow.test', 'staff', rid),
      ('kitchen@foodflow.test', 'kitchen', rid),
      ('accountant@foodflow.test', 'accountant', rid),
      ('stock@foodflow.test', 'stock', rid),
      ('other-owner@foodflow.test', 'owner', rid_other),
      ('norole@foodflow.test', null, null)
    ) as t(email, role, restaurant_id)
  loop
    select id into uid from auth.users where email = r.email;

    if uid is null then
      uid := gen_random_uuid();
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
        confirmation_token, recovery_token, email_change_token_new, email_change
      ) values (
        '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', r.email,
        extensions.crypt(v_password, extensions.gen_salt('bf')), now(),
        '{"provider": "email", "providers": ["email"]}'::jsonb, '{}'::jsonb, now(), now(),
        '', '', '', ''
      );
      insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
      values (
        gen_random_uuid(), uid, uid::text, 'email',
        jsonb_build_object('sub', uid::text, 'email', r.email, 'email_verified', true),
        now(), now(), now()
      );
    else
      -- มีอยู่แล้ว: ตั้งรหัสผ่านกลับเป็นค่าทดสอบ และยืนยันอีเมลให้
      update auth.users
      set encrypted_password = extensions.crypt(v_password, extensions.gen_salt('bf')),
          email_confirmed_at = coalesce(email_confirmed_at, now()),
          updated_at = now()
      where id = uid;
    end if;

    if r.role is not null then
      insert into staff_members (user_id, restaurant_id, role)
      values (uid, r.restaurant_id, r.role)
      on conflict (user_id, restaurant_id) do update set role = excluded.role;
    end if;
  end loop;
end;
$$;

-- ตรวจผล: บัญชีทดสอบและบทบาท
select u.email, s.role, r.name as restaurant
from auth.users u
left join staff_members s on s.user_id = u.id
left join restaurants r on r.id = s.restaurant_id
where u.email like '%@foodflow.test'
order by r.name nulls last, s.role;

-- ===== ลบบัญชีทดสอบทั้งหมด (เอา -- ออกแล้วรัน) =====
-- delete from auth.users where email like '%@foodflow.test';        -- staff_members ถูกลบตามอัตโนมัติ
-- delete from restaurants where name = 'ร้านทดสอบอื่น';
