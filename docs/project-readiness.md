# ผลเตรียมโปรเจกต์ — 22 พฤศจิกายน 2026

> เอกสารนี้เป็น snapshot ก่อนแก้ ใช้เก็บหลักฐานเดิม สถานะ implementation ล่าสุดดู [คู่มือฟีเจอร์](features.md) และ remediation results; ตัวเลข/ข้อค้นพบด้านล่างไม่ใช่ผลหลังแก้


## สถานะส่งมอบ

เตรียม repository และคู่มือก่อนทำ person-1/person-2 ตามลำดับที่ผู้ใช้กำหนด ยังไม่ได้ปิด 12 บั๊กหรือสร้าง 10 ฟีเจอร์ในใบงาน และไม่ได้ deploy เว็บหรือ apply migration/seed ไปยัง Supabase ที่มีอยู่

| รายการ | ผล |
|---|---|
| โฟลเดอร์ | `D:/foodflow/app` |
| Fork / origin | https://github.com/manatsawintho-ragoon/foodflow |
| Upstream | https://github.com/Nol2way/foodflow |
| Branch | `chore/project-readiness` |
| Frontend local | http://localhost:5173 |
| Backend / Swagger | http://localhost:8787/api/health / http://localhost:8787/api/docs |
| Supabase | `oudncjhbyblhldqieffu` ตามเอกสารที่ผู้ใช้ให้; login และอ่านข้อมูลผ่านแอปสำเร็จ |
| Local config | `frontend/.env.local`, `backend/.dev.vars` อยู่ใน Git ignore |
| เครื่องมือที่ใช้ตรวจ | Node 22.20.0, Python 3.13.14, PostgreSQL ชั่วคราว 16.15, Edge/Playwright |

เปิดหน้าเว็บและ VS Code ที่โฟลเดอร์ repository แล้ว Dev servers ต้องเปิดค้างไว้จึงใช้ URL local ได้ วิธีเปิดใหม่อยู่ใน [SETUP](SETUP.md)

## เอกสารที่อ่านและแก้

- อ่านเอกสารต้นทาง `D:/foodflow/docs` ครบ 14 ไฟล์: PDF 9 ไฟล์ 119 หน้า, ภาพ Quiz 2 และ Markdown 4 ไฟล์ ดู [course-context](course-context.md)
- ตรวจคู่มือใน repo เทียบ source, schema, router และ API แล้วแก้ auth เป็น app_users/custom JWT, หลายบทบาท, migration 0001–0008, stock/accounting ปัจจุบัน และแยกประวัติผลทดสอบออกจากผลรอบนี้
- เปลี่ยนสารบัญงาน 4 คนเป็นแผนสองคน ระบุ partial features และ dependency ของ payment; ยังไม่ติ๊กงานที่ไม่มี implementation/test ครบ
- เพิ่ม [สารบัญคู่มือ](README.md) และ [migration guide](../database/migrations/README.md) ที่ลิงก์เดิมชี้หาไฟล์ที่ไม่มีอยู่
- อัปเดต Markdown 4 ไฟล์ในโฟลเดอร์ต้นทางให้ตรงแผนปัจจุบัน โดยรักษา PDF/PNG เดิม ค่าลับถูกนำออกจาก README ต้นทางแล้ว

## ผลตรวจที่รันจริง

| คำสั่ง/การตรวจ | ผล | ขอบเขต |
|---|---|---|
| `npm --prefix backend run typecheck` | ผ่าน | TypeScript backend |
| `npm --prefix backend test` | 130/130 | API/unit tests ใช้ mock สำหรับบริการภายนอก |
| `npm --prefix frontend run build` | ผ่าน | TypeScript + Vite production build สำหรับ config local นี้ |
| `npm --prefix frontend test` | ผ่านทั้ง 8 ไฟล์ | Pure-function unit tests |
| `.venv/Scripts/python.exe -X utf8 database/tests/test_rls.py` | 501/501 | ฐาน PostgreSQL ชั่วคราว; hardcode 0001–0007 |
| `.venv/Scripts/python.exe -X utf8 database/tests/test_accounting.py` | 125/125 | ฐานชั่วคราวผ่าน harness 0001–0008 |
| `.venv/Scripts/python.exe -X utf8 database/tests/test_stock.py` | 131/131 | ฐานชั่วคราว 0001–0008 และเคส upgrade archive แยก |
| Playwright `roles.spec.ts` | 10/10 | Edge + Supabase จริง: หกบทบาท, ไม่มีบทบาท, ครัวถูกกันหน้าบัญชี, ผู้จัดการอ่านรายจ่าย, ร้านอื่นไม่เห็นเมนู |
| Browser smoke | ผ่าน | หน้า login, HTTP login 200, หน้าแรกเจ้าของ, ไม่มี pageerror |
| `npm run openapi` | ผ่าน | สร้าง spec จาก source โดยเนื้อหาไม่เปลี่ยน |

