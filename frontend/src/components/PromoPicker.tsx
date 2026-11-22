import { translateUi } from "../lib/uiText"
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { baht } from '../lib/format'
import { describePromotion } from '../lib/promotions'
import { bestSelection, computeDiscounts, promoConflict, promoReason, type PromoLine, type PromoRule } from '../lib/discount'
import type { Promotion } from '../lib/types'
import Icon from './Icon'

// โปรโมชันของร้าน: ทั้งหมด + ชุดที่ใช้ได้ตอนนี้ + เมนูที่ร่วมโปร
// ถ้ายังไม่ได้รัน migration โปร ก็ได้รายการว่าง (รับออเดอร์/รับชำระต่อได้)
export function usePromotions(restaurantId: string) {
  const sequence = useRef(0)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [all, setAll] = useState<Promotion[]>([])
  const [liveIds, setLiveIds] = useState<Set<string>>(new Set())
  const [itemsOf, setItemsOf] = useState<Record<string, string[]>>({})

  const reload = useCallback(async () => {
    const seq = ++sequence.current
    const [p, a, pi] = await Promise.all([
      supabase.from('promotions').select('*').eq('restaurant_id', restaurantId).order('name'),
      supabase.rpc('promotions_available', { p_restaurant_id: restaurantId }),
      supabase.from('promotion_items').select('promotion_id,menu_item_id'),
    ])
    if (seq !== sequence.current) return
    if (p.error || a.error || pi.error) { setReady(false); setError('โหลดโปรโมชันไม่ครบ กรุณาลองใหม่'); return }
    setReady(true)
    setError(null)
    setAll(p.data as Promotion[])
    setLiveIds(new Set(a.error ? [] : (a.data as Promotion[]).map((x) => x.id)))
    const map: Record<string, string[]> = {}
    for (const x of pi.data ?? []) (map[x.promotion_id] ??= []).push(x.menu_item_id)
    setItemsOf(map)
  }, [restaurantId])

  useEffect(() => {
    void reload()
    const tick = setInterval(() => void reload(), 60000) // โปรตามช่วงเวลาเปิด/ปิดเองระหว่างวัน
    return () => { sequence.current++; clearInterval(tick) }
  }, [reload])

  return { all, liveIds, itemsOf, reload, ready, error }
}

export function toRule(p: Promotion, itemsOf: Record<string, string[]>): PromoRule {
  return { id: p.id, stackable: p.stackable, discount_type: p.discount_type, value: Number(p.value), min_subtotal: Number(p.min_subtotal), itemIds: itemsOf[p.id] ?? [] }
}

// ชุดโปรที่ใช้กับบิล: เลือกอัตโนมัติ (ลดได้มากที่สุด ไม่ชนกัน) จนกว่าพนักงานจะติ๊กเอง
export function usePromoSelection(promos: Promotion[], itemsOf: Record<string, string[]>, lines: PromoLine[]) {
  const [manual, setManual] = useState<string[] | null>(null)
  const [coupons, setCoupons] = useState<string[]>([])
  const rules = useMemo(() => promos.filter(p => !p.coupon_code || coupons.includes(p.id)).map((p) => toRule(p, itemsOf)), [promos, itemsOf, coupons])
  const linesKey = JSON.stringify(lines)

  const auto = useMemo(() => bestSelection(rules, JSON.parse(linesKey) as PromoLine[]), [rules, linesKey])
  const selectedIds = (manual ?? auto).filter((id) => rules.some((r) => r.id === id))
  const selected: PromoRule[] = []
  for (const r of rules.filter((r) => selectedIds.includes(r.id))) {
    if (selected.length < 10 && promoReason(r, lines) === null && promoConflict(r, selected, lines) === null) selected.push(r)
  }
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
    enableCoupon: (id: string) => {
      const promotion = promos.find((p) => p.id === id)
      if (!promotion) return
      const coupon = toRule(promotion, itemsOf)
      setCoupons(previous => [...new Set([...previous, id])])
      setManual(previous => [id, ...(previous ?? auto).filter((otherId) => {
        const other = rules.find((rule) => rule.id === otherId)
        return other && other.id !== id && promoConflict(other, [coupon], lines) === null
      })])
    },
    resetAuto: () => { setManual(null); setCoupons([]) },
  }
}

export default function PromoPicker({
  restaurantId,
  promos,
  lines,
  selection,
}: {
  restaurantId: string
  promos: Promotion[]
  lines: PromoLine[]
  selection: ReturnType<typeof usePromoSelection>
}) {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const lookupVersion = useRef(0)
  const lookupLock = useRef(false)
  useEffect(() => () => { lookupVersion.current++ }, [restaurantId])
  async function lookup() {
    if (lookupLock.current || !code.trim()) return
    lookupLock.current = true
    const version = lookupVersion.current
    setBusy(true); setError('')
    try {
      const result = await supabase.rpc('coupon_lookup', { p_restaurant_id: restaurantId, p_code: code.trim().toUpperCase() })
      if (version !== lookupVersion.current) return
      const found = result.data as Promotion | null
      if (result.error || !found || !promos.some(p => p.id === found.id)) { setError('ไม่พบคูปองที่ใช้ได้ในขณะนี้'); return }
      selection.enableCoupon(found.id); setCode('')
    } finally { lookupLock.current = false; setBusy(false) }
  }
  if (promos.length === 0) return null
  const { rules, selectedIds, discounts, isAuto, toggle, resetAuto } = selection
  const selectedRules = rules.filter((r) => selectedIds.includes(r.id))

  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50/60 p-3">
      <div className="mb-3 flex gap-2"><input className="input min-w-0 flex-1" aria-label={translateUi("รหัสคูปอง")} placeholder={translateUi("รหัสคูปอง")} maxLength={40} value={code} onChange={event => { lookupVersion.current++; setCode(event.target.value); setError('') }} /><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void lookup()}>{translateUi("ใช้คูปอง")}</button></div>
      {error && <p role="alert" className="field-error">{translateUi(error)}</p>}
      <div className="mb-2 row-between">
        <span className="text-sm strong-text">{translateUi("โปรโมชัน")}</span>
        {isAuto ? (
          <span className="badge badge-green">{translateUi("เลือกให้อัตโนมัติ")}</span>
        ) : (
          <button type="button" className="link text-xs" onClick={resetAuto}>{"" + translateUi("เลือกอัตโนมัติอีกครั้ง") + " "}</button>
        )}
      </div>
      <ul className="space-y-1">
        {promos.filter(p => rules.some(r => r.id === p.id)).map((p) => {
          const rule = rules.find((r) => r.id === p.id)!
          const on = selectedIds.includes(p.id)
          const why = promoReason(rule, lines) ?? (on ? null : promoConflict(rule, selectedRules, lines))
          return (
            <li key={p.id}>
              <button
                type="button"
                aria-pressed={on}
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
                  <span className="block hint">{why ?? describePromotion(p)}</span>
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
