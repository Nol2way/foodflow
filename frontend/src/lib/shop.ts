import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import { has, peek, put } from './cache'
import type { ShopSettings } from './types'

// ค่าเริ่มต้นเมื่อร้านยังไม่เคยบันทึกตั้งค่า (ตรงกับ default ในตาราง)
export const DEFAULT_SHOP = (restaurantId: string): ShopSettings => ({
  restaurant_id: restaurantId,
  promptpay_id: null,
  receipt_header: null,
  receipt_footer: null,
  loyalty_enabled: false,
  loyalty_baht_per_point: 10,
  loyalty_point_value: 1,
  loyalty_min_redeem: 10,
  line_to: null,
})

// ตั้งค่าร้าน (0017) · ยังไม่ได้รัน migration = null (หน้ารับชำระทำงานแบบเดิม)
// จำไว้ข้ามหน้า: หน้ารับชำระ/ตั้งค่า เปิดแล้วใช้ได้ทันที (โหลดใหม่เบื้องหลัง)
export function useShopSettings(restaurantId: string) {
  const key = `shop:${restaurantId}`
  const [settings, setSettings] = useState<ShopSettings | null>(() => peek<ShopSettings | null>(key) ?? null)
  const [loaded, setLoaded] = useState(() => has(key))
  const reload = useCallback(async () => {
    const { data, error } = await supabase.from('shop_settings').select('*').eq('restaurant_id', restaurantId).maybeSingle()
    const next = error ? null : data ? { ...(data as ShopSettings), loyalty_point_value: Number(data.loyalty_point_value) } : DEFAULT_SHOP(restaurantId)
    const hadPrev = has(key)
    const prev = peek<ShopSettings | null>(key)
    put(key, next)
    // ค่าเหมือนเดิม: ไม่ต้องเปลี่ยน state (กันฟอร์มตั้งค่าที่กำลังแก้ถูกรีเซ็ต)
    if (!hadPrev || JSON.stringify(prev) !== JSON.stringify(next)) setSettings(next)
    else setSettings((cur) => cur ?? next)
    setLoaded(true)
  }, [restaurantId, key])
  useEffect(() => {
    void reload()
  }, [reload])
  return { settings, loaded, reload }
}
