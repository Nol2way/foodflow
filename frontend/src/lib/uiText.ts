import translations from './ui-translations'
import { getLanguage } from './preferences'

const common: Record<string, string> = {
  'ยืนยันรายการ': 'Confirm action', 'ยืนยัน': 'Confirm', 'สำเร็จ': 'Done', 'เกิดข้อผิดพลาด': 'Something went wrong', 'ตกลง': 'OK',
  'กำลังโหลดออเดอร์': 'Loading orders', 'กำลังโหลดเมนูและโต๊ะ': 'Loading menu and tables', 'กำลังตรวจสถานะ': 'Checking status', 'โหลดสถานะโต๊ะไม่สำเร็จ': 'Unable to load table status',
  'แยกชำระรายออเดอร์ (คงส่วนลดเดิม)': 'Pay orders separately (keep allocated discounts)',
  'ใช้ส่วนลดที่แบ่งไว้ในออเดอร์นี้ ไม่คำนวณโปรซ้ำ': 'Keep the discount allocated to this order without applying the promotion again.',
  'ออเดอร์ใหม่': 'New orders', 'เริ่มทำ': 'Start preparing', 'ทำเสร็จ': 'Ready', 'พร้อมชำระ': 'Ready to pay',
  'กำลังดำเนินการ': 'In progress', 'กำลังดำเนินการ...': 'Working...', 'ได้รับเงินแล้ว': 'Payment received',
  'รอเสิร์ฟให้ครบก่อนชำระ': 'Serve all items before payment', 'แสดง QR': 'Show QR', 'รับชำระ': 'Receive payment',
  'เงินสด': 'Cash', 'พร้อมเพย์': 'PromptPay', 'บัตร': 'Card', 'อื่นๆ': 'Other',
  'รอครัวรับออเดอร์': 'Waiting for kitchen', 'ครัวกำลังทำ': 'Kitchen is preparing', 'เสร็จ': 'Done',
  'เข้าสู่ระบบ': 'Sign in', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง': 'Incorrect email or password',
  'เลือกโต๊ะก่อน': 'Choose a table first', 'หมด': 'Sold out', 'ได้จากการซื้อ': 'Earned from purchase', 'แลกส่วนลด': 'Redeemed discount',
  'ปรับโดยร้าน': 'Shop adjustment', 'ยกเลิกบิล': 'Bill cancelled', 'ไม่พบคูปองที่ใช้ได้ในขณะนี้': 'No valid coupon found',
  'โหลดโปรโมชันไม่ครบ กรุณาลองใหม่': 'Promotion rules could not be loaded. Please retry.',
  'ข้อมูลมากเกินไป กรุณาเลือกช่วงวันที่ให้แคบลง': 'Too much data. Select a shorter date range.',
  'หน้าร้าน': 'Front of house', 'สต็อก': 'Stock', 'บัญชีและรายงาน': 'Accounts and reports', 'จัดการร้าน': 'Shop management',
  'เจ้าของร้าน': 'Owner', 'ผู้จัดการ': 'Manager', 'พนักงานหน้าร้าน': 'Front-of-house staff', 'ครัว': 'Kitchen', 'พนักงานบัญชี': 'Accountant', 'พนักงานสต็อก': 'Stock staff',
  'รับออเดอร์': 'Take orders', 'หน้าจอครัว': 'Kitchen', 'เสิร์ฟอาหาร': 'Serve', 'รับชำระเงิน': 'Checkout', 'บัญชี': 'Accounting',
  'ภาพรวมสต็อก': 'Stock overview', 'รับเข้า': 'Receive stock', 'รายงานส่วนต่าง': 'Stock variance', 'ประวัติสต็อก': 'Stock history',
  'โปรโมชัน': 'Promotions', 'นำเข้ายอดขาย': 'Import sales', 'รายงานรายวัน': 'Daily report', 'สมาชิก': 'Members',
  'ผังโต๊ะ': 'Table map', 'ประวัติบิล': 'Bill history', 'ประวัติการเปลี่ยนแปลง': 'Audit history',
  'รอครัว': 'Waiting for kitchen', 'รอเข้าครัว': 'Waiting for kitchen', 'กำลังทำ': 'Preparing', 'พร้อมเสิร์ฟ': 'Ready to serve', 'เสิร์ฟแล้ว': 'Served', 'รอชำระ': 'Awaiting payment',
  'ทานที่ร้าน': 'Dine in', 'กลับบ้าน': 'Takeaway', 'ชำระแล้ว': 'Paid', 'ยกเลิก': 'Cancel', 'บันทึก': 'Save', 'แก้ไข': 'Edit',
  'กำลังส่ง...': 'Sending...', 'กำลังบันทึก...': 'Saving...', 'ส่งเข้าครัว': 'Send to kitchen',
  'เปิดบัญชี': 'Enable account', 'ปิดบัญชี': 'Disable account', 'เปลี่ยนรหัสผ่าน': 'Change password', 'ออกจากระบบ': 'Sign out',
}

export function translateUi(thai: string): string {
  if (getLanguage() !== 'en') return thai
  return common[thai] ?? translations[thai] ?? thai
}
