# FoodFlow (Plato)

ระบบบริหารร้านอาหารสำหรับพนักงาน: รับออเดอร์ → ครัว → เสิร์ฟ → รับชำระ พร้อมบัญชีคู่ สต็อก สมาชิก โปรโมชัน และรายงาน

[Fork สำหรับทำงาน](https://github.com/manatsawintho-ragoon/foodflow) · [ต้นฉบับ](https://github.com/Nol2way/foodflow) · [ติดตั้ง](docs/SETUP.md) · [สารบัญคู่มือ](docs/README.md)

## เริ่มใช้งาน

ต้องมี Node.js 22.18+ และ npm รันจากราก repository:

```powershell
npm --prefix frontend ci
npm --prefix backend ci
Copy-Item frontend/.env.example frontend/.env.local
Copy-Item backend/.dev.vars.example backend/.dev.vars
```

กรอกค่าตาม [SETUP](docs/SETUP.md) แล้วเปิดสอง terminal รัน `npm run dev:backend` และ `npm run dev:frontend`

หน้าเว็บ: <http://localhost:5173> · API: <http://localhost:8787/api/health> · Swagger: <http://localhost:8787/api/docs>

เครื่องนี้ใช้ `D:/foodflow/app` เป็น repository และ `D:/foodflow/docs` เป็นเอกสารต้นทาง มี local config อยู่แล้ว ไม่ต้องคัดลอกทับ ดู [ผลตรวจความพร้อม](docs/project-readiness.md)

## สถานะและขอบเขต

การมีโค้ดไม่เท่ากับผ่านการใช้งานจริงครบทุกกรณี ผลตรวจแยกไว้ใน [testing](docs/testing.md) และ [project-readiness](docs/project-readiness.md)

| ส่วน | มีในโค้ดปัจจุบัน | งานที่ยังต้องทำ |
|---|---|---|
| หน้าร้าน/ครัว | POS ทานที่ร้าน/กลับบ้าน Realtime เสิร์ฟ รวมบิล พร้อมเพย์ ใบเสร็จ | บั๊ก person-1, add-ons, ผังโต๊ะ, แก้/แยกบิล, Audit/PWA |
| บัญชี/ภาษี/กะ | บัญชีคู่ รายจ่าย กลับรายการ ปิดวัน รายงาน ร่างภาษีและกะบางส่วน | API/UI ที่ขาดตาม P2-F5 และทดสอบครบวงจร |
| สต็อก | Ledger, FEFO/FIFO, สูตรซ้อน รับเข้า นับ blind, AvT, yield, par | LINE และเชื่อม API/UI เคลม/รายงานผู้ขาย |
| สมาชิก/โปร | แต้ม โปรตามเงื่อนไข รายงานรายวัน | บั๊ก person-2, คูปอง, PDPA/feedback |
| นำเข้า | CSV ตรวจข้อมูล/ย้อน batch | `.xlsx` โดยตรง |
| ระบบกลาง | หลายบทบาท custom JWT, Swagger | CI, dark mode, TH/EN |
| AI | โค้ด Gemini และสถิติเดิม | ไม่อยู่ในรอบสองคน; router ไม่มี `/analytics` |

แผนหลักคือ [person-1](docs/tasks/2-people/person-1-pos-kitchen.md) และ [person-2](docs/tasks/2-people/person-2-crm-ops.md): คนละ 6 บั๊ก + 5 ฟีเจอร์ ส่วน [10 ระบบที่เสนอเพิ่ม](docs/tasks/2-people/proposed-systems.md) เป็นงานอนาคต

## สถาปัตยกรรม

```mermaid
flowchart LR
  FE[React + Vite] -->|JWT + RPC / RLS| DB[(Supabase PostgreSQL)]
  FE -->|HTTP JSON| API[Hono / Cloudflare]
  API -->|JWT ผู้ใช้ หรือ service role เฉพาะงานที่ตรวจสิทธิ์แล้ว| DB
  DB -.->|Realtime| FE
  API -.->|ตั้งค่าเพิ่ม| EXT[LINE / Gemini]
```

- ล็อกอินผ่าน `/api/auth/login` ใช้ `app_users` และ bcrypt; backend ลงนาม HS256 JWT ด้วย legacy JWT secret **ไม่ได้ใช้ Supabase Auth สำหรับ login ปัจจุบัน**
- ผู้ใช้มีหลายบทบาทได้: owner, manager, staff, kitchen, accountant, stock ดู `frontend/src/lib/roles.ts`; RLS/RPC บังคับสิทธิ์จริง
- รับออเดอร์ผ่าน `staff_place_order`; ชำระผ่าน `counter_pay_bill`; เงินคำนวณในฐานข้อมูล
- สต็อกหยิบ FEFO คิดต้นทุน FIFO ใช้นับ/กลับรายการแทนแก้ยอดตรง ดู [stock](docs/stock.md)
- บัญชีใช้รายการคู่และ reversal ดู [accounting](docs/accounting.md)
- Worker รวมเว็บ+API+Cron ตั้งที่ `wrangler.jsonc`; Pages เป็นทางเลือกไม่มี Cron ไม่ถือว่า fork นี้ deploy แล้ว

## โครงสร้างและการตรวจงาน

`frontend/` = React/UI/tests · `backend/` = Hono/auth/OpenAPI/tests · `database/` = migrations/seed/tests · `docs/` = คู่มือ/ใบงาน

Migration ปัจจุบันคือ `0001–0008`; `archive/` เป็นประวัติ ห้ามรันซ้ำทั้งสองชุด ดู [migration guide](database/migrations/README.md)

```powershell
npm --prefix backend run typecheck
npm run test:backend
npm run build
npm run test:frontend
npm run openapi
```

DB/E2E ต้องเตรียมเพิ่มตาม [SETUP](docs/SETUP.md) อย่าใช้ฐานจริงทดลอง migration หรือ seed โดยไม่ตรวจผลกระทบ ห้ามใส่ service-role key/JWT secret ใน frontend หรือเอกสาร เก็บใน `backend/.dev.vars` ที่ Git ไม่ติดตาม ค่าจริงที่เคยอยู่ในเอกสารต้องเปลี่ยนตาม [คู่มือ Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)
