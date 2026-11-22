# ผลแก้ audit และส่งมอบฟีเจอร์ P1/P2

วันที่ 22 พฤศจิกายน 2026 / branch `fix/comprehensive-audit-remediation` / เทียบ audit ของ revision `2dc0dcc`

## ขอบเขตที่แก้

| กลุ่ม audit | การแก้ในโค้ด | หลักฐานหลัก |
|---|---|---|
| SEC-01/03/04/05 | Reset จำกัด identity ในร้านเดียวแบบ atomic, กัน attach ข้ามร้านระหว่างตั้งรหัสครั้งแรก, epoch/revocation ใน API/RLS, first-login scope, limiter ร่วมผ่าน DB, tenant helper และ lock เจ้าของคนสุดท้าย | `0009_audit_invariants.sql`, `0011_crm_ops_features.sql`, `backend/test/audit-regression.test.ts`, `database/tests/test_audit.py`, `test_crm_ops.py` |
| PAY-01/02/03/04 | กัน direct paid, กระจายเศษแต้มไม่เกินยอดใบ, quote ยอด/IDs คงที่, settings/promotions ไม่พร้อมต้องหยุดชำระ | DB audit/POS tests และ browser quote/settings regressions |
| DOC-01/ORD-01 | ABB ใช้รายการของ order ตัวเอง, receipt ปกติเมื่อเอกสารออกไม่ครบ, ล็อกส่ง POS จนจบ และ client_ref สำหรับ retry | receipt/queue browser tests, `test_pos.py` |
| PROMO-01/CRM-01 | save โปรกับ links ใน transaction, เก็บโปรที่ยังเข้าเงื่อนไขหลังยกเลิก, rollback error อื่น, ลง ledger ตามแต้มที่เปลี่ยนจริง | `test_audit.py` |
| IMP-01/02 | CSV เข้มงวด, ไม่ตัด reference จนรวมคนละบิล, snapshot/preview token ผูกไฟล์และราคา, dedupe import พร้อมรองรับ XLSX | backend parser/import tests, CRM SQL, browser stale preview |
| FIN-01/02 | scalar snapshot exports ไม่โดน PostgREST row cap, ไม่ตัดกลาง journal, recovery หลัง commit, tax client_ref และ LINE outbox/retry identity | backend accounting/tax tests, SQL export/concurrency/outbox tests |
| DATA-01 | ยกเลิกการลบ Storage อัตโนมัติจากรายการอ้างอิงใน client ที่อาจโหลดไม่ครบ; ฟอร์มกันกดซ้ำ | `MenuAdmin.tsx`; เป็นการเปลี่ยนพฤติกรรมเพื่อป้องกันลบไฟล์ที่ยังใช้ |
| FE-01-13 / async | request/session generations, cache invalidation, stale401, member/stock/report races, modal focus/Escape/scroll, QR error, route recovery, limits, display expiry/token/timer | `frontend/e2e/audit-regression.spec.ts`, `tests/cache.test.ts`, discount tests |
| Validation/operations | strict JSON/PATCH/date/money, timeout/status/sanitized error, request ID, API/static headers, readiness, CI, pinned bootstrap/dependencies และ remote E2E opt-in | API regression, root tests, deploy dry-run, production PWA browser test |

**SEC-02 ยังต้องทำบนบริการจริง:** อัปเกรด staging จริงแล้วตามรายงาน staging-upgrade แต่ยังไม่ได้หมุน Supabase service-role/JWT secret และประสาน consumers ทั้งหมด การลบ secret จากไฟล์และตรวจ git ไม่ได้ revoke ค่าเดิม จึงยังเป็น release gate

## งานตามใบงาน

| งาน | ส่งมอบ | ขอบเขตที่ต้องเข้าใจ |
|---|---|---|
| P1-B1-B6 | แก้ทางเดิน SQL/UI ตาม audit และเพิ่ม regressions | Storage cleanup ที่ไม่ปลอดภัยถูกปิด ไม่มีการลบไฟล์แทนผู้ดูแล |
| P2-B1-B6 | แก้ limiter, promo transaction, แต้ม/search/races, tenant/owner concurrency, cron และ import | ยังคงต้องตรวจผู้ให้บริการจริงตาม release gates |
| P1-F1 | Add-ons มีราคา, รูป POS, price/name snapshots ถึงครัว/receipt/XML | ใช้ `option_choices` JSON ที่ validate ใน DB และ snapshot ต่อบรรทัด แทนเพิ่มสามตารางตามข้อเสนอเดิม |
| P1-F2 | `/tables`, zone/position/seats, elapsed status, move/merge และขอเช็คบิล | ขยับออเดอร์ที่ยังเปิด ไม่ย้ายเอกสารที่ชำระแล้ว |
| P1-F3 | แก้ received, แยกบรรทัด received/served, `/bills`/reprint, service/tip, คำนวณหารเท่ากัน | หารเท่ากันเก็บครบก่อนชำระหนึ่งครั้ง ไม่ใช่ partial tender หลายวิธี; การแยกที่ไม่มีฐานสต็อกให้จัดสรรอย่างถูกต้องจะถูกปฏิเสธ |
| P1-F4 | Kitchen ticket 80 มม., sound opt-in, auto print dialog, threshold settings | ต้องยืนยันเครื่องพิมพ์/สิทธิ์ browser จริง |
| P1-F5 | Audit แบบ append-only, manifest/SW, IndexedDB order queue และ client_ref | คิวรอส่งไม่เท่ากับครัวได้รับ ต้องกดส่งหลังกลับออนไลน์; ไม่เก็บ API response ใน SW |
| P2-F1 | Coupon lookup/input, unique ต่อร้าน, stackability, promo report | โปรซ้อนต้องไม่ชนรายการตามกติกาเดิม; attribution ไม่ใช่ยอดรวมสุทธิ |
| P2-F2 | ค้นท้าย 4 ตัว/เลือกเมื่อซ้ำ, owner export/delete, `/privacy`, feedback 1-5 และรายงาน | การลบสมาชิกไม่ทำลายข้อมูลการเงิน; ร้านต้องกำหนด contact/retention และตรวจตัวผู้ขอ |
| P2-F3 | Morning digest/settings, low stock/expiry, CSV/XLSX validation/preview | ต้อง deploy Worker Cron และทดสอบ LINE delivery จริง |
| P2-F4 | Persisted System/Light/Dark และ TH/EN; catalog ข้อความ UI, print สีสว่าง | ไม่แปลข้อมูลลูกค้า/เมนู/หมายเหตุที่ผู้ใช้กรอก และชื่อข้อมูลทางบัญชีที่เก็บใน DB |
| P2-F5 | Windows/Linux CI, tax/shift/stock/staff endpoints/OpenAPI, active account UI | CI ที่ประกาศในไฟล์ต้องดูผลบน GitHub อีกครั้ง; remote activation ไม่ได้ทำในรอบ local |

