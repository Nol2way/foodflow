import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { api, ApiError } from '../lib/api'
import { baht } from '../lib/format'
import { ruleSuggestions, type Insights, type Suggestion } from '../lib/promoSuggest'
import Icon from './Icon'

// แนะนำโปรจากยอดขาย (0018): กติกาในระบบ + ให้ AI ช่วยคิด (ถ้า backend ตั้ง GEMINI_API_KEY)
// กดเลือกแล้วสร้างเป็นโปรที่ "ปิดไว้ก่อน" ให้ตรวจ/แก้แล้วค่อยเปิดใช้เอง

export default function PromoSuggestions({
  restaurantId,
  menuName,
  onCreated,
}: {
  restaurantId: string
  menuName: (id: string) => string
  onCreated: (text: string) => void
}) {
  const [list, setList] = useState<Suggestion[] | null>(null)
  const [aiEnabled, setAiEnabled] = useState(false)
  const [busy, setBusy] = useState<'rules' | 'ai' | string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [created, setCreated] = useState<Set<string>>(new Set())

  async function analyze(ai: boolean) {
    setBusy(ai ? 'ai' : 'rules')
    setNote(null)
    try {
      const r = await api<{ rules: Suggestion[]; ai: Suggestion[]; ai_enabled: boolean; ai_error?: string }>('/ai/promo-suggestions', {
        body: { restaurant_id: restaurantId, days: 28, ai },
      })
      setList([...r.ai, ...r.rules])
      setAiEnabled(r.ai_enabled)
      if (r.ai_error) setNote(r.ai_error)
    } catch (e) {
      // backend ไม่ทำงาน: คิดจากกติกาในเครื่องแทน (ไม่มี AI)
      if (e instanceof ApiError && e.status !== 0 && e.status !== 404) {
        setNote(e.message)
      } else {
        const { data, error } = await supabase.rpc('promo_insights', { p_restaurant_id: restaurantId, p_days: 28 })
        if (error) setNote('วิเคราะห์ไม่ได้ (ต้องรัน migration 0018 ก่อน)')
        else {
          setList(ruleSuggestions(data as Insights))
          setNote('ติดต่อ backend ไม่ได้ แสดงเฉพาะคำแนะนำจากกติกา')
        }
      }
    }
    setBusy(null)
  }

  async function create(s: Suggestion) {
    setBusy(s.key)
    const p = s.promo
    const { data, error } = await supabase
      .from('promotions')
      .insert({
        restaurant_id: restaurantId,
        name: p.name,
        discount_type: p.discount_type,
        value: p.value,
        min_subtotal: p.min_subtotal,
        start_time: p.start_time,
        end_time: p.end_time,
        is_active: false,
      })
      .select('id')
      .single()
    if (!error && p.item_ids.length) {
      await supabase.from('promotion_items').insert(p.item_ids.map((m) => ({ promotion_id: data.id, menu_item_id: m })))
    }
    setBusy(null)
    if (error) return setNote(error.message)
    setCreated((c) => new Set(c).add(s.key))
    onCreated(`สร้างโปร "${p.name}" แล้ว (ปิดไว้ก่อน) ตรวจแล้วกดเปิดใช้ในรายการด้านล่าง`)
  }

  const detail = (s: Suggestion) => {
    const p = s.promo
    const parts = [p.discount_type === 'percent' ? `ลด ${p.value}%` : `ลด ${baht(p.value)}`]
    if (p.min_subtotal > 0) parts.push(`ซื้อครบ ${baht(p.min_subtotal)}`)
    if (p.start_time) parts.push(`${p.start_time}–${p.end_time}`)
    parts.push(p.item_ids.length ? p.item_ids.map(menuName).join(', ') : 'ทั้งบิล')
    return parts.join(' · ')
  }

  return (
    <section className="card mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="section-title mb-1 flex items-center gap-2">
            <Icon name="sparkle" className="h-5 w-5 text-brand-500" />
            แนะนำโปรจากยอดขาย
          </h2>
          <p className="text-sm text-gray-500">ดูยอด 28 วันล่าสุด หาช่วงเวลาเงียบ เมนูขายช้าที่ยังลดได้ไม่ขาดทุน และเป้ายอดต่อบิล</p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => void analyze(false)}>
            {busy === 'rules' ? 'กำลังวิเคราะห์...' : 'วิเคราะห์'}
          </button>
          <button className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void analyze(true)} title="ต้องตั้ง GEMINI_API_KEY ที่ backend">
            <Icon name="sparkle" className="h-4 w-4" />
            {busy === 'ai' ? 'AI กำลังคิด...' : 'ให้ AI ช่วยคิด'}
          </button>
        </div>
      </div>
      {note && <p className="note mt-3">{note}</p>}
      {list && list.length === 0 && <p className="empty mt-3">ข้อมูลขายยังน้อยเกินไป (ต้องมีอย่างน้อย ~20 ออเดอร์) ลองใหม่เมื่อขายไปสักพัก</p>}
      {list && list.length > 0 && (
        <ul className="mt-4 grid gap-3 md:grid-cols-2">
          {list.map((s) => (
            <li key={s.key} className="flex flex-col rounded-xl border p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold text-gray-900">{s.title}</span>
                <span className={`badge shrink-0 ${s.source === 'ai' ? 'badge-brand' : 'badge-gray'}`}>{s.source === 'ai' ? 'AI' : 'กติกา'}</span>
              </div>
              <p className="mt-1 text-xs text-gray-500">{detail(s)}</p>
              {s.reason && <p className="mt-2 flex-1 text-sm text-gray-700">{s.reason}</p>}
              <button
                className="btn btn-secondary btn-sm mt-3 self-start"
                disabled={busy !== null || created.has(s.key)}
                onClick={() => void create(s)}
              >
                {created.has(s.key) ? 'สร้างแล้ว ✓' : busy === s.key ? 'กำลังสร้าง...' : 'สร้างเป็นโปร (ปิดไว้ก่อน)'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {list && !aiEnabled && list.length > 0 && <p className="mt-3 text-xs text-gray-400">ตั้ง GEMINI_API_KEY ที่ backend เพื่อให้ AI ช่วยเสนอเพิ่ม</p>}
    </section>
  )
}
