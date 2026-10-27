export type OrderStatus = 'received' | 'preparing' | 'ready' | 'served' | 'paid' | 'cancelled'

export interface MenuCategory {
  id: string
  name: string
  sort_order: number
}

export interface MenuItem {
  id: string
  category_id: string | null
  name: string
  price: number
  is_available: boolean
  // 0013: สำหรับจอแสดงผล iPad
  is_recommended?: boolean
  description?: string | null
  // 0023: ขายตามน้ำหนักจริง (price = ราคาต่อ 1 กก.)
  sold_by_weight?: boolean
  weight_ingredient_id?: string | null
}

// สื่อบนจอแสดงผล (ตาราง display_media ใน 0014) · menu_item_id ว่าง = สไลด์โฆษณาร้าน
export interface DisplayMediaRow {
  id: string
  restaurant_id: string
  menu_item_id: string | null
  kind: 'image' | 'video' | 'youtube'
  storage_path: string | null
  url: string | null
  title: string | null
  caption: string | null
  credit: string | null
  duration_sec: number | null
  sort_order: number
  is_active: boolean
  poster?: unknown // 0015: ค่าที่ใช้สร้างโปสเตอร์ (ว่าง = ไม่ใช่โปสเตอร์)
}

export interface CartLine {
  item: MenuItem
  quantity: number
  note: string
  weight_g?: number // ของชั่งขาย: น้ำหนักจริง (1 บรรทัด = 1 ครั้งที่ชั่ง)
}

export type OrderType = 'dine_in' | 'takeaway'

export interface KitchenOrder {
  id: string
  status: OrderStatus
  total: number
  created_at: string
  started_at: string | null
  ready_at: string | null
  table_id: string | null
  order_type: OrderType
  customer_label: string | null
  note: string | null
  subtotal: number | null
  discount_total: number
  promotion_id: string | null
  order_promotions: { promotion_id: string; discount: number; promotions: { name: string } | null }[]
  dining_tables: { label: string } | null
  order_items: {
    id: string
    menu_item_id: string
    unit_price: number
    quantity: number
    weight_g: number | null
    note: string | null
    done_at: string | null
    served_at: string | null
    menu_items: { name: string } | null
  }[]
}

export interface MenuCost {
  menu_item_id: string
  name: string
  price: number
  unit_cost: number
  ingredient_count: number
}

// ตั้งค่าร้าน (shop_settings ใน 0017)
export interface ShopSettings {
  restaurant_id: string
  promptpay_id: string | null
  receipt_header: string | null
  receipt_footer: string | null
  loyalty_enabled: boolean
  loyalty_baht_per_point: number
  loyalty_point_value: number
  loyalty_min_redeem: number
  line_to: string | null
}

export interface Member {
  id: string
  phone: string
  name: string | null
  points: number
  created_at: string
}

export type PaymentMethod = 'cash' | 'promptpay' | 'card' | 'other'

export interface Promotion {
  id: string
  restaurant_id: string
  name: string
  discount_type: 'percent' | 'amount'
  value: number
  min_subtotal: number
  starts_on: string | null
  ends_on: string | null
  days_of_week: number[] | null
  start_time: string | null
  end_time: string | null
  is_active: boolean
  max_uses: number | null
}
