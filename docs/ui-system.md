# รูปแบบหน้าจอและเกณฑ์ตรวจ UX

ปรับรอบ 22 พฤศจิกายน 2026 ตาม UI/UX Pro Max สำหรับเว็บ POS ที่พนักงานใช้กับมือถือ แท็บเล็ต และ desktop ยังคง IBM Plex Sans Thai และสี terracotta เดิม ไม่ใช้คำแนะนำ landing-page หรือฟอนต์ตกแต่งจากผลค้นที่ไม่ตรงงาน POS ไม่พบสกิลชื่อ unslop ในแหล่งที่ติดตั้งไว้ จึงไม่อ้างว่าใช้สกิลนั้น

## กติกาที่ใช้ร่วมกัน

| ส่วน | การใช้งาน |
|---|---|
| Typography | ฟอนต์ไทยเดิม, ฐาน 16px, ข้อความย่อย 15px, คำอธิบายเล็ก 13px, line-height 1.5–1.6; ช่องกรอก 16px ลดการซูมอัตโนมัติบนมือถือ |
| Spacing | ใช้ระยะ 4/8/16/24/32px ตามลำดับความสำคัญ; gutter 16px บนมือถือและ 24px บนจอใหญ่ |
| Border radius | ช่องกรอก/ปุ่ม 10px, card/dialog 14px; ลด chip ที่โค้งมากเกินจำเป็น |
| Color/contrast | ปุ่มหลัก terracotta เข้ม, สำเร็จเขียวเข้ม, ลบแดงเข้ม; ตรวจปุ่มหลักกับตัวอักษรขาว ≥4.5:1 ทั้ง light/dark แยกกัน; ข้อความรองต้องไม่จางจนอ่านไม่ออก |
| Buttons | `.btn`/`.btn-sm` สูงและกว้างขั้นต่ำ 44px, loading/disabled ชัดเจน, ไม่ขยาย/ย่อปุ่มจนตำแหน่งเปลี่ยนตอนกด, รองรับข้อความหลายบรรทัด |
| Responsive | ทดสอบ 375/768/1024/1440px และ modal ในจอแนวนอน; ตารางเลื่อนภายใน ไม่ดันทั้งหน้า |
| Navigation | มี skip link, `aria-current`, กลุ่มเมนูอ่านชัด; เมนูมือถือใช้ dialog กักโฟกัสและคืนโฟกัสเมื่อปิด |
| Feedback | โหลด/บันทึก/ข้อผิดพลาดแสดงข้อความ; schema ไม่พร้อมบล็อกหน้าทำรายการพร้อมปุ่มลองใหม่ ไม่แสดงหน้าร้านที่โหลดข้อมูลได้ครึ่งเดียว |
| Inline validation | login, เปลี่ยนรหัสผ่าน และเงินเข้า/ออกกะแสดง error ผูกช่องด้วย `aria-describedby`/`aria-invalid`; submit พาไปจุดผิด; login มีสรุป error ที่โฟกัสได้ |

## Modal

ทุก dialog ใช้ `components/Modal.tsx`: React portal ไป `document.body`, native `showModal()` อยู่ top layer, กลาง viewport, สูงไม่เกิน viewport และเลื่อนภายในได้ ไม่ใช้ `z-index` แก้ปัญหา ancestor ที่มี transform/contain

ใช้ label ที่บอกหน้าที่, ปุ่มปิดมีชื่อ, Escape ปิดได้เมื่อไม่ได้บันทึก, ปิด dialog ซ้อนไม่ปิดตัวแม่, lock scroll แบบนับจำนวน dialog, คืนโฟกัสให้ปุ่มเปิด และหยุด submit/click/cancel ไม่ให้ไหลเข้าฟอร์มต้นทาง การพิมพ์ใบเสร็จยังใช้ print stylesheet

ห้ามเพิ่ม overlay แบบ `div.fixed` สำหรับฟอร์มใหม่ ให้ใช้ shared dialog และเพิ่ม regression หากมีพฤติกรรมต่างจากปกติ

## Schema compatibility

`DatabaseReady` ตรวจ `/api/readyz` ก่อน mount หน้าข้อมูล API ตรวจ metadata ของ columns/RPC พร้อม zero-row probe; `schema_version:0011` เป็น compatibility contract ไม่ใช่ใบรับรอง RLS หรือหลักฐาน migration history

หน้า login เปิดได้โดยไม่โหลดข้อมูลร้าน ส่วน offline POS เปิดได้เฉพาะแท็บที่เคยยืนยัน schema ล่าสุดแล้ว มีเมนู snapshot และคิวเดิมตามคู่มือฟีเจอร์ ไม่ถือว่าคิวออฟไลน์ส่งถึงครัวแล้ว

## หลักฐาน

- `e2e/modal-regression.spec.ts`: geometry กลาง viewport แม้อยู่ใน form ที่มี transform/paint containment, keyboard, focus, nested dialog, busy guard และ inline validation
- `e2e/ux-readiness.spec.ts`: schema mismatch ไม่อ่านข้อมูลร้าน, retry, responsive login, light/dark contrast, mobile navigation และ session ใหม่หลังเปลี่ยนรหัสผ่าน
- `e2e/audit-regression.spec.ts`: เส้นทาง POS/รับชำระ/CRM/ครัวที่ใช้งานจริงผ่าน API จำลอง

ผลเหล่านี้เป็นขอบเขตที่ทดสอบ ไม่ใช่การรับรอง WCAG ทุกข้อหรือยืนยันว่าไม่เกิดบั๊กได้อีกทุกกรณี
