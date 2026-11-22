# ชุด migration ของ FoodFlow

ฐานใหม่รัน `.sql` ระดับบนสุดตามลำดับ `0001` ถึง `0011` ห้ามรัน archive ต่อจากชุดนี้

| ไฟล์ | หน้าที่ |
|---|---|
| 0001_core.sql | ร้าน เมนู โต๊ะ ออเดอร์ บทบาท โปรโมชัน |
| 0002_display_payment_reports.sql | จอแสดงผล ชำระเงิน แต้ม รายงาน |
| 0003_users_inventory.sql | หลายบทบาท app_users หน่วย/น้ำหนัก/รับเข้า |
| 0004_accounting.sql | บัญชีคู่ (เดิม archive/0026) |
| 0005_stock.sql | Ledger/ล็อต สูตร การนับและสิทธิ์ (เดิม 0027–0030) |
| 0006_tax_shifts.sql | ภาษีและกะ (เดิม 0031–0032) |
| 0007_order_cancel_kitchen.sql | ยกเลิกรายเมนู/สิทธิ์ครัว (เดิม 0033–0034) |
| 0008_fix_accounting_stock.sql | สรุปไม่รวมรายจ่าย void; ยกเลิกบิลภาษีต้องมี CN ครอบคลุม; แก้ XML line amount |
| 0009_audit_invariants.sql | session/RLS, payment invariants, import/promo transaction, limiter/report retry และ recovery |
| 0010_pos_workflows.sql | ตัวเลือกเมนู snapshot, โต๊ะ, แก้/แยกบิล, ค่าบริการ/ทิป, audit และ client_ref |
| 0011_crm_ops_features.sql | คูปอง สมาชิก privacy/feedback, รายงานตอนเช้า และจัดการ identity |

## ฐานที่มีอยู่แล้ว

ตรวจประวัติและ definition จริงก่อน การมีตารางไม่ยืนยันว่ารันครบ หากใช้ archive ครบ 34 ไฟล์แล้ว ห้ามรัน 0001–0007 ซ้ำ ตรวจ schema เทียบชุดรวมและทดสอบ 0008 บนสำเนาก่อน apply

สำรองก่อนเปลี่ยน schema บันทึกไฟล์/commit/วันที่/ผู้รัน/ผลตรวจ โดยเฉพาะ SQL Editor ซึ่งอาจไม่มี CLI migration history อย่า reset หรือ seed ฐานที่มีข้อมูลจริง

ชุด database/tests สร้าง PostgreSQL ชั่วคราวพร้อม auth stub ทุก suite ใช้ discovery ของ migration เลขสี่หลักระดับบนสุด ส่วน test_stock.py มีฐานแยกสำหรับทดสอบอัปเกรด archive ด้วย รอบรวมนี้ใช้ 0009–0011 แทนการจองเลขตามคนในแผนเดิม เพื่อให้เรียง dependencies ได้แน่นอน

ก่อน apply 0009 ตรวจ `select id,total from orders where total < 0;` และกระทบยอดข้อมูลเดิม การเพิ่ม constraint แบบ NOT VALID ป้องกัน write ใหม่ แต่ไม่ได้รับรองยอดติดลบที่มีอยู่ ต้อง reconcile ก่อน `VALIDATE CONSTRAINT` ตามชื่อ constraint ใน migration ห้ามแก้ยอดย้อนหลังโดยไม่ตรวจ journal/tax/points

Session migration จะปฏิเสธ token เก่า ต้องประสานการปล่อย API/UI และให้ผู้ใช้เข้าสู่ระบบใหม่ ดู [operations](../../docs/operations.md) การทดสอบ XML บน Windows pgserver ที่ไม่มี libxml จะ skip อย่างชัดเจน; ต้องผ่าน Linux ที่รองรับ XML ก่อน release
