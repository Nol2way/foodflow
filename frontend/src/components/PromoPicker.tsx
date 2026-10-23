import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { baht } from '../lib/format'
import { describePromotion } from '../lib/promotions'
import { bestSelection, computeDiscounts, promoConflict, promoReason, type PromoLine, type PromoRule } from '../lib/discount'
import type { Promotion } from '../lib/types'
import Icon from './Icon'

// โปรโมชันของร้าน: ทั้งหมด + ชุดที่ใช้ได้ตอนนี้ + เมนูที่ร่วมโปร
// ถ้ายังไม่ได้รัน migration โปร ก็ได้รายการว่าง (รับออเดอร์/รับชำระต่อได้)
export function usePromotions(restaurantId: string) {
  const [all, setAll] = useState<Promotion[]>([])
  const [liveIds, setLiveIds] = useState<Set<string>>(new Set())
  const [itemsOf, setItemsOf] = useState<Record<string, string[]>>({})

  const reload = useCallback(async () => {
    const [p, a, pi] = await Promise.all([
      supabase.from('promotions').select('*').eq('restaurant_id', restaurantId).order('name'),
      supabase.rpc('promotions_available', { p_restaurant_id: restaurantId }),
      supabase.from('promotion_items').select('promotion_id,menu_item_id'),
    ])
    setAll(p.error ? [] : (p.data as Promotion[]))
    setLiveIds(new Set(a.error ? [] : (a.data as Promotion[]).map((x) => x.id)))
    const map: Record<string, string[]> = {}
    for (const x of pi.data ?? []) (map[x.promotion_id] ??= []).push(x.menu_item_id)
    setItemsOf(map)
  }, [restaurantId])

  useEffect(() => {
    void reload()
    const tick = setInterval(() => void reload(), 60000) // โปรตามช่วงเวลาเปิด/ปิดเองระหว่างวัน
    return () => clearInterval(tick)
  }, [reload])

  return { all, liveIds, itemsOf, reload }
}

export function toRule(p: Promotion, itemsOf: Record<string, string[]>): PromoRule {
  return { id: p.id, discount_type: p.discount_type, value: Number(p.value), min_subtotal: Number(p.min_subtotal), itemIds: itemsOf[p.id] ?? [] }
}

// ชุดโปรที่ใช้กับบิล: เลือกอัตโนมัติ (ลดได้มากที่สุด ไม่ชนกัน) จนกว่าพนักงานจะติ๊กเอง
export function usePromoSelection(promos: Promotion[], itemsOf: Record<string, string[]>, lines: PromoLine[]) {
  const [manual, setManual] = useState<string[] | null>(null)
  const rules = useMemo(() => promos.map((p) => toRule(p, itemsOf)), [promos, itemsOf])
  const linesKey = JSON.stringify(lines)

  const auto = useMemo(() => bestSelection(rules, JSON.parse(linesKey) as PromoLine[]), [rules, linesKey])
  const selectedIds = (manual ?? auto).filter((id) => rules.some((r) => r.id === id))
  const selected = rules.filter((r) => selectedIds.includes(r.id))
  const discounts = computeDiscounts(selected, lines)

  function toggle(id: string) {
    setManual(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id])
  }

  return {
    rules,
    selectedIds: selected.filter((r) => promoReason(r, lines) === null).map((r) => r.id),
    discounts,
    isAuto: manual === null,
    toggle,
    resetAuto: () => setManual(null),
  }
}

export default function PromoPicker({
  promos,
  lines,
  selection,
}: {
  promos: Promotion[]
  lines: PromoLine[]
  selection: ReturnType<typeof usePromoSelection>
}) {
  if (promos.length === 0) return null
  const { rules, selectedIds, discounts, isAuto, toggle, resetAuto } = selection
  const selectedRules = rules.filter((r) => selectedIds.includes(r.id))

  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50/60 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-gray-900">โปรโมชัน</span>
        {isAuto ? (
          <span className="badge badge-green">เลือกให้อัตโนมัติ</span>
        ) : (
          <button type="button" className="link text-xs" onClick={resetAuto}>
            เลือกอัตโนมัติอีกครั้ง
          </button>
        )}
      </div>
      <ul className="space-y-1">
        {promos.map((p) => {
          const rule = rules.find((r) => r.id === p.id)!
          const on = selectedIds.includes(p.id)
          const why = promoReason(rule, lines) ?? (on ? null : promoConflict(rule, selectedRules, lines))
          return (
            <li key={p.id}>
              <button
                type="button"
                disabled={!on && why !== null}
                onClick={() => toggle(p.id)}
                className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition ${
                  on ? 'bg-emerald-50' : why ? 'cursor-not-allowed opacity-60' : 'hover:bg-white'
                }`}
              >
                <span
                  className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border-2 ${
                    on ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-gray-300 bg-white'
                  }`}
                >
                  {on && <Icon name="check" className="h-3.5 w-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-gray-900">{p.name}</span>
                  <span className="block text-xs text-gray-500">{why ?? describePromotion(p)}</span>
                </span>
                {on && <span className="font-semibold tabular-nums text-emerald-700">−{baht(discounts.byPromo[p.id] ?? 0)}</span>}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
