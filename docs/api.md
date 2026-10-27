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

### บัญชี (0026) — `/api/accounting/*`

รายละเอียดเต็มและลองเรียกได้ที่ Swagger (`/api/docs` แท็ก "บัญชี") · หลักการบัญชีดู [accounting.md](accounting.md) · ทุก endpoint เรียกฐานข้อมูลด้วย JWT ของผู้ใช้ (RLS ตรวจซ้ำ) · ช่วงวันที่ `from`/`to` = `YYYY-MM-DD` ตามเวลาร้าน ไม่เกิน 10 ปี

| Method | Path | สิทธิ์ | หน้าที่ |
|--------|------|--------|---------|
| GET | `/dashboard?restaurant_id=` | เจ้าของ ผู้จัดการ บัญชี | วันนี้/7/30 วัน/เดือนนี้/เดือนก่อน/ทั้งปี + metrics (Food/Prime Cost) + แจ้งเตือน + เกณฑ์ VAT + เหมา 60% |
| GET | `/summary` `/menu-profit` `/trial-balance` `/journal` | เจ้าของ ผู้จัดการ บัญชี | งบกำไรขาดทุน/perpetual · กำไรต่อเมนู · งบทดลอง + งบดุล · สมุดรายวัน/บัญชีแยกประเภท (`account_id`) |
| GET | `/reconcile` | + พนักงานสต็อก | มูลค่าในโมดูลสต็อก vs บัญชีสต็อก |
| GET/POST | `/accounts` | ดู: 3 บทบาท · เพิ่ม: เจ้าของ บัญชี | ผังบัญชี / เพิ่มหมวดเอง |
| GET/POST | `/expenses` · POST `/expenses/:id/void` | เพิ่ม/ยกเลิก: เจ้าของ บัญชี | รายจ่าย (บังคับ `account_id`) · ยกเลิก = กลับรายการ บังคับ `reason` |
| POST | `/supplier-payments` | เจ้าของ บัญชี | จ่ายเจ้าหนี้ |
| POST | `/bills/:order_id/cancel` | เจ้าของ | ยกเลิกบิลที่จ่ายแล้ว บังคับ `reason` |
| POST | `/entries/:id/reverse` · `/opening` | เจ้าของ | กลับรายการ (ยอดยกมา จ่ายเจ้าหนี้ ปิดวัน) · ยอดยกมาเงินสด/ธนาคาร |
| GET | `/day?date=` | 3 บทบาท | สรุปยอดของวัน + เงินสดตามระบบ |
| POST | `/day-close` | เจ้าของ ผู้จัดการ | `{ restaurant_id, date, counted_cash, note? }` → ปิดวัน ล็อกรายการ ส่ง LINE (`line: sent / not_configured / failed`) · 409 `already_closed` |
| GET/PATCH | `/settings` | แก้: เจ้าของ | โหมด จด VAT เป้า Food/Prime Cost ใบรับของจ่ายด้วย · `onboarded: true` = ตอบคำถามเริ่มต้นแล้ว |
| GET | `/export?report=&format=` | 3 บทบาท | `report`: journal / trial_balance / summary / menu_profit / expenses · `format`: csv (UTF-8 BOM) / xls (Excel XML) |

ข้อผิดพลาดบัญชีตอบเป็นภาษาไทย เช่น `409 day_closed` (วันนั้นปิดวันแล้ว), `409 expense_posted_use_void`, `409 already_reversed`, `400 reverse_not_allowed`

### สต็อกวัตถุดิบ (0027-0030) — `/api/stock/*`

หลักการและสูตรดู [stock.md](stock.md) · Swagger แท็ก "สต็อกวัตถุดิบ" · ทุก endpoint เรียกฐานข้อมูลด้วย JWT ของผู้ใช้ · ตัวเลขทุกตัวเป็นหน่วยฐานของวัตถุดิบ (g / ml / pcs) · อ่าน = เจ้าของ ผู้จัดการ สต็อก บัญชี · เขียน = เจ้าของ ผู้จัดการ สต็อก

