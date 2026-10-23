import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
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
export function useShopSettings(restaurantId: string) {
  const [settings, setSettings] = useState<ShopSettings | null>(null)
  const [loaded, setLoaded] = useState(false)
  const reload = useCallback(async () => {
    const { data, error } = await supabase.from('shop_settings').select('*').eq('restaurant_id', restaurantId).maybeSingle()
    setSettings(error ? null : data ? { ...(data as ShopSettings), loyalty_point_value: Number(data.loyalty_point_value) } : DEFAULT_SHOP(restaurantId))
    setLoaded(true)
  }, [restaurantId])
  useEffect(() => {
    void reload()
  }, [reload])
  return { settings, loaded, reload }
}
