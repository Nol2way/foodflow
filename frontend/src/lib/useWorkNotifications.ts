import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'
import { getToken } from './session'
import { pagesFor, type Role } from './roles'
import { workCounts } from './workCounts'

export type WorkItem = { path: string; title: string; count: number }

export function useWorkNotifications(restaurantId: string | null, roles: Role[]) {
  const token = getToken()
  const permitted = pagesFor(roles).filter(page => ['/kitchen', '/serve', '/counter'].includes(page.path))
  const paths = permitted.map(page => page.path).join(',')
  const scope = `${restaurantId}:${token}:${paths}`
  const owner = useRef(scope)
  owner.current = scope
  const [state, setState] = useState<{ scope: string; counts: Record<string, number>; loaded: boolean; error: boolean }>({ scope, counts: {}, loaded: false, error: false })
  const request = useRef(0)
  const reload = useCallback(async () => {
    if (!restaurantId || !paths || !token) return
    const sequence = ++request.current
    try {
      const { data, error, count } = await supabase.from('orders').select('id,status,order_type,table_id,bill_requested_at', { count: 'exact' }).eq('restaurant_id', restaurantId).in('status', ['received', 'preparing', 'ready', 'served']).abortSignal(AbortSignal.timeout(10000))
      if (owner.current !== scope || sequence !== request.current) return
      if (error) throw error
      // Never display a partial count if the server caps the result set.
      if (count !== null && count > (data?.length ?? 0)) throw new Error('Incomplete task list')
      setState({ scope, counts: workCounts(data ?? []), loaded: true, error: false })
    } catch {
      if (owner.current === scope && sequence === request.current) setState({ scope, counts: {}, loaded: true, error: true })
    }
  }, [restaurantId, paths, token, scope])
  useEffect(() => {
    if (!restaurantId || !paths || !token) return
    void reload()
    const channel = supabase.channel(`work-notifications:${restaurantId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `restaurant_id=eq.${restaurantId}` }, () => void reload()).subscribe()
    const refresh = () => { if (document.visibilityState === 'visible') void reload() }
    const tick = setInterval(refresh, 15000)
    window.addEventListener('focus', refresh)
    return () => { request.current++; clearInterval(tick); window.removeEventListener('focus', refresh); void supabase.removeChannel(channel) }
  }, [restaurantId, paths, token, reload])
  const current: Pick<typeof state, 'counts' | 'loaded' | 'error'> = state.scope === scope ? state : { counts: {}, loaded: false, error: false }
  const items: WorkItem[] = permitted.map(page => ({ path: page.path, title: page.title, count: current.counts[page.path] ?? 0 }))
  return { items, loaded: current.loaded, error: current.error, reload, total: items.reduce((total, item) => total + item.count, 0) }
}
