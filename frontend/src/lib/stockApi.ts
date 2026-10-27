// เรียก API สต็อกวัตถุดิบ (backend/src/stock.ts) + ชนิดข้อมูลที่หน้าเว็บใช้
import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from './api'
import { stockError, type AbcClass, type CountType, type MovementType, type RecipeUnit, type VarianceColor } from './stockMath'

export interface StockIngredient {
  id: string
  name: string
  unit: string
  recipe_unit: RecipeUnit
  category: string | null
  quantity_on_hand: number
  cost_per_unit: number
  last_unit_cost: number | null
  purchase_unit: string
  conversion_factor: number
  display_unit: string | null
  display_factor: number
  trim_yield_pct: number
  cook_yield_pct: number
  abc_class: AbcClass
  storage_location: string | null
  shelf_order: number
  reorder_level: number
  par_level: number | null
  safety_stock: number
  variance_threshold_pct: number
  supplier_id: string | null
  count_weekly: boolean
  is_active: boolean
}

export interface Supplier {
  id: string
  name: string
  phone: string | null
  lead_time_days: number
  delivery_days: number[]
  note: string | null
  is_active: boolean
}

export interface RecipeLine {
  id?: string
  ingredient_id: string | null
  sub_recipe_id: string | null
  qty: number
}
export interface Recipe {
  id: string
  name: string
  menu_item_id: string | null
  output_qty: number
  output_unit: string
  cost_per_output: number
  note: string | null
  recipe_lines: RecipeLine[]
}
export interface StockMenu {
  id: string
  name: string
  is_available: boolean
  stock_disabled: boolean
  sold_by_weight: boolean
  recipe_id: string | null
}

export interface Reorder {
  ingredient_id: string
  name: string
  unit: string
  on_hand: number
  daily_usage: number
  lead_time_days: number
  cycle_days: number
  safety_stock: number
  par: number
  par_source: 'auto' | 'manual'
  suggested_qty: number
  purchase_unit: string
  conversion_factor: number
  suggested_purchase_qty: number
  supplier_id: string | null
  supplier_name: string | null
  order_today: boolean
  next_delivery: string | null
}

export interface Overview {
  today: string
  stock_value: number
  ingredient_count: number
  out: { id: string; name: string; unit: string }[]
  low: { id: string; name: string; unit: string; on_hand: number; threshold: number; display_unit: string | null; display_factor: number }[]
  expiring: { lot_id: string; ingredient_id: string; name: string; unit: string; qty: number; expiry_date: string; days_left: number; value: number }[]
  reorder_today: Reorder[]
  recipe_alerts: { ingredient_id: string; name: string; streak: number }[]
  stock_disabled_menus: { id: string; name: string }[]
  last_count: { id: string; created_at: string; count_type: CountType; counted_by_name: string | null; verified_at: string | null; diff_value: number } | null
}

export interface LastPurchase {
  ingredient_id: string
  unit_cost: number
  pack_size: number | null
  pack_price: number | null
  supplier: string | null
  received_on: string
}
export interface ReceiveWarning {
  ingredient_id: string
  ingredient_name: string
  price_change_pct: number | null
  prev_unit_cost: number | null
  unit_cost: number
  pack_changed: boolean
  prev_pack_size: number | null
  pack_size: number | null
}

export interface SheetItem {
  ingredient_id: string
  name: string
  recipe_unit: RecipeUnit
  unit: string
  display_unit: string | null
  display_factor: number
  purchase_unit: string
  conversion_factor: number
  abc_class: AbcClass
  storage_location: string | null
  shelf_order: number
}
export interface CountRow {
  id: string
  count_type: CountType
  note: string | null
  item_count: number
  diff_count: number
  diff_value: number
  counted_by: string | null
  counted_by_name: string | null
  verified_by_name: string | null
  verified_at: string | null
  created_at: string
}
export interface VarianceLine {
  ingredient_id: string
  ingredient_name: string
  unit: string
  display_unit: string | null
  display_factor: number
  abc_class: AbcClass | null
  opening_qty: number | null
  received_qty: number | null
  deducted_qty: number | null
  expected_qty: number
  counted_qty: number
  variance_qty: number
  variance_value: number
  variance_pct: number | null
  color: VarianceColor
  negative_streak: number
  recipe_alert: boolean
  note: string | null
  entered_text: string | null
}

export interface YieldTestRow {
  id: string
  ingredient_id: string
  kind: 'trim' | 'cook'
  trials: { before: number; after: number }[]
  avg_pct: number
  applied: boolean
  note: string | null
  tested_by_name: string | null
  created_at: string
  ingredients: { name: string; unit: string } | null
}

export interface Movement {
  id: string
  created_at: string
  ingredient_id: string
  ingredient_name: string
  unit: string
  type: MovementType
  change: number
  balance_after: number | null
  cost: number | null
  unit_cost: number | null
  note: string | null
  actor_id: string | null
  actor_name: string | null
  ref_id: string | null
  order_label: string | null
  reverses_id: string | null
  reversed_by: string | null
}

