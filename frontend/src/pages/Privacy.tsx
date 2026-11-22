import { Link } from 'react-router-dom'
import { useText } from '../lib/preferences'

export default function Privacy() {
  const text = useText()
  return <main className="page-narrow space-y-5">
    <h1 className="page-title">{text('ข้อมูลส่วนบุคคลของสมาชิก', 'Member privacy')}</h1>
    <section className="card space-y-3">
      <p>{text('ร้านเก็บชื่อ เบอร์โทร และประวัติแต้มเพื่อให้บริการสมาชิกและส่วนลด การสมัครเป็นทางเลือก ลูกค้าซื้ออาหารได้โดยไม่สมัครสมาชิก', 'The shop uses your name, phone number and points history for membership and discounts. Membership is optional; purchases do not require registration.')}</p>
      <p>{text('ติดต่อเจ้าของร้านที่คุณสมัครเพื่อขอดู ส่งออก แก้ไข หรือลบข้อมูล ก่อนส่งข้อมูลร้านจะตรวจสอบว่าเป็นเจ้าของข้อมูล', 'Contact the owner of the shop where you registered to request access, export, correction or deletion. The shop verifies your identity before releasing records.')}</p>
      <p>{text('การลบสมาชิกนำข้อมูลระบุตัวออกจากระบบสมาชิก ประวัติการขาย บัญชี และภาษีที่ร้านต้องเก็บยังคงอยู่โดยไม่ผูกกับสมาชิก ข้อมูลที่จำเป็นตามเอกสารภาษีและสำเนาสำรองต้องจัดการตามนโยบายเก็บรักษาของร้าน', 'Deleting a membership removes its identifying information. Required sales, accounting and tax records remain without the member link. Information required on tax documents and backups is handled under the shops retention policy.')}</p>
      <p>{text('คะแนนความพึงพอใจ 1-5 ไม่เก็บชื่อหรือเบอร์โทร ระบบใช้ผู้ให้บริการโฮสต์และฐานข้อมูลเพื่อดำเนินงาน ผู้ดูแลร้านต้องแจ้งช่องทางติดต่อ ระยะเวลาเก็บข้อมูล และผู้รับข้อมูลตามการใช้งานจริงของร้าน', 'Feedback ratings from 1 to 5 do not store your name or phone. Hosting and database providers support operation. The shop must publish its actual contact details, retention periods and data recipients.')}</p>
    </section>
    <Link className="link" to="/">{text('กลับหน้าแรก', 'Back to home')}</Link>
  </main>
}
