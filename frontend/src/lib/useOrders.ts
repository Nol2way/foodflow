import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import { peek, put } from './cache'
import type { KitchenOrder, OrderStatus } from './types'

// ดึงออเดอร์ของร้านตามสถานะ และรีเฟรชอัตโนมัติเมื่อมีการเปลี่ยนแปลง (Supabase Realtime)
export function useOrders(restaurantId: string, statuses: OrderStatus[]) {
  const statusKey = statuses.join(',')
  const cacheKey = `orders:${restaurantId}:${statusKey}`
  // เปิดหน้าครัว/เสิร์ฟ/รับชำระซ้ำ: แสดงออเดอร์ชุดล่าสุดทันที แล้ว Realtime/โหลดใหม่จะอัปเดตตาม
  const [orders, setOrders] = useState<KitchenOrder[]>(() => peek<KitchenOrder[]>(cacheKey) ?? [])
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('orders')
      .select(
        'id,status,total,subtotal,discount_total,created_at,started_at,ready_at,table_id,order_type,customer_label,note,promotion_id,order_promotions(promotion_id,discount,promotions(name)),dining_tables(label),order_items(id,menu_item_id,unit_price,quantity,weight_g,note,done_at,served_at,menu_items(name))',
      )
      .eq('restaurant_id', restaurantId)
      .in('status', statusKey.split(','))
      .order('created_at')
    if (err) return setError(err.message)
    const next = data as unknown as KitchenOrder[]
    put(cacheKey, next)
    setOrders(next)
  }, [restaurantId, statusKey, cacheKey])

  useEffect(() => {
    void reload()
    const channel = supabase
      .channel(`orders-${restaurantId}-${statusKey}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'orders', filter: `restaurant_id=eq.${restaurantId}` },
        () => void reload(),
      )
      // ติ๊กเสร็จ/เสิร์ฟรายเมนู (RLS กรองให้เห็นเฉพาะของร้านตัวเอง)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'order_items' }, () => void reload())
      .subscribe()
    const fallback = setInterval(() => void reload(), 15000) // กันกรณี Realtime หลุด
    return () => {
      void supabase.removeChannel(channel)
      clearInterval(fallback)
    }
  }, [restaurantId, statusKey, reload])

  return { orders, error, setError, reload }
}
