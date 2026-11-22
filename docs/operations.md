# คู่มือก่อนปล่อย FoodFlow

## ติดตั้งและทดสอบซ้ำ

ใช้ Node ตาม `.nvmrc` และ Python ตาม `.python-version`:

```sh
npm ci --prefix frontend
npm ci --prefix backend
npm run setup:database
npm test
npm --prefix backend run typecheck
npm run build
npm audit --prefix frontend
npm audit --prefix backend
```

ชุด database ใช้ PostgreSQL ชั่วคราวในเครื่อง ไม่รับ URL ของ production; runner ค้น `test_*.py` ทุกไฟล์ ใช้ `.venv` ก่อน system Python ส่วน CI รันบน Windows และ Linux

## E2E

ค่าเริ่มต้นรันเฉพาะ browser mocks ซึ่งสกัดกั้น API/DB และไม่เขียน remote data ติดตั้ง Chromium ด้วย `npx --prefix frontend playwright install chromium` ก่อนรัน `npm run test:e2e` ในเครื่องที่มี Edge ใช้ environment `E2E_BROWSER_CHANNEL=msedge`

การทดสอบ roles/order-flow กับบริการจริงต้องตั้ง `E2E_ALLOW_REMOTE=1`, `E2E_SUPABASE_URL` ให้ตรงกับ `VITE_SUPABASE_URL` และรหัสบัญชีทดสอบผ่าน `E2E_PASSWORD` ใช้เฉพาะ staging/disposable project และเปิด backend ก่อน ไม่มีการอ่านรหัส seed อัตโนมัติเป็นหลักฐานว่า environment ปลอดภัย

## Migration และการปล่อย

1. สำรองข้อมูลและบันทึก schema version ของปลายทาง
2. รัน migration ใหม่ตามลำดับใน staging ที่มีข้อมูลตัวแทน ตรวจ constraints และผลกระทบต่อยอด/เอกสารก่อน production
3. Migration session version ทำให้ token เดิมที่ไม่มี claim ใหม่ใช้ต่อไม่ได้ ผู้ใช้ต้องเข้าสู่ระบบใหม่ ให้ปล่อย API/UI และ SQL ในหน้าต่างบำรุงรักษาเดียวกัน
4. ตรวจ `npm run deploy -- --dry-run` ก่อน deploy จริง คำสั่งนี้ build ด้วย API path ของโดเมนเดียวกัน เพื่อไม่ฝัง localhost จาก `.env.local`
5. ตรวจ `/api/health` สำหรับ liveness และ `/api/readyz` สำหรับ dependency readiness; ตั้ง monitor ที่ domain จริงและแจ้งเตือนเมื่อ 5xx/latency สูง
6. Smoke test login, temporary-password change, scope ข้ามร้าน, order→kitchen→serve→pay, ใบเสร็จ/ABB, logout/revocation และการต่อ Realtime ใหม่
7. ตรวจ headers บน HTTPS จริง ไม่ใช้ผล localhost แทน HSTS/CDN policy

ถ้า migration การเงินมีปัญหา ให้หยุดรับธุรกรรมใหม่และ forward-fix หรือกู้ทั้งชุดตาม restore plan อย่าย้อนเฉพาะตารางบัญชีแยกจาก orders/stock/tax เพราะจะทำให้ยอดไม่สอดคล้องกัน

## หมุนความลับ

service-role และ JWT signing secret เคยปรากฏในเอกสารต้นทาง จึงต้องเปลี่ยนค่าเดิมก่อน production แม้ถูกลบจากคู่มือแล้ว:

1. ระบุ consumers ทั้ง Worker, Pages, CLI, งานประจำและเครื่องผู้พัฒนา เก็บรายการชื่อ ไม่คัดลอกค่าจริงลง issue/PR
2. ใน Supabase Dashboard ของ project ที่ยืนยันแล้ว เปลี่ยนคีย์ตามชนิดที่ใช้งานจริง ระบบนี้เซ็น JWT เอง จึงต้องให้ signing secret ตรงกับค่าที่ Data API ตรวจสอบ
3. ตั้งค่าลับใหม่ใน environment ของแต่ละ consumer และ deploy แบบประสานเวลา ห้ามใส่ service-role/signing secret ใน `VITE_*`
4. ทดสอบว่าคีย์/token เก่าเข้าถึงข้อมูลไม่ได้ คีย์ใหม่ทำงานตาม role และไม่มี secret ใน build artifact/log
5. บันทึกเวลา ผู้ดำเนินการ และผลทดสอบโดยไม่มี secret; ตรวจ access logs ที่เกี่ยวข้อง ไม่สรุปว่าถูกใช้งานโดยผู้ไม่หวังดีหากไม่มีหลักฐาน

การเปลี่ยนโค้ดหรือเอกสารอย่างเดียว **ไม่เท่ากับหมุน secret สำเร็จ** ต้องมีสิทธิ์จัดการ project และผลทดสอบจากบริการจริง

## Backup / restore drill

เจ้าของระบบต้องกำหนด RPO/RTO, รอบ backup, อายุเก็บ และผู้เข้าถึงตามการใช้จริง ตรวจแผน backup/PITR ที่เปิดอยู่ใน Supabase Dashboard ไม่สมมติว่าทุกแผนบริการมีเหมือนกัน

ทดสอบกู้ไป project ชั่วคราวที่แยกจาก production พร้อม schema, roles, ข้อมูลและไฟล์ Storage ที่เกี่ยวข้อง จากนั้นตรวจ:

- migration version และ row counts ของ orders/order_items/tax_documents/journal/stock
- ผลรวม debit=credit, inventory valuation กับบัญชี, points กับ ledger และเลขเอกสารไม่ซ้ำ
- role/RLS ข้ามร้าน และ session หลัง restore
- เอกสาร/รูป/ไฟล์ที่มี reference เปิดได้จริง
- เวลาที่ใช้กู้และธุรกรรมล่าสุดที่กลับมา เทียบ RPO/RTO ที่ตกลงไว้

เก็บไฟล์ backup แบบเข้ารหัสนอก git และลบ project สำหรับ drill ตามรอบที่กำหนด ผล local database tests ไม่ใช่หลักฐานว่า restore จาก cloud สำเร็จ

## สิ่งที่ต้องตรวจด้วยอุปกรณ์/บริการจริง

- เครื่องพิมพ์ 80 มม. และ browser print dialog; auto print ยังขึ้นกับสิทธิ์/การตั้งค่าเบราว์เซอร์
- LINE delivery/retry, เวลา scheduled event และเขตเวลาร้าน
- PromptPay: QR เป็นข้อมูลเพื่อชำระเงิน ต้องตรวจยอดเข้าจริงก่อนยืนยัน ไม่ใช่ระบบตรวจสลิปอัตโนมัติ
- Privacy: ร้านต้องใส่ข้อมูลติดต่อ นโยบายเก็บรักษา และขั้นตอนยืนยันผู้ขอข้อมูลตามการใช้งานจริง

อ้างอิง: [Supabase backup](https://supabase.com/docs/guides/platform/backups), [Supabase JWT signing keys](https://supabase.com/docs/guides/auth/signing-keys), [Cloudflare asset headers](https://developers.cloudflare.com/workers/static-assets/headers/)
