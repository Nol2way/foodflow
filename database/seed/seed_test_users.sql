-- Plato — บัญชีทดสอบครบทุกบทบาท (ใช้ทดลองเท่านั้น ห้ามใช้กับร้านจริง)
-- รันใน Supabase SQL Editor หลัง migrations ทั้งหมด + seed.sql
--
-- สร้างผู้ใช้ในตาราง app_users (ล็อกอินได้ทันที) และผูกบทบาทกับร้านแรกในตาราง restaurants
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
-- | multi@foodflow.test          | staff+stock | หน้าร้าน + สต็อก (ตัวอย่างพนักงานหลายบทบาท)            |
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
      ('owner@foodflow.test', array['owner'], rid),
      ('manager@foodflow.test', array['manager'], rid),
      ('staff@foodflow.test', array['staff'], rid),
      ('kitchen@foodflow.test', array['kitchen'], rid),
      ('accountant@foodflow.test', array['accountant'], rid),
      ('stock@foodflow.test', array['stock'], rid),
      ('multi@foodflow.test', array['staff', 'stock'], rid),
      ('other-owner@foodflow.test', array['owner'], rid_other),
      ('norole@foodflow.test', null, null)
    ) as t(email, roles, restaurant_id)
  loop
    -- ผู้ใช้อยู่ในตาราง app_users ของระบบเอง (0021) ไม่ใช่ Supabase Auth
    select id into uid from app_users where email = r.email;
    if uid is null then
      uid := app_create_user(r.email, v_password, null, false);
    else
      -- มีอยู่แล้ว: ตั้งรหัสผ่านกลับเป็นค่าทดสอบ และเปิดใช้งาน
      perform app_set_password(uid, v_password, false);
      update app_users set is_active = true where id = uid;
    end if;

    -- 1 แถวต่อ 1 บทบาท (0020): เพิ่มที่ขาด แล้วลบบทบาทที่ไม่อยู่ในรายการ
    if r.roles is not null then
      insert into staff_members (user_id, restaurant_id, role)
      select uid, r.restaurant_id, x from unnest(r.roles) as x
      on conflict do nothing;
      delete from staff_members
      where user_id = uid and restaurant_id = r.restaurant_id and role <> all(r.roles);
    end if;
  end loop;
end;
$$;

-- ตรวจผล: บัญชีทดสอบและบทบาท
select u.email, string_agg(s.role, ', ' order by s.role) as roles, r.name as restaurant
from app_users u
left join staff_members s on s.user_id = u.id
left join restaurants r on r.id = s.restaurant_id
where u.email like '%@foodflow.test'
group by u.email, r.name
order by r.name nulls last, u.email;

-- ===== ลบบัญชีทดสอบทั้งหมด (เอา -- ออกแล้วรัน) =====
-- delete from app_users where email like '%@foodflow.test';        -- staff_members ถูกลบตามอัตโนมัติ
-- delete from restaurants where name = 'ร้านทดสอบอื่น';