| Method | Path | สิทธิ์ | หน้าที่ |
|--------|------|--------|---------|
| GET | `/overview` | อ่าน | ใกล้หมด หมด ใกล้หมดอายุ มูลค่าสต็อก (FIFO) แนะนำสั่งวันนี้ เตือนสูตร/yield เมนูที่ระบบปิด |
| GET | `/reorder?days=28` | อ่าน | par (อัตโนมัติ/ตั้งเอง) และจำนวนแนะนำสั่งทุกวัตถุดิบ |
| GET/POST · PATCH `/:id` | `/ingredients` | ดู: อ่าน · แก้: เขียน | วัตถุดิบ · สร้างใหม่ส่ง `recipe_unit` (+ `quantity_on_hand` ยอดยกมา, `cost_per_unit` ต่อหน่วยฐาน) · PATCH แก้ยอด/ต้นทุนไม่ได้ |
| GET/POST · PATCH `/:id` | `/suppliers` | ดู: อ่าน · แก้: เขียน | ผู้ขาย `lead_time_days` `delivery_days` (0-6) |
| GET/POST · PUT/DELETE `/:id` | `/recipes` | ดู: อ่าน · แก้: เขียน | สูตรเมนู + สูตรย่อย บันทึกทั้งสูตรในธุรกรรมเดียว (`lines`: `ingredient_id` หรือ `sub_recipe_id` + `qty`) |
| GET | `/last-purchases?supplier_id=` | อ่าน | ราคา/ขนาดบรรจุครั้งก่อน (หน้ารับเข้าเตือนก่อนบันทึก) |
| GET/POST | `/receipts` | ดู: อ่าน (`from`/`to`) · รับ: เขียน | รับเข้า: `supplier_id` + `lines` [`pack_qty` `pack_size` `pack_price` `expiry_date` (`invoice_qty` ถ้าได้ไม่ครบ)] → `{ receipt_id, warnings, recosted_recipes }` |
| GET | `/count-sheet?abc=A,B` | เขียน | ใบนับ blind (ไม่มียอดในระบบ) เรียงตามตำแหน่งจัดเก็บ |
| GET/POST | `/counts` | ดู: อ่าน · นับ: เขียน | บันทึกใบนับ (`count_type` daily/weekly/monthly/spot, `lines` `counted_qty` `entered_text` `note`) → คืนแค่ `count_id` |
| POST | `/counts/:id/verify` | เจ้าของ ผู้จัดการ | ผู้ตรวจรับรอง (ผู้จัดการรับรองใบที่ตัวเองนับไม่ได้) |
| GET | `/counts/:id/variance` | อ่าน | ส่วนต่างเรียงตามมูลค่า: ควรเหลือ นับจริง ส่วนต่าง หน่วย/บาท/% สี ติดลบต่อเนื่อง |
| GET/POST | `/yield-tests` | ดู: อ่าน · บันทึก: เขียน | ชั่งก่อน-หลัง 3 ครั้ง (`kind` trim/cook) `apply: true` = ตั้งเป็น yield ของวัตถุดิบ |
| GET | `/history?from=&to=&ingredient_id=&actor_id=&type=` | อ่าน | ประวัติ ledger (ช่วงไม่เกิน 366 วัน) |
| POST | `/movements/:id/reverse` | เจ้าของ ผู้จัดการ | กลับรายการนำเข้า/ปรับจากการนับ บังคับ `reason` |

ข้อผิดพลาดสต็อกตอบภาษาไทยพร้อมชื่อวัตถุดิบ เช่น `409 insufficient_stock` ("วัตถุดิบไม่พอ...: กุ้ง"), `409 lot_already_used`, `409 already_verified`, `400 recipe_cycle`, `400 invalid_field` (+ `field`)

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