## ผล verification

- Frontend production build และ backend typecheck ผ่าน
- Backend API/unit **149/149** ผ่าน; frontend unit **10 ไฟล์** ผ่าน
- PostgreSQL ชั่วคราวใช้ migration ล่าสุด: RLS **502**, accounting **125**, stock **131**, audit **32**, POS **31**, CRM **22**; POS บน PostgreSQL 17 ที่รองรับ XML ผ่าน **32/32** รวม XML ภาษีจริง
- Browser regression แบบ mock ผ่าน **47/47** รวม CRM, การค้น/แบ่งหน้าบิล, พิกัดโต๊ะศูนย์, การแบ่งบิลโดยไม่หักโปรซ้ำ และการป้องกันกดซ้ำ
- `npm audit` frontend/backend **0 vulnerabilities** ตามฐาน advisory ณ วันตรวจ
- `npm run deploy -- --dry-run` ผ่านบน Windows; ไม่มีการ deploy จริง
- production asset headers และ service worker ติดตั้ง/เปิดหน้า login ออฟไลน์ได้จริง ไม่ cache API data; มีเทสต์ใน `frontend/e2e-production/pwa.spec.ts`
- ตรวจ secret patterns ในไฟล์ที่จะ review ไม่พบค่า token/secret จริง; เป็น pattern scan ไม่ใช่หลักฐาน revoke key
- XML execution skip ใน bundled PostgreSQL ที่ไม่มี libxml; ทดสอบซ้ำบน PostgreSQL 17 Docker แล้วผ่าน และ CI job `postgres-xml` ใช้ PostgreSQL 17 พร้อม `REQUIRE_XML_TESTS=1` เพื่อไม่ปล่อยผ่านการ skip

## ก่อน merge/release

1. หมุนความลับเดิมและตรวจ token/key เก่าใช้งานไม่ได้ พร้อมอัปเดต consumers
2. ตรวจข้อมูลเก่ายอดติดลบ: `select id,total from orders where total < 0;` reconcile บัญชี/ภาษี/แต้มก่อน validate constraint ห้ามแก้ประวัติด้วยการ clamp ยอดเป็นศูนย์
3. Staging เดิมอัปเกรด 0008-0011 แล้ว ผู้ใช้ต้องเข้าสู่ระบบใหม่ ดู [ผล staging/backup/UI](2026-11-22-staging-upgrade.md); production ปลายทางอื่นต้องตรวจและปล่อยอย่างประสานกัน
4. ตรวจผล CI ของ PR และทำ smoke test บน staging จริง (XML local PostgreSQL 17 ผ่านแล้ว)
5. Restore drill, printer, LINE/Realtime, production headers/monitoring และ UAT ตาม [operations](../operations.md)

ไม่อ้างว่าผ่านมาตรฐานทางกฎหมาย/ภาษีหรือพร้อม production จากผล local tests เพียงอย่างเดียว ข้อเสนออนาคต 10 ระบบและ AI เพิ่มเติมไม่ได้รวมในฟีเจอร์ 10 กลุ่มนี้

## ปรับตามผลใช้งานเพิ่มเติม

หน้าตรวจความพร้อมใช้ responsive skeleton พร้อม reduced-motion และ error/retry เดิม เพิ่มรายการบิลแบบย่อและ pagination 10/20/50 รวมสมาชิก audit ใบรับของ ประวัติสต็อก ใบนับ รายจ่าย ผู้ขาย พนักงาน เมนูและวัตถุดิบ ตรวจ staging จริงหน้าที่แก้ไม่พบ API/page error และมือถือไม่มี horizontal overflow

เพิ่ม AGENTS.md และ npm run check:copy เพื่อห้ามอักขระตกแต่งในข้อความโครงการ พร้อมแก้ UI/คู่มือให้ตรงกฎ