E2E รอบนี้ใช้ config local ใน `frontend/e2e-results/readiness.config.ts` เพื่อเลือก Edge ที่ติดตั้งอยู่ แทน Chromium ที่ยังไม่ได้ดาวน์โหลด วิธีรันมาตรฐานและติดตั้ง Chromium อยู่ใน SETUP ไม่ได้รัน `order-flow.spec.ts` ที่สร้างออเดอร์และบัญชีจริง

### เทสต์เก่าที่แก้ในรอบเตรียม

1. `frontend/e2e/roles.spec.ts`: เดิมรอข้อความที่ไม่มีอยู่บน dashboard เปลี่ยนไปแท็บรายจ่าย ตรวจข้อความ read-only และไม่มีปุ่มบันทึกรายจ่าย; ล้มก่อนแก้แล้วผ่านทั้ง 10 ข้อหลังแก้
2. `database/tests/test_accounting.py`: เดิมคาด 24 บัญชี แต่ migration 0006 เพิ่ม `wht_payable` เป็น 25 บัญชี ตรวจจำนวนและชนิดบัญชีหัก ณ ที่จ่ายทั้งร้าน seed และร้านใหม่; จาก 124/125 เป็น 125/125

## สิ่งที่ผลตรวจยังไม่ยืนยัน

- การมีตารางและ login ได้ไม่ยืนยันว่า remote Supabase apply 0008 แล้ว ต้องตรวจ function definitions/migration history ก่อนเปลี่ยน schema
- RLS suite ยังไม่โหลด 0008; DB tests ยังไม่มี assertion ตรงสำหรับเงื่อนไข CN และ XML line allocation ของ 0008 จึงห้ามใช้จำนวนผ่านเป็นหลักฐานว่าครอบคลุมสองเรื่องนี้
- ยังไม่ได้ทำ UAT ร้านจริง, ทดสอบจ่าย/คืนเงินจริง, Realtime latency, เครื่องพิมพ์จริง, LINE, backup/restore หรือระบบ production
- `npm audit` จาก lockfile ปัจจุบันพบ frontend 1 moderate (Hono), backend 3 moderate + 1 high (รวม Hono และ Wrangler/Miniflare/Undici) ยังไม่อัปเกรด dependency ในรอบคู่มือ ต้องแยกแก้พร้อม regression test
- service-role key และ legacy JWT secret เคยอยู่ในเอกสารที่ผู้ใช้ให้ การลบจากไฟล์ไม่เพิกถอนค่าเดิม ต้อง rotate ที่โปรเจกต์ Supabase และอัปเดต local config/backend/frontend ให้ตรงกัน ไม่ได้หมุน key แทนผู้ดูแลในรอบนี้

## ลำดับงานถัดไป

ใช้ [แผนสองคน](tasks/2-people/README.md) เป็น checklist หลัก:

1. ปิด P1-B1–B6 และ P2-B1–B6 พร้อม regression tests และ CI; ให้ความสำคัญกับ direct paid update, storage cleanup, rate limiter และสิทธิ์ข้ามร้าน
2. ฟีเจอร์แกนหลักตาม phase 2 โดยต่อยอด UI/RPC ที่มีอยู่แล้ว
3. ฟีเจอร์ phase 3 และรวม payment ตาม dependency; ตรวจ DB บนฐานสะอาดก่อนนำไปใช้กับ remote

แยก 10 proposed systems และ AI ออกจาก acceptance criteria รอบสองคน และอัปเดตเอกสารจากผลจริงทุกครั้ง
