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
  group: PageGroup // หัวข้อในแถบเมนู
  roles: Role[]
}

export type PageGroup = 'front' | 'stock' | 'finance' | 'admin'

// ลำดับหัวข้อในแถบเมนู
export const PAGE_GROUPS: { id: PageGroup; title: string }[] = [
  { id: 'front', title: 'หน้าร้าน' },
  { id: 'stock', title: 'สต็อก' },
  { id: 'finance', title: 'บัญชีและรายงาน' },
  { id: 'admin', title: 'จัดการร้าน' },
]

export const STAFF_PAGES: StaffPage[] = [
  { path: '/pos', group: 'front', title: 'รับออเดอร์', label: 'เลือกโต๊ะ/กลับบ้าน แล้วส่งเข้าครัว', icon: 'pos', roles: ['owner', 'staff'] },
  { path: '/kitchen', group: 'front', title: 'หน้าจอครัว', label: 'ออเดอร์ใหม่ กำลังทำ พร้อมเสิร์ฟ', icon: 'kitchen', roles: ['owner', 'staff', 'kitchen'] },
  { path: '/serve', group: 'front', title: 'เสิร์ฟอาหาร', label: 'ส่งโต๊ะไหน เสิร์ฟอะไรแล้ว', icon: 'serve', roles: ['owner', 'staff'] },
  { path: '/counter', group: 'front', title: 'รับชำระเงิน', label: 'รวมบิลตามโต๊ะ รับชำระ', icon: 'counter', roles: ['owner', 'staff'] },
  { path: '/accounting', group: 'finance', title: 'บัญชี', label: 'กำไร รายจ่าย ปิดวัน งบการเงิน', icon: 'accounting', roles: ['owner', 'accountant', 'manager'] },
  // สต็อกวัตถุดิบ (0027-0030): จัดการได้ owner / manager / stock · บัญชีอ่านอย่างเดียว
  { path: '/stock', group: 'stock', title: 'ภาพรวมสต็อก', label: 'ใกล้หมด หมด ใกล้หมดอายุ แนะนำสั่งวันนี้', icon: 'stock', roles: ['owner', 'manager', 'stock', 'accountant'] },
  { path: '/stock-receive', group: 'stock', title: 'รับเข้า', label: 'เลือกผู้ขาย จำนวน ราคา วันหมดอายุ', icon: 'import', roles: ['owner', 'manager', 'stock', 'accountant'] },
  { path: '/stock-count', group: 'stock', title: 'นับสต็อก', label: 'นับแบบ blind เรียงตามชั้นวาง', icon: 'check', roles: ['owner', 'manager', 'stock'] },
  { path: '/stock-variance', group: 'stock', title: 'รายงานส่วนต่าง', label: 'นับจริง vs ควรเหลือ (หน่วย / บาท / %)', icon: 'analytics', roles: ['owner', 'manager', 'stock', 'accountant'] },
  { path: '/stock-yield', group: 'stock', title: 'Yield test', label: 'ชั่งก่อน-หลังตัดแต่ง 3 ครั้ง', icon: 'sparkle', roles: ['owner', 'manager', 'stock', 'accountant'] },
  { path: '/stock-history', group: 'stock', title: 'ประวัติสต็อก', label: 'ทุกรายการเข้า-ออก กรองวัตถุดิบ วันที่ ผู้ทำ', icon: 'clock', roles: ['owner', 'manager', 'stock', 'accountant'] },
  { path: '/stock-setup', group: 'stock', title: 'ตั้งค่าสต็อก', label: 'วัตถุดิบ ผู้ขาย สูตร หน่วย', icon: 'settings', roles: ['owner', 'manager', 'stock'] },
  { path: '/menu', group: 'admin', title: 'จัดการเมนู', label: 'เมนู ราคา หมวด โต๊ะ', icon: 'menu', roles: ['owner', 'manager'] },
  { path: '/promotions', group: 'admin', title: 'โปรโมชัน', label: 'ส่วนลดตามเงื่อนไขและช่วงเวลา', icon: 'promotions', roles: ['owner', 'manager'] },
  { path: '/import', group: 'finance', title: 'นำเข้ายอดขาย', label: 'นำเข้ายอดขายเดิมจากไฟล์ CSV', icon: 'import', roles: ['owner', 'manager'] },
  { path: '/report', group: 'finance', title: 'รายงานรายวัน', label: 'สรุปยอดวันนี้ ส่งเข้า LINE', icon: 'report', roles: ['owner', 'manager', 'accountant'] },
  { path: '/members', group: 'admin', title: 'สมาชิก', label: 'สะสมแต้ม ค้นหา ปรับแต้ม', icon: 'members', roles: ['owner', 'manager'] },
  { path: '/settings', group: 'admin', title: 'ตั้งค่าร้าน', label: 'พร้อมเพย์ ใบเสร็จ แต้ม LINE', icon: 'settings', roles: ['owner'] },
  { path: '/staff', group: 'admin', title: 'จัดการพนักงาน', label: 'เพิ่ม เชิญ เปลี่ยนบทบาท', icon: 'staff', roles: ['owner', 'manager'] },
]

// เข้าถึงได้ถ้ามีบทบาทใดบทบาทหนึ่งที่อนุญาต (พนักงาน 1 คนมีได้หลายบทบาท)
export const canAccess = (mine: Role[], allowed: Role[]) => mine.some((r) => allowed.includes(r))
export const pagesFor = (mine: Role[]) => STAFF_PAGES.filter((p) => canAccess(mine, p.roles))
// จัดหน้าเป็นหัวข้อตาม PAGE_GROUPS (ข้ามหัวข้อที่ไม่มีหน้าที่เข้าได้)
export const groupPages = (pages: StaffPage[]) =>
  PAGE_GROUPS.map((g) => ({ ...g, pages: pages.filter((p) => p.group === g.id) })).filter((g) => g.pages.length > 0)
export const roleLabels = (mine: Role[]) => mine.map((r) => ROLE_LABEL[r] ?? r).join(' · ')

export function rolesFor(path: string): Role[] {
  return STAFF_PAGES.find((p) => p.path === path)?.roles ?? []
}

// ผู้จัดการแต่งตั้ง/แก้ได้เฉพาะบทบาทเหล่านี้ (ฐานข้อมูลบังคับซ้ำ)
export const MANAGER_ASSIGNABLE: Role[] = ['staff', 'kitchen', 'accountant', 'stock']
