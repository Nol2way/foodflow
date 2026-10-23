# กระบวนการพัฒนา FoodFlow

## 1. แนวทางการพัฒนา

พัฒนาแบบ **ทำเป็นรอบ (Iterative)** เน้นให้ร้านนำร่องใช้งานจริงให้เร็วที่สุด แล้วปรับตามข้อมูลและฟีดแบ็กจริง ไม่ทำครบทุกฟีเจอร์ก่อนเอาไปทดลอง

## 2. เครื่องมือ

| ด้าน | เครื่องมือ |
|------|------------|
| โค้ด | VS Code, Git, GitHub |
| หน้าเว็บ | React, TypeScript, Vite, Tailwind CSS |
| Backend | Cloudflare Workers, Hono, Wrangler |
| ฐานข้อมูล | Supabase (PostgreSQL, Auth, Realtime) |
| พยากรณ์ | Python 3.10+, Prophet, FastAPI |
| ออกแบบ | Figma (wireframe), Mermaid (diagram) |
| จัดการงาน | GitHub Issues + Projects |

## 3. โครงสร้างโค้ด

```
foodflow/
├── frontend/             # หน้าเว็บ React (src/pages, src/components, src/lib) + functions/api สำหรับ Pages
├── backend/              # Hono: src/app.ts (routes), src/openapi.ts (Swagger), test/
├── database/             # migrations/ (รันตามลำดับเลข), seed/, tests/
└── docs/                 # เอกสารโครงงาน + openapi.json
```

กติกา: แก้หรือเพิ่ม endpoint ต้องแก้ `backend/src/openapi.ts` แล้วรัน `npm run openapi` ทุกครั้ง (ชุดทดสอบ backend จะไม่ผ่านถ้าเอกสาร Swagger ไม่ตรงกับ route) · แก้ฐานข้อมูลให้เพิ่มไฟล์ migration เลขถัดไป ห้ามแก้ไฟล์เดิมที่รันบนเว็บจริงแล้ว

## 4. Git Workflow

- สาขาหลัก `main` ต้องใช้งานได้เสมอ (หน้าเว็บ deploy อัตโนมัติจากสาขานี้)
- แตกสาขาตามงาน: `feature/<ชื่อ>`, `fix/<ชื่อ>`, `docs/<ชื่อ>`
- รวมเข้า `main` ผ่าน Pull Request อย่างน้อยให้เพื่อนในทีม 1 คนรีวิว
- ข้อความ commit ใช้รูปแบบ `feat:`, `fix:`, `docs:`, `refactor:` ตามด้วยคำอธิบายสั้นๆ
- ห้าม commit ไฟล์ `.env` หรือกุญแจลับ (ตรวจด้วย `.gitignore`)

## 5. Milestones

| Milestone | เนื้อหา | ระยะเวลาโดยประมาณ |
|-----------|---------|:------------------:|
| M0 | สัมภาษณ์เจ้าของร้าน เลือกร้านนำร่อง | 1-2 สัปดาห์ |
| M1 | ออกแบบฐานข้อมูล + wireframe + multi-tenant | 1-2 สัปดาห์ |
| M2 | ระบบออเดอร์ (หน้ารับออเดอร์ของพนักงาน, หน้าจอครัว, รวมบิล, Realtime) | 3-4 สัปดาห์ |
| M3 | ระบบบัญชี (รายรับ-รายจ่าย, ต้นทุนต่อเมนู, Dashboard) | 3 สัปดาห์ |
| M4 | นำเข้า CSV + AI รอบแรก (คาดการณ์, สรุปรายเช้า) | 4-5 สัปดาห์ |
| M5 | ทดลองใช้จริงที่ร้านนำร่อง | 4 สัปดาห์ |
| M6 | ระบบสต็อก (สูตรอาหาร, ตัดสต็อก, แจ้งเตือน) | 4 สัปดาห์ |
| M7 | เตรียมขาย (ความปลอดภัย, PDPA, ชำระเงินรายเดือน) | 2-3 สัปดาห์ |

## 6. ข้อตกลงด้านโค้ด

- ใช้ TypeScript ทั้งหน้าเว็บและ backend
- ตรวจสอบข้อมูลขาเข้าทุก endpoint (เช่นด้วย Zod)
- การเขียนข้อมูลที่เกี่ยวกับเงินและสต็อกต้องทำในธุรกรรมเดียว
- ทุกตารางที่มีข้อมูลร้านต้องเปิด RLS และมี policy ก่อนใช้งาน
- ห้ามให้ LLM คำนวณตัวเลขทางบัญชีหรือพยากรณ์เอง ใช้โค้ด/โมเดลสถิติคำนวณ แล้วให้ LLM อธิบายผล

## 7. การ deploy

| ส่วน | วิธี |
|------|------|
| หน้าเว็บ | push ขึ้น `main` แล้ว Cloudflare Pages build ให้อัตโนมัติ |
| Backend | Pages Functions: deploy พร้อมหน้าเว็บอัตโนมัติ · Worker แยก: `cd backend && npm run deploy` (ต้องสั่งเอง) |
| ฐานข้อมูล | รัน migration ใน Supabase SQL Editor หรือ Supabase CLI |
| Forecast service | deploy เป็นคอนเทนเนอร์/บริการแยก แล้วตั้ง `FORECAST_SERVICE_URL` |
