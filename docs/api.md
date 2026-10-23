# เอกสาร API (Backend)

Backend อยู่ที่ [`backend/`](../backend) เขียนด้วย **Hono** รันบน Cloudflare ได้ 2 แบบ (โค้ดชุดเดียวกัน)

| แบบ | ใช้เมื่อ | ที่อยู่ API |
|-----|---------|-------------|
| **Cloudflare Pages Functions** (แนะนำ) | หน้าเว็บกับ API อยู่โดเมนเดียวกัน ไม่ต้องตั้ง CORS | `https://<เว็บ>/api/...` ผ่าน [`frontend/functions/api/[[path]].ts`](../frontend/functions/api/[[path]].ts) |
| Cloudflare Worker แยก | อยากแยก deploy หรือใช้ Rate Limiting binding | `https://foodflow-api.<บัญชี>.workers.dev/api/...` (ตั้ง `VITE_API_URL` ให้หน้าเว็บ) |

## Swagger

- **Swagger UI:** `/api/docs` (เครื่องตัวเอง: <http://localhost:8787/api/docs>) ทดลองเรียก API ได้ กดปุ่ม **Authorize** แล้วใส่ `access_token` ของ Supabase
- **OpenAPI 3.1 JSON:** `/api/openapi.json` หรือไฟล์ [`openapi.json`](openapi.json) ในโฟลเดอร์นี้ (นำเข้า Postman / Insomnia ได้)
- ต้นฉบับอยู่ที่ [`backend/src/openapi.ts`](../backend/src/openapi.ts) แก้แล้วรัน `npm run openapi`

## หลักการ

- **ฐานข้อมูลเป็นด่านสุดท้ายเสมอ** backend เรียก Supabase ด้วย JWT ของผู้ใช้ (RLS และ `has_role` ทำงาน) ใช้ service role เฉพาะ 2 กรณี: อ่านอีเมลพนักงาน และเชิญผู้ใช้ใหม่ ทั้งหมดตรวจสิทธิ์ใน backend ก่อน
- **ความลับอยู่ฝั่ง backend เท่านั้น** `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`
- **เมนูและโปรโมชันไม่ผ่าน backend** หน้า `/menu` และ `/promotions` เขียนตาราง Supabase โดยตรงภายใต้ RLS (เจ้าของ/ผู้จัดการ) ส่วนลดคำนวณใน `staff_place_order` ตอนรับออเดอร์
- **การรับออเดอร์ไม่ผ่าน backend** พนักงานที่ล็อกอินเรียกฟังก์ชัน `staff_place_order` ของ Supabase โดยตรง (ตรวจบทบาท owner/staff และคิดราคาในฐานข้อมูล) ออเดอร์จึงขึ้นหน้าจอครัวผ่าน Realtime ทันที
- **AI ไม่เดาตัวเลข** backend ดึงตัวเลขที่ฐานข้อมูลคำนวณแล้ว ส่งให้ Gemini อธิบาย และส่งตัวเลขชุดเดียวกันกลับให้หน้าเว็บแสดงเพื่อตรวจสอบ
- ข้อผิดพลาดตอบเป็น JSON `{ "error": "<code>", "message": "<ข้อความไทย ถ้ามี>" }` ข้อผิดพลาดที่ไม่คาดคิดตอบ `500 internal_error` โดยไม่เปิดเผยรายละเอียด

## การยืนยันตัวตน

endpoint ที่ต้องล็อกอิน ส่ง header `Authorization: Bearer <access_token ของ Supabase>` (หน้าเว็บทำให้ใน [`frontend/src/lib/api.ts`](../frontend/src/lib/api.ts))

| สถานะ | ความหมาย |
|:-----:|----------|
| 401 `unauthorized` | ไม่มี token / token หมดอายุ |
| 403 `forbidden` | บทบาทในร้านนั้นไม่พอ |
| 400 `invalid_restaurant_id` | `restaurant_id` ไม่ใช่ UUID |

## Endpoints

### `GET /api/health`
ตรวจว่า backend ทำงาน และเปิดฟีเจอร์อะไรไว้ → `{ "ok": true, "ai": true }`

### `POST /api/import/sales` — นำเข้ายอดขาย CSV (เจ้าของ, ผู้จัดการ)
```json
{ "restaurant_id": "uuid", "csv": "<เนื้อไฟล์>", "dry_run": true, "skip_unknown": false }
```
- ไฟล์ไม่เกิน 3 MB / 20,000 แถว ตัวอย่าง: [`frontend/public/sample-sales.csv`](../frontend/public/sample-sales.csv)
- คอลัมน์: `datetime` หรือ `date`+`time`, `item`, `qty` (บังคับ) · `ref`, `price` (ไม่บังคับ) รองรับหัวตารางภาษาไทย (วันที่, เวลา, เลขที่บิล, เมนู, จำนวน, ราคา)
- แถวผิดรูปแบบ → `400 invalid_rows` พร้อม `errors: [{ line, message }]` **ไม่นำเข้าเลยทั้งไฟล์**
- ชื่อเมนูไม่ตรงในระบบ → `blocked: true` ไม่นำเข้า (เว้นแต่ `skip_unknown: true`)
- สำเร็จ → `{ batch_id, orders, lines, skipped_lines, unknown_items, blocked, dry_run }`
- ออเดอร์ที่นำเข้า: สถานะ paid, ไม่ตัดสต็อก, ไม่มีเวลาครัว

### `DELETE /api/import/:batch_id?restaurant_id=uuid` — ย้อนการนำเข้า (เจ้าของ, ผู้จัดการ)
→ `{ "deleted_orders": 120 }` หรือ `404`

### `POST /api/ai/summary` — สรุป/ถามด้วย AI (เจ้าของ, บัญชี)
```json
{ "restaurant_id": "uuid", "days": 28, "question": "ควรเพิ่มคนช่วงไหน" }
```
- `days` 1–120 (เท่ากับขอบเขตของฟังก์ชันวิเคราะห์ในฐานข้อมูล), `question` ไม่เกิน 500 ตัวอักษร (ไม่ใส่ = สรุปภาพรวม)
- จำกัด 6 ครั้ง/นาที/ผู้ใช้ · ไม่มีออเดอร์ในช่วงนั้น = ไม่เรียก Gemini
- → `{ "answer": "...", "facts": { ... }, "ai": true }`
- `503 ai_disabled` ยังไม่ตั้ง `GEMINI_API_KEY` · `502 ai_unavailable` Gemini ไม่ตอบ (ยังได้ `facts`)

ตัวเลขใน `facts`: ยอดออเดอร์, รายรับที่ชำระแล้ว, บิลเฉลี่ย, เวลาครัวเฉลี่ย, ช่วงพีค/ออฟพีค, ออเดอร์รายชั่วโมงและรายวัน, เมนูขายดี, food cost % ต่อเมนู

### พนักงาน (เจ้าของ, ผู้จัดการ)

ผู้จัดการเพิ่ม/แก้/นำออกได้เฉพาะ `staff`, `kitchen`, `accountant`, `stock` ถ้าขอบทบาท `owner` หรือ `manager` ได้ `403 role_not_allowed` (ฐานข้อมูลบังคับซ้ำ)

| Method | Path | Body | ผล |
|--------|------|------|----|
| GET | `/api/staff?restaurant_id=` | – | `{ staff: [{ user_id, email, role }] }` |
| POST | `/api/staff` | `{ restaurant_id, email, role }` | 201 `{ user_id, email, role, invited }` ถ้ายังไม่มีบัญชีจะส่งอีเมลเชิญ · 409 `duplicate` |
| PATCH | `/api/staff/:user_id` | `{ restaurant_id, role }` | เปลี่ยนบทบาท · 409 `last_owner` |
| DELETE | `/api/staff/:user_id?restaurant_id=` | – | นำออกจากร้าน · 409 `last_owner` |

`role`: `owner`, `manager`, `staff`, `kitchen`, `accountant`, `stock` · ร้านต้องมีเจ้าของอย่างน้อย 1 คน (บังคับด้วย trigger ในฐานข้อมูล)

## ตัวแปรของ backend

| ชื่อ | ความลับ | หมายเหตุ |
|------|:------:|----------|
| `SUPABASE_URL` | – | |
| `SUPABASE_ANON_KEY` | – | |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | |
| `GEMINI_API_KEY` | ✅ | ไม่ตั้ง = ปิดฟีเจอร์ AI |
| `GEMINI_MODEL` | – | ค่าเริ่มต้น `gemini-2.5-flash` |
| `ALLOWED_ORIGINS` | – | ใช้เมื่อ Worker อยู่คนละโดเมนกับหน้าเว็บ และใช้เป็นลิงก์กลับในอีเมลเชิญ |
| `AI_LIMITER` | – | Rate Limiting binding (เฉพาะ Worker แยก) ไม่ผูก = นับในหน่วยความจำแทน (แม่นน้อยกว่า) |
