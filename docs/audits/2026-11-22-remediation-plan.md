# FoodFlow comprehensive remediation implementation plan

**Goal:** แก้ข้อค้นพบ audit และส่งมอบ P1-F1–F5/P2-F1–F5 ตามใบงาน ก่อน commit/push/PR ภาษาไทย

**Architecture:** ต่อเติม React/Vite, Hono Worker และ PostgreSQL/RLS เดิม ใช้ migration เพิ่มแทนแก้ประวัติข้อมูล ผูกธุรกรรมเงินกับ snapshot และ idempotency ที่ฐานข้อมูล ส่วน UI ต้องแสดงข้อมูลตรง request/session และกู้คืนข้อผิดพลาดได้

**Tech Stack:** Node 22.20, Python 3.13, React, TypeScript, Hono, Cloudflare Worker, Supabase/PostgreSQL

**Spec:** [audit](2026-11-22-project-audit.md), [person-1](../tasks/2-people/person-1-pos-kitchen.md), [person-2](../tasks/2-people/person-2-crm-ops.md); ผู้ใช้ยืนยันรวมฟีเจอร์ 10 กลุ่ม

## ข้อกำหนดร่วม

- ไม่ commit secret; การหมุน secret/deploy จริงต้องมีหลักฐาน ไม่ใช่เพียงแก้คู่มือ
- ทุกคำสั่ง shell ใช้ RTK; ทดสอบ database ด้วย PostgreSQL ชั่วคราว
- แยกเจ้าของไฟล์ frontend/backend/database/tooling และตกลง RPC contract ก่อนเชื่อม
- เผยแพร่เฉพาะผลที่ตรวจแล้ว; ไม่ถือว่า pending release operation เสร็จ

## ลำดับงานและเกณฑ์ตรวจ

- [ ] SQL invariants: session revocation, shared identity, payment allocation, points ledger, promotion transaction, tenant helpers/last owner, import replay; regression บน migration ล่าสุด
- [ ] API: validation, distributed throttling, pagination, postcommit outcome, timeout/error sanitization, cron dispatch/date; unit/API regression
- [ ] UI: audit FE-01–13 และ P1/P2 bugs; browser mocks ครอบคลุม races/payment/ABB/import
- [ ] CI/bootstrap: pinned toolchain, Windows/Linux, database discovery, dependency updates, static/API headers และ remote E2E opt-in
- [ ] P1-F1/F2: priced options + media, table map/move/merge/bill request; tenant/price snapshots และ UI verification
- [ ] P1-F3/F4: edit/split/bills/service/tip, kitchen tickets/audio/configured late status; financial regression และ print preview
- [ ] P1-F5: immutable audit และ offline queue + idempotent client_ref; retry/reconnect/cross-session tests
- [ ] P2-F1/F2: coupons/stack rules/report, member lookup/export/delete/privacy/feedback; role and ambiguity tests
- [ ] P2-F3/F4: morning digest/stock alerts/xlsx, persisted dark/TH-EN; parsing/timezone/theme/print tests
- [ ] P2-F5: missing tax/shift/stock/staff HTTP API and OpenAPI; contract tests
- [ ] รวม migration/API/UI แล้วรัน build/typecheck/tests/audit, ตรวจ diff/secret, อัปเดตคู่มือและสถานะจริง
- [ ] commit + push fork และเปิด PR upstream พร้อมสรุปไทยสั้นและข้อจำกัด release

## Review focus

1. สองเครื่องทำธุรกรรมเดียวกันพร้อมกันต้องไม่เกิดเงิน/แต้ม/เลขเอกสารซ้ำ
2. บัญชีมีหลายร้านและเปลี่ยน session ระหว่าง request ต้องไม่ข้าม tenant
3. Offline/response หายหลัง commit ต้อง retry ด้วย identity เดิมและคืนผลเดิม
4. ข้อมูลมูลค่าน้อย/เศษสตางค์/โปรหมดอายุ ต้องรักษายอดและ ledger
5. Production config, credential rotation, restore และ printer/provider ต้องแยกผลทดสอบจริงจาก local mock
