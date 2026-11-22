# กระบวนการพัฒนา FoodFlow

การเปลี่ยนแปลงรอบ audit/P1/P2: [features](features.md) · การปล่อยและทดสอบ: [operations](operations.md) · [ผล verification](audits/2026-11-22-remediation-results.md)


## โครงสร้างปัจจุบัน

React/TypeScript/Vite/Tailwind + Hono บน Cloudflare + Supabase PostgreSQL/RLS/Realtime ล็อกอินด้วย `app_users` และ backend JWT ไม่ใช่ Supabase Auth มี Gemini เดิมเป็นตัวเลือก แต่รอบสองคนไม่เพิ่ม AI ไม่มี Python/Prophet/FastAPI service ใน repository นี้

ดู [บริบทรายวิชา](course-context.md) ตัวอย่าง Express/MySQL ในรายวิชาไม่ใช่ stack ของ repository

## แผนและเจ้าของงาน

ใช้ [ใบงานสองคน](tasks/2-people/README.md): คนที่ 1 หน้าร้าน/ครัว/ออเดอร์ คนที่ 2 สมาชิก/โปร/รายงาน/ระบบกลาง ทั้งคู่ทำ frontend/backend/SQL เริ่มบั๊กก่อนฟีเจอร์ แผน 4 คนเดิมถูกแทนแล้ว จอง migration `0009–0019` และ `0020–0029` ตามลำดับ ต้องทดสอบ dependency บนฐานสะอาด

## Git

`origin` เป็น fork, `upstream` เป็น Nol2way/foodflow แตก branch ตามงาน เช่น `fix/p1-order-payment` รวมผ่าน PR พร้อมพฤติกรรมและหลักฐานตรวจ ไม่ถือว่า push แล้ว deploy จนกว่าจะตั้ง CI/integration ของ fork ห้าม commit `.env*` (ยกเว้นตัวอย่าง), `.dev.vars`, token หรือข้อมูลลูกค้า

## กติกาโค้ด

- Endpoint เปลี่ยนต้องแก้ `backend/src/openapi*.ts` และรัน `npm run openapi`
- หน้าใหม่เพิ่ม router, lazy loader, `lib/roles.ts`; ซ่อนปุ่มไม่แทนสิทธิ์ backend/RLS
- เงิน/สต็อกคำนวณและเขียน atomic ในฐานข้อมูล ไม่เชื่อยอด client
- ตารางข้อมูลร้านเปิด RLS และทดสอบข้ามร้าน; privileged function ต้องตรวจสิทธิ์และ search path ไม่ใช้ user-editable metadata ตัดสินสิทธิ์
- เพิ่ม migration ใหม่ ไม่แก้ไฟล์ที่รันไปแล้ว ดู [migration guide](../database/migrations/README.md)
- payment/order RPC, shop_settings, router/roles/OpenAPI เป็นจุดร่วม รวมตาม dependency ในใบงาน

## นิยามเสร็จ

1. Regression/acceptance test ครอบคลุมพฤติกรรมและสิทธิ์
2. Backend typecheck/test และ frontend build/test ผ่าน
3. SQL ผ่านบนฐานทดสอบสะอาดและทดสอบ RLS/บัญชี/สต็อก
4. ตรวจ UI/error cases และระบุว่า E2E ใช้ mock หรือ Supabase จริง
5. อัปเดตใบงาน requirement คู่มือและ OpenAPI ไม่คัดลอกจำนวน test เก่ามาเป็นผลใหม่

## รันและ deploy

ดู [SETUP](SETUP.md) ใช้ `npm ci` ตาม lockfile ปิด dev server ก่อนติดตั้งซ้ำบน Windows เพื่อไม่ให้ native binaries ถูกล็อก Worker รวมใช้ root `wrangler.jsonc`; backend แยกใช้ `backend/wrangler.toml`; Pages ใช้ `frontend/functions/api/[[path]].ts` และไม่มี Cron ตั้ง secret ในบัญชีปลายทางก่อน deploy
