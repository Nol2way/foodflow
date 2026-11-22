# FoodFlow — ผลตรวจโครงการ 22 พฤศจิกายน 2026

> เอกสารนี้เป็น snapshot ก่อนแก้ ใช้เก็บหลักฐานเดิม สถานะ implementation ล่าสุดดู [คู่มือฟีเจอร์](../features.md) และ remediation results; ตัวเลข/ข้อค้นพบด้านล่างไม่ใช่ผลหลังแก้


**ข้อสรุป: ยังไม่พร้อมเปิดใช้งานจริงกับข้อมูลร้านและการรับเงินจริง** แม้ build และชุดทดสอบส่วนใหญ่ผ่าน พบปัญหาการกู้บัญชีข้ามร้าน การบังคับสถานะ session และความถูกต้องของยอดรับชำระ/เอกสารที่ต้องแก้ก่อน รายงานนี้เป็นการตรวจซอร์สและทดสอบเฉพาะจุด ไม่ใช่ใบรับรองมาตรฐานหรือการรับรองทางกฎหมาย

ตรวจ revision `2dc0dcc` บน branch `chore/project-readiness` ของ `D:/foodflow/app` ครอบคลุม frontend, Worker API, migration ที่มีผลถึง `0008`, RLS, dependency, ขั้นตอนทดสอบ/deploy และใบงาน person-1/person-2 ใช้เอกสารรายวิชาที่สรุปใน [course-context](../course-context.md) เป็นบริบท ไม่ถือว่าฟีเจอร์ข้อเสนอทั้งหมดเป็นมาตรฐานบังคับ

ไม่มีการแก้ business code, migration, credential หรือข้อมูล Supabase จริงในรอบ audit การทดสอบเพิ่มเติมใช้ API mocks และ PostgreSQL ชั่วคราว ข้อค้นพบด้านความปลอดภัยเก็บในเครื่อง ยังไม่ได้เผยแพร่ขึ้น GitHub

## วิธีอ่านและหลักเกณฑ์

- **P0**: ต้องปิดก่อน release — ยึดบัญชีข้ามขอบเขตหรือความลับที่อาจให้อำนาจสูง
- **P1**: กระทบสิทธิ์ เงิน เอกสาร หรือข้อมูลสูญหาย ต้องแก้ก่อน pilot ที่ใช้ข้อมูลจริง
- **P2**: ความถูกต้องของ workflow, การกู้คืน, UX และการปฏิบัติการ ต้องมีเจ้าของงานและเกณฑ์ปิด
- **ยืนยัน**: ทำซ้ำด้วยข้อมูลจำลอง/ฐานชั่วคราวแล้ว; **ซอร์ส**: พบเส้นทางจากโค้ดแต่ยังไม่ได้ทดสอบปลายทางจริง; **ยังไม่ตรวจ**: ต้องตรวจ deployment/ผู้ให้บริการเพิ่มเติม

