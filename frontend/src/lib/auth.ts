import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { Role } from './roles'

export function useSession() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  return { session, loading }
}

interface StaffState {
  loading: boolean
  role: Role | null
  restaurantId: string | null
  error: string | null
}

// อ่านบทบาทและร้านของผู้ใช้ที่ล็อกอิน (ตอนนี้รองรับ 1 ผู้ใช้ต่อ 1 ร้าน)
export function useStaff(userId: string | undefined): StaffState {
  const [state, setState] = useState<StaffState>({ loading: true, role: null, restaurantId: null, error: null })

  useEffect(() => {
    if (!userId) {
      setState({ loading: false, role: null, restaurantId: null, error: null })
      return
    }
    let cancelled = false
    setState((s) => ({ ...s, loading: true }))
    supabase
      .from('staff_members')
      .select('restaurant_id,role')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error || !data) {
          setState({
            loading: false,
            role: null,
            restaurantId: null,
            error: 'บัญชีนี้ยังไม่ได้ผูกกับร้านใด ให้เจ้าของร้านเพิ่มสิทธิ์ก่อน',
          })
        } else {
          setState({ loading: false, role: data.role as Role, restaurantId: data.restaurant_id as string, error: null })
        }
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  return state
}
