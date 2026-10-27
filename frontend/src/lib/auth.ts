import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { api } from './api'
import { getSession, onSessionChange, setSession, type Session } from './session'
import type { Role } from './roles'

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
  setSession(null)
}

interface StaffState {
  loading: boolean
  roles: Role[] // ว่าง = ยังไม่ได้ผูกกับร้าน
  restaurantId: string | null
  error: string | null
}

// อ่านบทบาทและร้านของผู้ใช้ที่ล็อกอิน: 1 แถวต่อ 1 บทบาท (0020) · ตอนนี้รองรับ 1 ผู้ใช้ต่อ 1 ร้าน
export function useStaff(userId: string | undefined): StaffState {
  const [state, setState] = useState<StaffState>({ loading: true, roles: [], restaurantId: null, error: null })

  useEffect(() => {
    if (!userId) {
      setState({ loading: false, roles: [], restaurantId: null, error: null })
      return
    }
    let cancelled = false
    setState((s) => ({ ...s, loading: true }))
    supabase
      .from('staff_members')
      .select('restaurant_id,role')
      .eq('user_id', userId)
      .then(({ data, error }) => {
        if (cancelled) return
        if (error || !data || data.length === 0) {
          setState({
            loading: false,
            roles: [],
            restaurantId: null,
            error: 'บัญชีนี้ยังไม่ได้ผูกกับร้านใด ให้เจ้าของร้านเพิ่มสิทธิ์ก่อน',
          })
        } else {
          const restaurantId = data[0].restaurant_id as string
          const roles = data.filter((r) => r.restaurant_id === restaurantId).map((r) => r.role as Role)
          setState({ loading: false, roles, restaurantId, error: null })
        }
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  return state
}
