-- 0020: พนักงาน 1 คนมีได้หลายบทบาท (เช่น หน้าร้าน + สต็อก)
--   - staff_members เก็บ 1 แถวต่อ 1 บทบาท (คีย์หลัก user_id + restaurant_id + role)
--     has_role() และ RLS ทุกตารางใช้ได้เหมือนเดิม เพราะตรวจว่า "มีแถวบทบาทนั้นไหม"
--   - staff_set_roles(): ตั้งบทบาททั้งชุดของพนักงาน 1 คนในครั้งเดียว (ใช้สิทธิ์ผู้เรียก)
--   - staff_list(): คืนบทบาทเป็น array
--   - ผู้จัดการแก้ได้เฉพาะพนักงานที่ไม่มีบทบาทเจ้าของ/ผู้จัดการเลย และแก้ตัวเองไม่ได้

-- ===== 1) คีย์หลักใหม่ =====
alter table staff_members drop constraint if exists staff_members_pkey;
alter table staff_members add primary key (user_id, restaurant_id, role);
create index if not exists staff_members_restaurant_user_idx on staff_members (restaurant_id, user_id);

-- ===== 2) ผู้จัดการ: ห้ามแตะคนที่มีบทบาทเจ้าของ/ผู้จัดการ (ดูทุกแถวของคนนั้น ไม่ใช่แค่แถวที่แก้) =====
-- security definer เพื่ออ่าน staff_members ได้โดยไม่วน policy ของตารางเดียวกัน
create or replace function staff_is_senior(p_restaurant_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from staff_members
    where restaurant_id = p_restaurant_id and user_id = p_user_id and role in ('owner', 'manager')
  );
$$;
revoke execute on function staff_is_senior(uuid, uuid) from public, anon;
grant execute on function staff_is_senior(uuid, uuid) to authenticated;

drop policy if exists manager_manage_staff on staff_members;
create policy manager_manage_staff on staff_members for all
  using (
    has_role(restaurant_id, array['manager'])
    and role in ('staff', 'kitchen', 'accountant', 'stock')
    and user_id <> auth.uid()
    and not staff_is_senior(restaurant_id, user_id)
  )
  with check (
    has_role(restaurant_id, array['manager'])
    and role in ('staff', 'kitchen', 'accountant', 'stock')
    and user_id <> auth.uid()
    and not staff_is_senior(restaurant_id, user_id)
  );

-- ===== 3) กันร้านไม่มีเจ้าของ: นับเป็นรายคน (คนเดียวมีหลายแถวได้) =====
create or replace function keep_last_owner()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner' or new.restaurant_id <> old.restaurant_id or new.user_id <> old.user_id)
     and exists (select 1 from restaurants where id = old.restaurant_id)
     and not exists (
       select 1 from staff_members
       where restaurant_id = old.restaurant_id and role = 'owner' and user_id <> old.user_id
     ) then
    raise exception 'last_owner';
  end if;
  return coalesce(new, old);
end;
$$;

-- ===== 4) ตั้งบทบาททั้งชุด: เพิ่มที่ขาดก่อน แล้วลบที่ไม่อยู่ในชุด (ทั้งหมดเป็นธุรกรรมเดียว) =====
-- security invoker: RLS ของผู้เรียกตรวจทุกแถว (เจ้าของ / ผู้จัดการตามข้อ 2)
create or replace function staff_set_roles(p_restaurant_id uuid, p_user_id uuid, p_roles text[])
returns text[]
language plpgsql set search_path = public, pg_temp as $$
declare
  v_roles text[];
begin
  if p_roles is null or cardinality(p_roles) = 0 then
    raise exception 'roles_required';
  end if;
  if not exists (select 1 from staff_members where restaurant_id = p_restaurant_id and user_id = p_user_id) then
    raise exception 'not_found';
  end if;

  insert into staff_members (user_id, restaurant_id, role)
  select p_user_id, p_restaurant_id, r from unnest(p_roles) as r
  on conflict do nothing;

  delete from staff_members
  where restaurant_id = p_restaurant_id and user_id = p_user_id and role <> all(p_roles);

  select array_agg(role order by role) into v_roles
  from staff_members where restaurant_id = p_restaurant_id and user_id = p_user_id;
  return v_roles;
end;
$$;
revoke execute on function staff_set_roles(uuid, uuid, text[]) from public, anon;
grant execute on function staff_set_roles(uuid, uuid, text[]) to authenticated;

-- ===== 5) รายชื่อพนักงาน: 1 แถวต่อคน บทบาทเป็น array =====
drop function if exists staff_list(uuid);
create function staff_list(p_restaurant_id uuid)
returns table (user_id uuid, email text, roles text[])
language sql stable security definer set search_path = public, auth, pg_temp as $$
  select s.user_id, u.email::text, array_agg(s.role order by s.role)
  from staff_members s join auth.users u on u.id = s.user_id
  where s.restaurant_id = p_restaurant_id
  group by s.user_id, u.email
  order by min(case s.role when 'owner' then 0 when 'manager' then 1 else 2 end), u.email;
$$;
revoke execute on function staff_list(uuid) from public, anon, authenticated;
grant execute on function staff_list(uuid) to service_role;