ใช้ [OWASP ASVS 5.0](https://asvs.owasp.org/) และ [REST Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html) เป็นกรอบตรวจสิทธิ์ session input และ error handling; ใช้ [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) ตรวจ boundary ของ browser → database และ [WCAG 2.2](https://www.w3.org/WAI/WCAG22/quickref/) ตรวจ keyboard, labels และ status messages ยังไม่ได้ทำ ASVS/WCAG ทุกข้อ จึงไม่สรุปว่าผ่านระดับใด

รายละเอียด source line, วิธีแก้ และ acceptance ของแต่ละข้ออยู่ใน [backend audit](2026-11-22-backend.md) และ [frontend audit](2026-11-22-frontend.md) ด้านล่างเป็นรายการรวมเพื่อจัดงาน ข้อที่ทับกับใบงานเดิมไม่ควรนับเป็นบั๊กใหม่อีกครั้ง

## 1. สิทธิ์และบัญชี — ปิดก่อนใช้งานจริง

| ID | ระดับ / หลักฐาน | ปัญหาและผลกระทบ | สิ่งที่ต้องแก้และเกณฑ์ผ่าน |
|---|---|---|---|
| SEC-01 | P0 · ยืนยัน mock API + ซอร์ส SQL | Manager ร้าน A reset รหัสบัญชีที่เป็น staff A และ owner B ได้ เพราะตรวจ role เฉพาะ A แล้วเปลี่ยนรหัสของ global user และคืนรหัสชั่วคราว | ย้าย recovery ไป identity-level หรือจำกัดสิทธิ์แบบ atomic ให้ผู้ดูแลร้านยึด identity ที่มีสิทธิ์ร้านอื่นไม่ได้; ทดสอบ multi-shop และ membership เปลี่ยนพร้อม reset |
| SEC-02 | P0 · พบในเอกสารก่อนหน้า; rotation ยังไม่ยืนยัน | เอกสารต้นทางเคยมี service-role และ JWT signing secret แม้ล้างออกจากคู่มือแล้ว ไม่ได้ทำให้ค่าเดิมหมดอายุ; ยังไม่มีหลักฐานว่าบุคคลอื่นนำไปใช้ | หมุนความลับที่เกี่ยวข้อง ตรวจผู้ใช้งาน/consumer อัปเดต private environment และยืนยันค่าเดิมใช้ไม่ได้; ห้ามนำ secret ใส่รายงาน/commit |
| SEC-03 | P1 · ยืนยัน first-login API และ SQL helper; revocation ตรวจซอร์ส | `must_change_password` จำกัดผ่าน UI แต่ JWT มีสิทธิ์เต็ม; เปลี่ยนรหัสไม่ revoke token; ปิดบัญชีแล้ว `has_role` ยัง true ผ่าน direct DB membership | ใช้ session version/revocation และ first-login scope ที่ Worker/RLS/RPC ตรวจร่วมกัน; token เก่าต้องใช้ API และ direct DB ไม่ได้; ตรวจ Realtime ที่เปิดค้างแยกต่างหาก |
| SEC-04 | P1 · ซอร์ส · P2-B1 | Auth limiter อยู่ใน memory ต่อ isolate และล้าง Map เมื่อเต็ม จึงรักษาเพดานร่วมทุก instance ไม่ได้ | ตัวนับร่วมที่มีขอบเขตและไม่ล้าง active bucket; ทดสอบหลาย isolate, capacity, expiry และไม่ให้การโจมตี IP หนึ่งทำให้ account bucket ถูกใช้ผิดความหมาย |
| SEC-05 | P2 · ซอร์ส · P2-B4 | `promotion_uses_count` / `staff_is_senior` รับ ID ข้ามร้านได้โดยไม่มี caller guard; `keep_last_owner` ไม่มี lock ต่อร้าน เสี่ยง write skew | จำกัด helper ตาม tenant โดยไม่ทำให้ RLS recursion; ทดสอบข้ามร้านและ concurrent ลบ/ลดบทบาทเจ้าของสองคน ต้องเหลือ owner อย่างน้อยหนึ่งคน |

หลักฐานสำคัญ: `backend/src/app.ts:408`, `database/migrations/0003_users_inventory.sql:288,357`, `0001_core.sql:129,323,1687` การทดสอบ SQL พบ `has_role(..., ['staff']) = true` หลังตั้ง `is_active=false`; เป็นผลของ policy helper ไม่ใช่การอ้างว่าได้ทดสอบ Realtime production แล้ว

## 2. ยอดเงิน การรับชำระ เอกสาร และข้อมูล

| ID | ระดับ / หลักฐาน | ปัญหา | แนวทางและ acceptance |
|---|---|---|---|
| PAY-01 | P1 · ยืนยัน DB · P1-B1 | staff เปลี่ยน `served → paid` ตรงได้ และ `payment_method` ยัง null ข้ามรับชำระ/โปร/แต้ม | ปิด direct transition บังคับ payment transaction; test owner/staff/kitchen ทั้ง direct table และ RPC พร้อมกระทบยอด |
| PAY-02 | P1 · ยืนยัน DB · P1-B4 | 10 ออเดอร์ใบละ 0.01 บาท แลกแต้ม 0.09 บาท ทำให้ใบสุดท้ายเป็น **-0.08 บาท** แม้ยอดรวมยัง 0.01 | กระจายส่วนลดไม่เกินยอดแต่ละใบและเก็บผลรวมให้ตรง; ตรวจข้อมูลเก่าก่อนเพิ่ม constraint; ทดสอบเศษสตางค์/หลายใบ/ยอดศูนย์ |
| PAY-03 | P1 · ยืนยัน Browser · FE-01 | QR เปิดที่ 100 บาท พอมีออเดอร์เพิ่มกลายเป็น 200 บาท และ confirm ส่งทั้งสองใบ; ลูกค้าอาจโอนยอดเดิม | ผูก quote กับ order IDs/ยอด/โปร/แต้ม/วิธีจ่าย; ข้อมูลเปลี่ยนต้องยืนยันใหม่; ทดสอบสองแคชเชียร์และ realtime ระหว่างเปิด QR |
| DOC-01 | P1 · ยืนยัน Browser · FE-02 | จ่ายสองใบใบละ 100 แต่ออก ABB สำเร็จหนึ่งใบ พิมพ์รายการสองใบใต้ ABB เดียวและสร้างส่วนลด 100 ที่ไม่เกิดจริง | ผูกรายการกับ `doc.order_id`; แสดงใบที่ยังออกไม่ได้และ retry ได้; ตรวจ 0/1/ทุก ABB กับยอดและรายการของแต่ละใบ |
| PAY-04 | P1 · ยืนยัน Browser · FE-03 | โหลด settings ได้ 500 แล้ว fallback เป็น cash และไม่เรียก receipt/ABB หลังชำระสำเร็จ | แยก loading/missing/error, ระบุ payment method ชัด, ไม่ยืนยันเมื่อ quote ไม่พร้อม และ receipt ต้องเรียกคืนได้ |
| ORD-01 | P1 · ยืนยัน Browser · P1-B2 | POS ปลด sending ก่อนอ่านยอด/ล้างตะกร้า กดส่งซ้ำได้ระหว่างรอ | ล็อกตลอด lifecycle และเพิ่ม server idempotency สำหรับ response หาย; retry ต้องได้ order เดิม |
| PROMO-01 | P1 · ซอร์ส · P1-B4/P2-B2/FE-05 | ยกเลิกรายการแล้ว SQL catch ทุก error และล้างโปรทั้งหมด; บันทึกโปร/links แยก transaction; อ่านโปรพลาดตอนจ่ายอาจส่งรายการว่างเพื่อลบส่วนลดเดิม | atomic promo save, แยก domain failure จาก infrastructure failure, quote จากข้อมูลครบ; test หนึ่งโปรหมดเงื่อนไขแต่โปรอื่นยังใช้ได้และ read/write failures |
| CRM-01 | P1 · ยืนยัน DB · P2-B3 | ย้อนแต้มที่เคยได้ 5 ตอนคงเหลือ 0: balance ยัง 0 แต่ ledger ลง -5 ทำให้ยอดกับประวัติไม่ตรง | ล็อกสมาชิกและลง actual delta หรือนโยบายหนี้แต้มที่ชัดเจน; ยอดคงเหลือต้อง reconcile ledger หลัง cancel/redeem พร้อมกัน |
| IMP-01 | P1 · ยืนยัน Browser · FE-04/P2-B6 | preview A ตอบหลังเลือก B แล้วเปิดให้ import B โดยไม่ได้ review B | ผูก content version/options กับ preview และ commit; test เปลี่ยนไฟล์/skip option ระหว่าง request และ file read ล้มเหลว |
| IMP-02 | P1 · parser ยืนยัน; duplicate ซอร์ส | ส่ง import เดิมซ้ำสร้าง batch/order ใหม่; malformed `1,2` ถูกแปลงเป็น 12, reference ถูกตัดก่อน grouping จนอาจรวมคนละบิล | idempotency/duplicate preview, strict CSV/decimal syntax, ไม่ตัด identity; ราคาที่ import ต้องตรง preview หรือบังคับ review ใหม่ |
| FIN-01 | P1 · ซอร์ส | journal/expense export ไม่มี pagination ครบ; cap อาจตัดกลาง journal entry; รายการภาษีถึง cap ทำให้สรุปจาก UI ไม่ครบ | export snapshot ที่เรียงแน่นอน ครบทั้ง entry พร้อมแจ้งขีดจำกัด; test เกิน PostgREST cap และ debit=credit; cap production ยังไม่ตรวจ |
| FIN-02 | P1 · day-close ยืนยัน mock; shift/tax ซอร์ส | ปิดวัน commit แล้ว notification/settings fail แต่ตอบ 500; shift/tax มี outcome ที่ client กู้คืนไม่ชัด | แยก committed result กับ delivery failure, retrieval by ID และ idempotency; ทดสอบ fail ก่อน/หลัง commit และ response หาย |
| DATA-01 | P1 · ซอร์ส · P1-B3 | media query ล้มเหลวถูกแทนด้วยรายการว่าง แล้ว cleanup อาจลบไฟล์ที่ยังอ้างอิง | ล้างเฉพาะเมื่ออ่าน reference ครบและสด; test error, truncated list, concurrent edit และ empty จริง |

SQL ที่มีผล: `0007_order_cancel_kitchen.sql:135–165` กับ policy `0001_core.sql:377`; allocation `0002_display_payment_reports.sql:593–604`; reversal `0002:645–661` ชุดทดสอบฐานชั่วคราวใช้ migration ทั้ง 0001–0008 และ rollback fixture ทั้งหมด

## 3. ความถูกต้องของหน้าเว็บและ API ที่ยังต้องแก้

| กลุ่ม | ข้อค้นพบ / สถานะ | วิธีปิดงาน |
|---|---|---|
| Async/cache · P2 | ยืนยัน cache เก่าเขียนหลัง invalidate, Report วันเก่าทับวันใหม่และข้อความ LINE, ledger สมาชิกเก่าทับคนที่เลือก; stock loader และ member phone lookup เสี่ยงแบบเดียวกันจากซอร์ส | key + request/session generation; ปิด mutation เมื่อข้อมูลไม่ตรง context; ทดสอบสลับ A→B และผลสำเร็จ/ล้มเหลวตอบสลับกัน (P1-B5, P2-B3/B5, FE-09/10) |
| Session UI · P2 | ยืนยัน request เก่าตอบ 401 แล้ว logout บัญชีใหม่; role hint/idle expiry ต้องจัดการเพิ่มจากซอร์ส | ผูก invalidation กับ session ที่ออก request; cross-tab switch ต้องไม่แสดงข้อมูลบัญชีเดิม (FE-06) |
| Validation · P2 | ยืนยัน PATCH profile ไม่ส่ง phone แล้วล้าง phone, JSON เสียยัง write/200, `counted_cash:true` กลายเป็น 1, วันที่ไม่มีจริงผ่าน HTTP validator | schema runtime, PATCH omission semantics, exact finite money/real date; invalid input ต้อง 4xx และไม่มี write |
| API resilience · P2 | ซอร์ส: fetch ไม่มี timeout, upstream HTML แปลงเป็น generic500, DB error บางประเภทถูกส่งตรง, object tenant ไม่ผูกกับ request tenant หากผู้ใช้มีสิทธิ์ทั้งสองร้าน | timeout/error mapping/request ID/sanitization; reject tenant mismatch; contract tests ตรวจ request/response จริง ไม่ใช่เพียง route parity |
| Cron/report · P2 | mock ยืนยันส่งรอบเดียวกันซ้ำ, hour ว่างกลายเป็น 0; ซอร์สใช้ wall clock แทน scheduledTime; paid revenue ใช้ created_at ต่างจาก accounting paid_at | กำหนด business date, durable dispatch ID/retry; test เที่ยงคืน Bangkok, delayed cron และส่งซ้ำ (P2-B5) |
| Promotion selection · P2 | Node ยืนยัน greedy เลือกส่วนลด 60 แทนคู่ที่ใช้ร่วมกันได้รวม 80; form expired date constraint ไม่ตรงกติกา save | ระบุ optimization/tie rules และใช้กติกาตรงกัน FE/SQL; test line เปลี่ยนแล้ว promo ซ้อนกัน (FE-08/P2-B2) |
| Accessibility · P2 | Browser ยืนยัน QR dialog ไม่จัด focus/Escape และปุ่มล้นจอ 640×320; source พบ pointer-only member rows, checkbox ซ่อนจาก keyboard, label/status semantics ขาด | keyboard-only + focus trap/restore + scroll/reflow + screen-reader checks; ไม่ถือว่า aria-modal อย่างเดียวเพียงพอ (FE-07) |
| Recovery/limits · P2 | ซอร์ส: lazy route ไม่มี error boundary; UI สร้างเกิน 50 lines / โต๊ะมีเกิน 50 orders แต่ RPC ปฏิเสธ | route retry/recovery และจำกัด/แบ่งรายการตั้งแต่ UI; test 50/51 และ chunk load fail (FE-11/12) |
| Display/QR · P2 | ซอร์ส: ราคาชั่งน้ำหนักขาด /กก., timer หลาย pointer/unmount ไม่ครบ, revoke display ไม่ทันทีและ offline เก็บข้อมูลเก่า; QR async rejection ไม่ล้างภาพเดิม | owner/generation ของ timer/request, expiry ของ cached content, ไม่คง QR ที่ผิดยอด; ข้อความคู่มือต้องตรง revocation latency (P1-B5/B6, FE-13) |

## 4. ช่องว่างด้านการส่งมอบและ production

1. **CI และ bootstrap ยังไม่ครบ (P2-F5):** ไม่มี `.github/workflows`; `npm test` ที่ root ล้มเหลวตรง Python dependency แม้มี `.venv` เพราะ script เรียก system `python3` ต้อง pin runtime/dependencies และให้ clone ใหม่รันคำสั่งที่บันทึกไว้ได้จริงบน CI/Windows
2. **Coverage ไม่ตรง schema ล่าสุด:** `test_rls.py` โหลดถึง 0007 ขณะที่ harness บัญชี/สต็อกโหลด 0008 แล้ว ต้องใช้ migration discovery เดียวกัน เพิ่ม regression ของ CN/XML ใน 0008, concurrency, money rounding, session lifecycle และข้อค้นพบนี้ อย่าใช้จำนวน test ผ่านแทนความครบของ coverage
3. **Dependencies:** npm audit พบ frontend 1 moderate package (Hono), backend 4 packages (3 moderate + 1 high; Hono, miniflare, undici, wrangler) ไม่ใช่ 4 ช่องโหว่ production ที่พิสูจน์ว่าโจมตีได้ Undici high อยู่ใน tooling chain; ต้องอัปเดต lockfile แบบตรวจ compatibility และทดสอบ build/Worker ใหม่ หลักฐาน [dependency-audit.json](D:/foodflow/audit-evidence/dependency-audit.json)
4. **Deploy/config:** root deploy command ใช้ executable path แบบที่มีปัญหากับ Windows shell; build ต้องแยก production API URL จาก `.env.local` ที่ชี้ localhost; ต้องมี staging และ smoke test จาก artifact ที่จะ deploy จริง ไม่ได้ทดลอง deploy ในรอบนี้
5. **Browser headers:** packaged Worker ที่ localhost:8790 `/login` และ `/api/health` ไม่มี CSP, X-Content-Type-Options, frame protection, Referrer-Policy/Permissions-Policy ใน response ที่ตรวจ ต้องกำหนด policy ให้เหมาะกับ assets/API และทดสอบ การตรวจ local นี้ไม่ยืนยัน config CDN production; HSTS ต้องตรวจ HTTPS production แยก
6. **Operations:** ยังไม่มีหลักฐาน restore drill, backup policy/RPO/RTO, dependency readiness, alerting/request tracing, migration rollback/runbook ที่พิสูจน์ recovery ได้ `/health` เป็น liveness ไม่ใช่การตรวจว่า DB พร้อม; กำหนด readiness แยกและไม่เปิดรายละเอียดภายในต่อสาธารณะ
7. **Test isolation:** Playwright เปิด frontend แต่พึ่ง backend ภายนอก และบาง suite เขียนข้อมูลบัญชี seed ต้องมี disposable DB/staging allowlist, credential สำหรับ test แยก และ guard ป้องกันรัน mutation ใส่ production รอบนี้ไม่รัน order-flow ที่แก้ remote data
8. **คู่มือและข้ออ้าง:** บางหน้าชี้ migration archive เมื่อเกิด load error ทั่วไป ต้องแยก network/auth/schema; XML download มีอยู่แต่ยังไม่มีหลักฐาน schema/signing/filing ครบ; privacy/export/delete และ retention ยังเป็นงานค้าง ไม่ถือว่ามีหน้า privacy แล้วเพียงพอสำหรับข้อกำหนดกฎหมาย

## 5. ขอบเขต person-1/person-2 ที่ยังไม่เสร็จ

บั๊ก **12 กลุ่ม** ในใบงานทั้งสองคนยังมีงานค้าง รายงานนี้ยืนยันบางกลุ่มด้วย executable probes และทบทวนซอร์สส่วนที่เหลือ รายการย่อยและหลักฐานอยู่ใน [frontend audit — tracked bugs](2026-11-22-frontend.md#tracked-bugs-at-current-revision) และ backend audit

ฟีเจอร์ **10 กลุ่มยังไม่ครบ** แต่หลายกลุ่มมีฐานเดิมแล้ว จึงไม่ควรเขียนใหม่ทั้งหมด:

| งาน | ส่วนที่ยังขาด |
|---|---|
| P1-F1 | ตัวเลือกเมนูมีราคา/price snapshot และส่งถึงครัว/ใบเสร็จ; รูปใน POS ใช้ระบบ media เดิม |
| P1-F2 | ผัง/ตำแหน่งโต๊ะ ย้าย/รวมโต๊ะ timer และขอเช็คบิล |
| P1-F3 | แก้ออเดอร์ แยกบิล ประวัติ/พิมพ์ซ้ำ service charge/tip |
| P1-F4 | Kitchen ticket 80mm เสียง/auto print และเวลาช้าที่ตั้งค่าได้ |
| P1-F5 | Audit log ข้าม workflow, PWA/offline queue และ server client_ref idempotency |
| P2-F1 | Coupon/stackability/รายงานผลโปร พร้อม selection ที่ถูกต้อง |
| P2-F2 | ค้นท้าย 4 ตัวและ ambiguity, member export/delete/privacy และคะแนนพึงพอใจ |
| P2-F3 | Morning LINE/stock-expiry alerts และ .xlsx import/preview |
| P2-F4 | Dark mode และ TH/EN ครบหน้า พร้อม print/accessibility |
| P2-F5 | CI, HTTP API ของบางงานภาษี/กะ/สต็อก และจัดการ active account; หลาย UI/RPC มีแล้ว |

ข้อเสนอ 10 ระบบใน [proposed-systems](../tasks/2-people/proposed-systems.md) และ AI analysis แยกเป็นอนาคต ไม่ใช่เงื่อนไขบังคับเพื่อให้ release ปัจจุบันปลอดภัยหรือผ่านมาตรฐาน

## 6. ผลทดสอบและข้อจำกัด

| การตรวจ | ผลรอบ audit |
|---|---|
| Frontend unit tests / production build | 8 test files ผ่าน / build ผ่าน |
| Backend tests / TypeScript | 130/130 ผ่าน / typecheck ผ่าน |
| Root `npm test` | ไม่ผ่าน: Python ของ root script หา pgserver ไม่พบ หลัง frontend/backend ผ่าน |
| DB โดย `.venv` ที่ติดตั้งแล้ว | RLS 501/501; accounting 125/125; stock 131/131 ผ่าน; RLS ใช้ถึง 0007 ตามข้อจำกัดข้างต้น |
| Backend probes ใหม่ | 8/8 ทำซ้ำพฤติกรรมผิดได้ (mock/offline) |
| Frontend probes ใหม่ | 8 browser scenarios และ 2 logic checks ทำซ้ำพฤติกรรมผิดได้ |
| DB probes ใหม่ | direct paid/null method, inactive role ยัง true, order total -0.08, ledger -5 แต่ balance ไม่เปลี่ยน |
| npm audit | มี advisory จึงไม่ผ่าน; แยก production library กับ dev tooling ตามข้อ 4 |
| Role E2E ของรอบเตรียมโปรเจกต์ | เดิม 10/10; ไม่ใช้แทน full E2E หรือสรุปว่าข้อค้นพบนี้ไม่มีอยู่ |

**Probes ผ่าน หมายถึงยืนยันบั๊กได้ ไม่ได้หมายความว่าแก้แล้ว** หลักฐานทำซ้ำอยู่ `D:/foodflow/audit-evidence/`: `backend-audit.test.mjs`, `frontend-repro.cjs`, `frontend-logic-repro.mjs`, `database-invariants.py` และ dependency JSON รันในเครื่องนี้ด้วย `rtk proxy node ...` หรือ `.venv/Scripts/python.exe`; browser probes ต้องมี Vite 5173 และ Edge ตาม setup ของเครื่อง ไม่ได้อ้างว่า harness นี้ portable ทุกเครื่องแล้ว

ยังไม่ได้ตรวจโหลดผู้ใช้จริง, network partition กับ provider, printer จริง, slip verification, LINE delivery จริง, screen reader ครบทุกหน้า, backup restore จาก Supabase จริง หรือ penetration test บน production จึงไม่มีข้อสรุปว่าประเด็นเหล่านั้นผ่าน

## 7. ลำดับแก้และเกณฑ์เปิดใช้งาน

1. **Identity boundary:** SEC-01/02/03 ก่อน ให้มี regression ข้ามร้าน/old token และปิดความลับเดิมได้จริง
2. **Money/document invariants:** PAY-01–04, DOC-01, ORD-01, CRM-01; ทุกยอดต้องไม่ติดลบและ receipt/ABB/ledger ต้องตรง business transaction
3. **Data safety/recovery:** PROMO/IMP/FIN/DATA, idempotency และผลหลัง commit; ห้าม retry แล้วเกิดบิล/batch/เลขเอกสารใหม่โดยไม่ตั้งใจ
4. **CI และ migration gate:** clone ใหม่ → bootstrap → build/typecheck/test/DB ล่าสุดผ่าน; เพิ่ม regression ที่เดิมยังปล่อยบั๊กผ่าน แล้วจึงทำฟีเจอร์ 10 กลุ่มตาม dependency ในใบงาน
5. **Pilot gate:** staging multi-role/multi-shop E2E, concurrent payments/owner edits, dependency remediation, production config/header check, restore drill, keyboard/payment-print acceptance และ runbook ที่ผู้ดูแลทำตามได้

จบ audit นี้ยังไม่มีข้อค้นพบใดถูกทำเครื่องหมาย “แก้แล้ว” การปิดแต่ละรายการต้องมี diff, regression ที่ตรวจ invariant และผลทดสอบกับ migration/config ที่จะปล่อยจริง
