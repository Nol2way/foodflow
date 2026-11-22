import { useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'
import { api } from './api'
import { getSession, onSessionChange, setSession, type Session } from './session'
import type { Role } from './roles'
import { fetchCached, peek } from './cache'

// เซสชันจากตาราง app_users ของระบบเอง (อ่านจาก localStorage ทันที ไม่ต้องรอโหลด)
export function useSession() {
  const [session, set] = useState<Session | null>(getSession)
  useEffect(() => onSessionChange(set), [])
  return { session, loading: false }
}

export async function signIn(email: string, password: string): Promise<Session> {
  const s = await api<Session>('/auth/login', { auth: false, body: { email, password } })
  setSession(s)
  return s
}

export function signOut() {
  void api('/auth/logout', { body: {} }).catch(() => undefined)
  setSession(null)
}

interface StaffState {
  loading: boolean
  roles: Role[] // ว่าง = ยังไม่ได้ผูกกับร้าน
  restaurantId: string | null
  error: string | null
}

type StaffRow = { restaurant_id: string; role: string }

const STAFF_KEY = 'plato.staff'
const STAFF_MAX_AGE = 5 * 60_000 // บทบาทเปลี่ยนไม่บ่อย: ภายใน 5 นาทีใช้ค่าที่จำไว้ ไม่ต้องถามฐานข้อมูลทุกหน้า

function toState(rows: StaffRow[] | null): StaffState {
  if (!rows || rows.length === 0) {
    return { loading: false, roles: [], restaurantId: null, error: 'บัญชีนี้ยังไม่ได้ผูกกับร้านใด ให้เจ้าของร้านเพิ่มสิทธิ์ก่อน' }
  }
  const restaurantId = rows[0].restaurant_id
  const roles = rows.filter((r) => r.restaurant_id === restaurantId).map((r) => r.role as Role)
  return { loading: false, roles, restaurantId, error: null }
}

// บทบาทที่จำไว้ (หน่วยความจำ > localStorage) / รีเฟรชหน้าแล้วก็ไม่ต้องรอ
function rememberedStaff(userId: string): StaffState | null {
  const mem = peek<StaffRow[]>(`staff:${userId}`)
  if (mem) return toState(mem)
  try {
    const raw = localStorage.getItem(STAFF_KEY)
    if (!raw) return null
    const saved = JSON.parse(raw) as { userId: string; rows: StaffRow[] }
    return saved.userId === userId && saved.rows.length > 0 ? toState(saved.rows) : null
  } catch {
    return null
  }
}

function loadStaff(userId: string): Promise<StaffRow[]> {
  const token = getSession()?.access_token
  return fetchCached(
    `staff:${userId}`,
    async () => {
      const { data, error } = await supabase.from('staff_members').select('restaurant_id,role').eq('user_id', userId)
      if (error) throw error
      const rows = (data ?? []) as StaffRow[]
      try {
        if (getSession()?.access_token === token) localStorage.setItem(STAFF_KEY, JSON.stringify({ userId, rows }))
      } catch {
        // storage ใช้ไม่ได้: จำไว้แค่ในหน่วยความจำ
      }
      return rows
    },
    STAFF_MAX_AGE,
  )
}

// อ่านบทบาทและร้านของผู้ใช้ที่ล็อกอิน: 1 แถวต่อ 1 บทบาท (0020) / ตอนนี้รองรับ 1 ผู้ใช้ต่อ 1 ร้าน
// เปลี่ยนหน้า: ใช้ค่าที่จำไว้ทันที (ไม่ขึ้น "กำลังโหลด...") แล้วตรวจกับฐานข้อมูลเบื้องหลังเมื่อเกิน 5 นาที
export function useStaff(userId: string | undefined): StaffState {
  const identity = getSession()?.access_token
  const owner = useRef(identity)
  const [state, setState] = useState<StaffState>(() =>
    userId ? (rememberedStaff(userId) ?? { loading: true, roles: [], restaurantId: null, error: null }) : { loading: false, roles: [], restaurantId: null, error: null },
  )

  useEffect(() => {
    if (!userId) {
      setState({ loading: false, roles: [], restaurantId: null, error: null })
      return
    }
    owner.current = identity
    let cancelled = false
    const remembered = rememberedStaff(userId)
    setState(remembered ?? { loading: true, roles: [], restaurantId: null, error: null })
    const refresh = () => loadStaff(userId).then(
      (rows) => {
        if (!cancelled) setState(toState(rows))
      },
      () => {
        // เน็ตหลุด: ถ้ามีค่าที่จำไว้ใช้ต่อไป ไม่เตะออก
        if (!cancelled && !remembered) setState(toState(null))
      },
    )
    refresh()
    const tick = setInterval(refresh, STAFF_MAX_AGE)
    return () => {
      clearInterval(tick)
      cancelled = true
    }
  }, [userId, identity])

  return owner.current === identity ? state : { loading: true, roles: [], restaurantId: null, error: null }
}