const qs = (o: Record<string, string | number | boolean | null | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&')

export const stockApi = {
  overview: (rid: string) => api<Overview>(`/stock/overview?${qs({ restaurant_id: rid })}`),
  reorder: (rid: string, days = 28) => api<{ suggestions: Reorder[] }>(`/stock/reorder?${qs({ restaurant_id: rid, days })}`),
  ingredients: (rid: string, inactive = false) =>
    api<{ ingredients: StockIngredient[] }>(`/stock/ingredients?${qs({ restaurant_id: rid, include_inactive: inactive || undefined })}`),
  createIngredient: (rid: string, b: Record<string, unknown>) =>
    api<{ ingredient: StockIngredient }>('/stock/ingredients', { body: { ...b, restaurant_id: rid } }),
  updateIngredient: (rid: string, id: string, b: Record<string, unknown>) =>
    api<{ ingredient: StockIngredient }>(`/stock/ingredients/${id}`, { method: 'PATCH', body: { ...b, restaurant_id: rid } }),
  suppliers: (rid: string) => api<{ suppliers: Supplier[] }>(`/stock/suppliers?${qs({ restaurant_id: rid })}`),
  saveSupplier: (rid: string, id: string | null, b: Record<string, unknown>) =>
    api<{ supplier: Supplier }>(id ? `/stock/suppliers/${id}` : '/stock/suppliers', { method: id ? 'PATCH' : 'POST', body: { ...b, restaurant_id: rid } }),
  recipes: (rid: string) => api<{ recipes: Recipe[]; menus: StockMenu[] }>(`/stock/recipes?${qs({ restaurant_id: rid })}`),
  saveRecipe: (rid: string, id: string | null, b: Record<string, unknown>) =>
    api<{ recipe: Recipe }>(id ? `/stock/recipes/${id}` : '/stock/recipes', { method: id ? 'PUT' : 'POST', body: { ...b, restaurant_id: rid } }),
  deleteRecipe: (rid: string, id: string) => api(`/stock/recipes/${id}?${qs({ restaurant_id: rid })}`, { method: 'DELETE' }),
  lastPurchases: (rid: string, supplierId: string | null) =>
    api<{ last: LastPurchase[] }>(`/stock/last-purchases?${qs({ restaurant_id: rid, supplier_id: supplierId })}`),
  receive: (rid: string, b: Record<string, unknown>) =>
    api<{ receipt_id: string; warnings: ReceiveWarning[]; recosted_recipes: number }>('/stock/receipts', { body: { ...b, restaurant_id: rid } }),
  countSheet: (rid: string, abc: string[]) => api<{ items: SheetItem[] }>(`/stock/count-sheet?${qs({ restaurant_id: rid, abc: abc.join(',') })}`),
  submitCount: (rid: string, b: Record<string, unknown>) => api<{ count_id: string }>('/stock/counts', { body: { ...b, restaurant_id: rid } }),
  counts: (rid: string) => api<{ counts: CountRow[] }>(`/stock/counts?${qs({ restaurant_id: rid })}`),
  verifyCount: (rid: string, id: string) => api(`/stock/counts/${id}/verify`, { body: { restaurant_id: rid } }),
  variance: (rid: string, id: string) => api<{ lines: VarianceLine[] }>(`/stock/counts/${id}/variance?${qs({ restaurant_id: rid })}`),
  yieldTests: (rid: string, ingredientId?: string) =>
    api<{ tests: YieldTestRow[] }>(`/stock/yield-tests?${qs({ restaurant_id: rid, ingredient_id: ingredientId })}`),
  recordYield: (rid: string, b: Record<string, unknown>) =>
    api<{ id: string; avg_pct: number; applied: boolean }>('/stock/yield-tests', { body: { ...b, restaurant_id: rid } }),
  history: (rid: string, f: { from: string; to: string; ingredient_id?: string; actor_id?: string; type?: string }) =>
    api<{ movements: Movement[] }>(`/stock/history?${qs({ restaurant_id: rid, ...f, limit: 500 })}`),
  reverse: (rid: string, id: string, reason: string) =>
    api<{ reversal_id: string }>(`/stock/movements/${id}/reverse`, { body: { restaurant_id: rid, reason } }),
}

// ข้อความไทยจาก ApiError (backend แปลรหัสสต็อกให้แล้ว) หรือจากรหัสที่หลุดมา
export const errorText = (e: unknown) =>
  e instanceof ApiError ? (e.data.message ? String(e.data.message) : stockError(e.code || e.message)) : String((e as Error)?.message ?? e)

// โหลดข้อมูลแบบมีสถานะ (ใช้ซ้ำทุกหน้า) · reload() หลังบันทึก
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps)
  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setData(await run())
      setError(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [run])
  useEffect(() => {
    void reload()
  }, [reload])
  return { data, error, loading, reload, setData }
}

export const todayIso = () => new Date().toLocaleDateString('sv-SE')
export const daysAgoIso = (n: number) => new Date(Date.now() - n * 86_400_000).toLocaleDateString('sv-SE')
export const shortDate = (iso: string) => new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })
export const dateTime = (iso: string) => new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
