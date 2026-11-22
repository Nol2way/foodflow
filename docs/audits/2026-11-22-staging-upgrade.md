# อัปเกรด staging และแก้ UI หลังทดสอบจริง

วันที่ 22 พฤศจิกายน 2026 — project `oudncjhbyblhldqieffu` ผู้ใช้อนุญาตให้ใช้โปรเจกต์เดิมเป็น staging (Supabase CLI ยังเรียก branch นี้ว่า production; ไม่ได้สร้าง project แยก)

## ต้นเหตุและการแก้

- ฐานเดิมไม่มี `order_items.options_snapshot` และ session guard ใหม่ พร้อมขาด guard บางส่วนของ `0008` จึงอัปเกรด `0008–0011` หลังพิสูจน์กับสำเนาฐานแล้ว ไม่ตัด field ออกจาก query เพื่อซ่อนอาการ
- Modal กะเป็น `div.fixed` ใต้ container ของหน้า จึงติดขอบเขตหน้า เปลี่ยน dialog ทุกจุดเป็น portal ไป `body` + native top layer พร้อม keyboard/focus/scroll และป้องกัน event ไหลเข้าฟอร์มแม่
- ปรับ shared typography/spacing/radius/contrast/buttons/navigation และ validation ตาม [กติกา UI](../ui-system.md)
- แก้เปลี่ยนรหัสผ่านให้บันทึก access token ใหม่แทน token เดิมที่ถูก revoke และกัน response เก่าทับ session ที่เปลี่ยนแล้ว

## หลักฐานการสำรองและอัปเกรด

1. สำรอง schema, roles และ public/storage data รวม **2,392,700 bytes** ไว้นอก Git ที่ `D:/foodflow/private-backups/staging-20261122` พร้อม SHA-256 manifest; จำกัด ACL เฉพาะผู้ใช้ปัจจุบันและ SYSTEM
2. กู้ลง Docker Supabase PostgreSQL 17.12 แยกจาก remote แล้วเทียบ COPY rows แบบเรียงลำดับและ hash: **56 ตาราง / 9,798 แถว** ตรงกัน รวม **3,092 orders**
3. อัปเกรดสำเนาด้วย bundle `0008–0011`: ตรวจ **119 foreign-key relationships** ไม่มี orphan, XML well-formed และผลรวม net lines ตรงยอดเอกสาร, ไม่มี order ยอดติดลบ
4. ตรวจ hash ของ migration bundle และ backup ซ้ำก่อนรัน remote ใน transaction เดียว พร้อม lock timeout, statement timeout, validate nonnegative constraint และ reload PostgREST schema cache
5. หลัง remote commit: orders **3,092**, negative orders **0**, constraint validated และ `options_snapshot` มีจริง
6. `schema-preflight` และ local Worker `/api/readyz` ตอบ `ok:true, schema_version:0011`; query แบบ authenticated `orders?select=id,order_items(options_snapshot)&limit=1` ตอบ **200**
7. Browser เชื่อม staging จริงเปิด POS/Kitchen/Counter/Tables/Bills/Members/Settings/Audit ไม่พบ API 4xx/5xx หรือ page error ในการอ่านข้อมูล และเปิด dialog กะกลางหน้าจอได้ ไม่สร้างออเดอร์หรือรับเงินในการ smoke test นี้

ไม่มี migration history ของ Supabase เดิมให้ยึด จึงตรวจ schema/function ก่อนอัปเกรดและเก็บ manifest ของ bundle ห้ามรัน `0009–0011` ซ้ำบนฐานนี้โดยไม่ตรวจสถานะก่อน

## ข้อจำกัด

- Backup/restore ข้างต้นครอบคลุมข้อมูลฐานและ Storage metadata **ไม่รวมเนื้อไฟล์ใน Storage buckets** จึงยังไม่ใช่ full disaster-recovery drill ทุกบริการ
- ยังไม่ได้หมุน JWT/service-role secret เดิม หรือ deploy Worker ไป cloud ต้องประสาน consumers และตรวจคีย์เก่าใช้ไม่ได้ก่อนปล่อยจริง
- Session เก่าที่ไม่มี credential version ต้อง login ใหม่
- Printer/LINE delivery/Realtime reconnect และ UAT ธุรกรรมจริงยังต้องตรวจตาม [operations](../operations.md)
