import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { rolesFor } from '../lib/roles'
import { describePromotion, promotionError, todayISO } from '../lib/promotions'
import { DAY_SHORT } from '../lib/analytics'
import RequireRole from '../components/RequireRole'
import PromoSuggestions from '../components/PromoSuggestions'
import type { MenuItem, Promotion } from '../lib/types'

// จัดการโปรโมชัน (เจ้าของ, ผู้จัดการ) · พนักงานหน้าร้านเลือกใช้ตอนรับออเดอร์
// ฐานข้อมูลตรวจเงื่อนไขและคำนวณส่วนลดเอง (staff_place_order, counter_pay_bill)
// วันที่ย้อนหลังกว่าวันนี้ไม่ได้ · วันสิ้นสุดต้องไม่ก่อนวันเริ่ม · จำกัดจำนวนครั้งได้ (ฐานข้อมูลบังคับซ้ำใน 0012)

const EMPTY = {
  name: '',
  discount_type: 'percent' as Promotion['discount_type'],
  value: '',
  min_subtotal: '',
  starts_on: '',
  ends_on: '',
  days: [] as number[],
  start_time: '',
  end_time: '',
  max_uses: '',
  items: [] as string[],
}
type Form = typeof EMPTY

function Board({ restaurantId }: { restaurantId: string }) {
  const [promos, setPromos] = useState<Promotion[]>([])
  const [links, setLinks] = useState<{ promotion_id: string; menu_item_id: string }[]>([])
  const [menu, setMenu] = useState<MenuItem[]>([])
  const [live, setLive] = useState<Set<string>>(new Set())
  const [usage, setUsage] = useState<Record<string, number>>({})
  // วันที่เดิมของโปรที่กำลังแก้ (โปรที่เริ่มไปแล้ว แก้ส่วนอื่นได้โดยไม่ต้องเลื่อนวันเริ่ม)
  const [original, setOriginal] = useState<{ starts_on: string; ends_on: string }>({ starts_on: '', ends_on: '' })
  const [form, setForm] = useState<Form>(EMPTY)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    const [p, l, m, a, u] = await Promise.all([
      supabase.from('promotions').select('*').eq('restaurant_id', restaurantId).order('created_at', { ascending: false }),
      supabase.from('promotion_items').select('promotion_id,menu_item_id'),
      supabase.from('menu_items').select('id,category_id,name,price,is_available').eq('restaurant_id', restaurantId).order('name'),
      supabase.rpc('promotions_available', { p_restaurant_id: restaurantId }),
      supabase.rpc('promotion_usage', { p_restaurant_id: restaurantId }),
    ])
    if (p.error || l.error || m.error || a.error || u.error) {
      setMessage({ ok: false, text: 'โหลดโปรโมชันไม่สำเร็จ (รัน migration 0009 และ 0012 แล้วหรือยัง)' })
      return
    }
    setPromos(p.data as Promotion[])
    setLinks(l.data ?? [])
    setMenu(m.data as MenuItem[])
    setLive(new Set((a.data as Promotion[]).map((x) => x.id)))
    setUsage(Object.fromEntries((u.data as { promotion_id: string; used: number }[]).map((x) => [x.promotion_id, x.used])))
  }, [restaurantId])

  useEffect(() => {
    void load()
  }, [load])

  const itemsOf = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const l of links) map.set(l.promotion_id, [...(map.get(l.promotion_id) ?? []), l.menu_item_id])
    return map
  }, [links])
  const menuName = (id: string) => menu.find((m) => m.id === id)?.name ?? '-'

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function edit(p: Promotion | null) {
    setEditingId(p?.id ?? null)
    setOriginal({ starts_on: p?.starts_on ?? '', ends_on: p?.ends_on ?? '' })
    setForm(
      p
        ? {
            name: p.name,
            discount_type: p.discount_type,
            value: String(p.value),
            min_subtotal: Number(p.min_subtotal) > 0 ? String(p.min_subtotal) : '',
            starts_on: p.starts_on ?? '',
            ends_on: p.ends_on ?? '',
            days: p.days_of_week ?? [],
            start_time: p.start_time?.slice(0, 5) ?? '',
            end_time: p.end_time?.slice(0, 5) ?? '',
            max_uses: p.max_uses ? String(p.max_uses) : '',
            items: itemsOf.get(p.id) ?? [],
          }
        : EMPTY,
    )
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    const value = Number(form.value)
    if (!form.name.trim() || !(value > 0)) return setMessage({ ok: false, text: 'กรอกชื่อและมูลค่าส่วนลดที่มากกว่า 0' })
    if (form.discount_type === 'percent' && value > 100) return setMessage({ ok: false, text: 'ลดเป็น % ได้ไม่เกิน 100' })
    const today = todayISO()
    if (form.starts_on && form.starts_on !== original.starts_on && form.starts_on < today)
      return setMessage({ ok: false, text: 'วันเริ่มต้องไม่ย้อนหลังกว่าวันนี้' })
    if (form.ends_on && form.ends_on !== original.ends_on && form.ends_on < today)
      return setMessage({ ok: false, text: 'วันสิ้นสุดต้องไม่ย้อนหลังกว่าวันนี้' })
    if (form.starts_on && form.ends_on && form.ends_on < form.starts_on)
      return setMessage({ ok: false, text: 'วันสิ้นสุดต้องอยู่หลังวันเริ่ม (หรือวันเดียวกัน)' })
    const maxUses = form.max_uses ? Number(form.max_uses) : null
    if (maxUses !== null && !(Number.isInteger(maxUses) && maxUses >= 1))
      return setMessage({ ok: false, text: 'จำนวนครั้งที่ใช้ได้ต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป (เว้นว่าง = ไม่จำกัด)' })
    const row = {
      name: form.name.trim(),
      discount_type: form.discount_type,
      value,
      min_subtotal: Number(form.min_subtotal) || 0,
      starts_on: form.starts_on || null,
      ends_on: form.ends_on || null,
      days_of_week: form.days.length ? [...form.days].sort() : null,
      start_time: form.start_time || null,
      end_time: form.end_time || null,
      max_uses: maxUses,
    }
    const res = editingId
      ? await supabase.from('promotions').update(row).eq('id', editingId).select('id').single()
      : await supabase.from('promotions').insert({ ...row, restaurant_id: restaurantId }).select('id').single()
    if (res.error) {
      const text = promotionError(res.error.message)
      return setMessage({ ok: false, text: text === res.error.message ? 'บันทึกไม่สำเร็จ ตรวจวันที่/เวลา (สิ้นสุดต้องหลังเริ่ม)' : text })
    }
    const id = res.data.id as string
    // แทนที่รายการเมนูที่ร่วมโปรทั้งชุด
    await supabase.from('promotion_items').delete().eq('promotion_id', id)
    if (form.items.length) {
      const { error } = await supabase.from('promotion_items').insert(form.items.map((m) => ({ promotion_id: id, menu_item_id: m })))
      if (error) return setMessage({ ok: false, text: 'บันทึกเมนูที่ร่วมโปรไม่สำเร็จ' })
    }
    setMessage({ ok: true, text: `${editingId ? 'แก้ไข' : 'สร้าง'}โปร "${row.name}" แล้ว` })
    edit(null)
    void load()
  }

  async function toggle(p: Promotion) {
    const { error } = await supabase.from('promotions').update({ is_active: !p.is_active }).eq('id', p.id)
    setMessage(error ? { ok: false, text: error.message } : { ok: true, text: `${p.is_active ? 'ปิด' : 'เปิด'}ใช้งาน "${p.name}" แล้ว` })
    void load()
  }

  async function remove(p: Promotion) {
    if (!window.confirm(`ลบโปร "${p.name}"?`)) return
    const { error } = await supabase.from('promotions').delete().eq('id', p.id)
    setMessage(
      error
        ? { ok: false, text: error.code === '23503' ? 'โปรนี้เคยถูกใช้ในบิลแล้ว ลบไม่ได้ ให้ปิดใช้งานแทน' : error.message }
        : { ok: true, text: `ลบ "${p.name}" แล้ว` },
    )
    void load()
  }

  const today = todayISO()
  // โปรที่เริ่มไปแล้ว: คงวันเริ่มเดิมไว้ได้ แต่เลือกวันใหม่ที่ย้อนหลังกว่าวันนี้ไม่ได้
  const minStart = original.starts_on && original.starts_on < today ? original.starts_on : today
  const minEnd = form.starts_on && form.starts_on > today ? form.starts_on : today

  return (
    <div className="page">
      <h1 className="page-title mb-5">โปรโมชัน</h1>
      {message && (
        <p className={message.ok ? 'alert-success' : 'alert-error'}>{message.text}</p>
      )}

      <PromoSuggestions
        restaurantId={restaurantId}
        menuName={(id) => menu.find((m) => m.id === id)?.name ?? '?'}
        onCreated={(text) => {
          setMessage({ ok: true, text })
          void load()
        }}
      />

      <form onSubmit={save} className="card mb-6 space-y-3 text-sm">
        <h2 className="section-title mb-0">{editingId ? 'แก้ไขโปรโมชัน' : 'สร้างโปรโมชัน'}</h2>
        <div className="grid gap-2 sm:grid-cols-[1fr_140px_120px_160px]">
          <input className="input" placeholder="ชื่อโปร เช่น บ่ายเงียบลด 15%" maxLength={80} value={form.name} onChange={(e) => set('name', e.target.value)} required />
          <select className="input" value={form.discount_type} onChange={(e) => set('discount_type', e.target.value as Form['discount_type'])}>
            <option value="percent">ลดเป็น %</option>
            <option value="amount">ลดเป็นบาท</option>
          </select>
          <input className="input" type="number" min="0" step="0.01" placeholder={form.discount_type === 'percent' ? '%' : 'บาท'} value={form.value} onChange={(e) => set('value', e.target.value)} required />
          <input className="input" type="number" min="0" step="0.01" placeholder="ซื้อขั้นต่ำ (บาท)" value={form.min_subtotal} onChange={(e) => set('min_subtotal', e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-gray-500">จำนวนครั้งที่ใช้ได้</span>
          <input
            className="input w-36 py-1.5"
            type="number"
            min="1"
            step="1"
            placeholder="ไม่จำกัด"
            value={form.max_uses}
            onChange={(e) => set('max_uses', e.target.value)}
          />
          <span className="text-xs text-gray-400">นับ 1 ครั้งต่อ 1 ออเดอร์ (ใส่ตอนรับออเดอร์) หรือ 1 บิล (ใส่ตอนรับชำระ) · เว้นว่าง = ไม่จำกัด</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-gray-500">ช่วงวันที่</span>
          <input
            className="input py-1.5"
            type="date"
            min={minStart}
            value={form.starts_on}
            onChange={(e) => {
              const v = e.target.value
              setForm((f) => ({ ...f, starts_on: v, ends_on: f.ends_on && v && f.ends_on < v ? '' : f.ends_on }))
            }}
          />
          <span>ถึง</span>
          <input className="input py-1.5" type="date" min={minEnd} value={form.ends_on} onChange={(e) => set('ends_on', e.target.value)} />
          <span className="ml-2 text-gray-500">เวลา</span>
          <input className="input py-1.5" type="time" value={form.start_time} onChange={(e) => set('start_time', e.target.value)} />
          <span>–</span>
          <input className="input py-1.5" type="time" value={form.end_time} onChange={(e) => set('end_time', e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-gray-500">วัน (ไม่เลือก = ทุกวัน)</span>
          {DAY_SHORT.map((d, i) => (
            <label key={d} className={`cursor-pointer rounded-full border px-3.5 py-1.5 transition ${form.days.includes(i) ? 'border-gray-900 bg-gray-900 text-white' : 'bg-white text-gray-600 hover:border-gray-300'}`}>
              <input
                type="checkbox"
                className="hidden"
                checked={form.days.includes(i)}
                onChange={() => set('days', form.days.includes(i) ? form.days.filter((x) => x !== i) : [...form.days, i])}
              />
              {d}
            </label>
          ))}
        </div>
        <details>
          <summary className="cursor-pointer text-gray-600">
            เมนูที่ร่วมโปร: {form.items.length ? form.items.map(menuName).join(', ') : 'ทั้งบิล'}
          </summary>
          <div className="mt-2 grid grid-cols-2 gap-1 sm:grid-cols-4">
            {menu.map((m) => (
              <label key={m.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.items.includes(m.id)}
                  onChange={() => set('items', form.items.includes(m.id) ? form.items.filter((x) => x !== m.id) : [...form.items, m.id])}
                />
                {m.name}
              </label>
            ))}
          </div>
        </details>
        <div className="flex gap-2">
          <button className="btn btn-primary">{editingId ? 'บันทึก' : 'สร้างโปร'}</button>
          {editingId && (
            <button type="button" className="btn btn-secondary" onClick={() => edit(null)}>ยกเลิก</button>
          )}
        </div>
        <p className="text-xs text-gray-500">เวลาและวันคิดตามเขตเวลาของร้าน · ดูช่วงลูกค้าน้อย (ออฟพีค) ได้ที่หน้าวิเคราะห์ เพื่อตั้งโปรดึงลูกค้า</p>
      </form>

      <ul className="space-y-2">
        {promos.map((p) => {
          const its = itemsOf.get(p.id) ?? []
          return (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
              <div>
                <div className="font-medium">
                  {p.name}{' '}
                  {live.has(p.id) ? (
                    <span className="badge badge-green">ใช้ได้ตอนนี้</span>
                  ) : (
                    <span className="badge badge-gray">
                      {!p.is_active ? 'ปิดอยู่' : p.max_uses && (usage[p.id] ?? 0) >= p.max_uses ? 'ใช้ครบแล้ว' : 'ไม่อยู่ในช่วงเวลา'}
                    </span>
                  )}
                </div>
                <div className="text-gray-500">
                  {describePromotion(p)} · {its.length ? its.map(menuName).join(', ') : 'ทั้งบิล'}
                </div>
                <div className="mt-0.5 text-xs text-gray-500">
                  ใช้ไปแล้ว {(usage[p.id] ?? 0).toLocaleString('th-TH')}
                  {p.max_uses ? ` / ${p.max_uses.toLocaleString('th-TH')} ครั้ง (เหลือ ${Math.max(0, p.max_uses - (usage[p.id] ?? 0)).toLocaleString('th-TH')})` : ' ครั้ง'}
                </div>
              </div>
              <span className="flex gap-3">
                <button className="link" onClick={() => edit(p)}>แก้ไข</button>
                <button className="link" onClick={() => void toggle(p)}>{p.is_active ? 'ปิด' : 'เปิด'}</button>
                <button className="link-danger" onClick={() => void remove(p)}>ลบ</button>
              </span>
            </li>
          )
        })}
        {promos.length === 0 && <li className="empty">ยังไม่มีโปรโมชัน</li>}
      </ul>
    </div>
  )
}

export default function PromotionsPage() {
  return <RequireRole roles={rolesFor('/promotions')}>{(ctx) => <Board restaurantId={ctx.restaurantId} />}</RequireRole>
}
