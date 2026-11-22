# สารบัญคู่มือ FoodFlow

หลังแก้: [ผล remediation](audits/2026-11-22-remediation-results.md) · [คู่มือฟีเจอร์ P1/P2](features.md) · [ติดตั้ง/ปล่อย/restore](operations.md)

ผลตรวจล่าสุด: [Project audit 22 พฤศจิกายน 2026](audits/2026-11-22-project-audit.md) — บั๊กที่ยืนยันแล้ว ความเสี่ยง งานค้าง และเกณฑ์ก่อนใช้งานจริง

อ่าน [ผลตรวจความพร้อม](project-readiness.md) → [ติดตั้ง](SETUP.md) → [บริบทรายวิชา](course-context.md) → [ใบงานสองคน](tasks/2-people/README.md)

| เอกสาร | ใช้สำหรับ |
|---|---|
| [requirements](requirements.md) | ความต้องการ สถานะ หลักฐาน |
| [analysis-design](analysis-design.md) | สถาปัตยกรรมและเส้นทางข้อมูลจริง |
| [api](api.md) / [OpenAPI](openapi.json) | HTTP endpoints และ authentication |
| [accounting](accounting.md) | บัญชีคู่ ภาษี ปิดวัน |
| [stock](stock.md) | สต็อกปัจจุบัน FEFO/FIFO, blind count, AvT |
| [inventory-seafood](inventory-seafood.md) | ประวัติแบบเดิม ไม่ใช่คู่มือใช้งานปัจจุบัน |
| [development](development.md) | Git กติกากลาง นิยามเสร็จ |
| [testing](testing.md) | วิธีทดสอบ ผลจริงและผลประวัติ |
| [evaluation](evaluation.md) | แบบประเมินและข้อมูลที่ยังต้องเก็บ |
| [person-1](tasks/2-people/person-1-pos-kitchen.md) | หน้าร้าน ออเดอร์ โต๊ะ เมนู ครัว |
| [person-2](tasks/2-people/person-2-crm-ops.md) | สมาชิก โปร รายงาน ระบบกลาง |
| [proposed-systems](tasks/2-people/proposed-systems.md) | ข้อเสนออนาคตนอกขอบเขตรอบนี้ |
| [migration guide](../database/migrations/README.md) | ลำดับ 0001–0008 และ archive |

ต้นทางผู้ใช้อยู่ `D:/foodflow/docs`: PDF 9 ไฟล์ 119 หน้า, PNG 1 ภาพ, Markdown 4 ไฟล์ สรุปครบใน course-context โดยแยกข้อกำหนดกับตัวอย่าง ไม่คัดลอก credential เข้า repository
