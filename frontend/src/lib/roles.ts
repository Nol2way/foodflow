// หมายเหตุ: ตารางนี้ใช้ซ่อน/แสดงเมนูในหน้าเว็บเท่านั้น
// สิทธิ์จริงบังคับที่ฐานข้อมูล (database/migrations/0003_roles.sql และ 0009_manager_promotions.sql)

import type { IconName } from '../components/Icon'

export type Role = 'owner' | 'manager' | 'staff' | 'kitchen' | 'accountant' | 'stock'

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'เจ้าของร้าน',
  manager: 'ผู้จัดการ',
  staff: 'พนักงานหน้าร้าน',
  kitchen: 'ครัว',
  accountant: 'พนักงานบัญชี',
  stock: 'พนักงานสต็อก',
}

export interface StaffPage {
  path: string
  title: string // ชื่อสั้นในแถบเมนู
  label: string // คำอธิบายบนหน้าแรก
  icon: IconName
  roles: Role[]
}

export const STAFF_PAGES: StaffPage[] = [
  { path: '/pos', title: 'รับออเดอร์', label: 'เลือกโต๊ะ/กลับบ้าน แล้วส่งเข้าครัว', icon: 'pos', roles: ['owner', 'staff'] },
  { path: '/kitchen', title: 'หน้าจอครัว', label: 'ออเดอร์ใหม่ กำลังทำ พร้อมเสิร์ฟ', icon: 'kitchen', roles: ['owner', 'staff', 'kitchen'] },
  { path: '/serve', title: 'เสิร์ฟอาหาร', label: 'ส่งโต๊ะไหน เสิร์ฟอะไรแล้ว', icon: 'serve', roles: ['owner', 'staff'] },
  { path: '/counter', title: 'รับชำระเงิน', label: 'รวมบิลตามโต๊ะ รับชำระ', icon: 'counter', roles: ['owner', 'staff'] },
  { path: '/accounting', title: 'บัญชี', label: 'รายรับ รายจ่าย กำไร', icon: 'accounting', roles: ['owner', 'accountant', 'manager'] },
  { path: '/stock', title: 'สต็อก', label: 'วัตถุดิบ รับเข้า ของเสีย', icon: 'stock', roles: ['owner', 'stock'] },
  { path: '/analytics', title: 'วิเคราะห์ + AI', label: 'ช่วงพีค/ออฟพีค คาดการณ์ ถาม AI', icon: 'analytics', roles: ['owner', 'accountant'] },
  { path: '/menu', title: 'จัดการเมนู', label: 'เมนู ราคา หมวด โต๊ะ', icon: 'menu', roles: ['owner', 'manager'] },
  { path: '/promotions', title: 'โปรโมชัน', label: 'ส่วนลดตามเงื่อนไขและช่วงเวลา', icon: 'promotions', roles: ['owner', 'manager'] },
  { path: '/import', title: 'นำเข้ายอดขาย', label: 'นำเข้ายอดขายเดิมจากไฟล์ CSV', icon: 'import', roles: ['owner', 'manager'] },
  { path: '/report', title: 'รายงานรายวัน', label: 'สรุปยอดวันนี้ ส่งเข้า LINE', icon: 'report', roles: ['owner', 'manager', 'accountant'] },
  { path: '/members', title: 'สมาชิก', label: 'สะสมแต้ม ค้นหา ปรับแต้ม', icon: 'members', roles: ['owner', 'manager'] },
  { path: '/settings', title: 'ตั้งค่าร้าน', label: 'พร้อมเพย์ ใบเสร็จ แต้ม LINE', icon: 'settings', roles: ['owner'] },
  { path: '/staff', title: 'จัดการพนักงาน', label: 'เพิ่ม เชิญ เปลี่ยนบทบาท', icon: 'staff', roles: ['owner', 'manager'] },
]

export function rolesFor(path: string): Role[] {
  return STAFF_PAGES.find((p) => p.path === path)?.roles ?? []
}

// ผู้จัดการแต่งตั้ง/แก้ได้เฉพาะบทบาทเหล่านี้ (ฐานข้อมูลบังคับซ้ำ)
export const MANAGER_ASSIGNABLE: Role[] = ['staff', 'kitchen', 'accountant', 'stock']
