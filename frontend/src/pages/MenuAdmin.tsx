import { translateUi } from "../lib/uiText"
import { useLocalPagination } from '../components/Pagination'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { rolesFor, type Role } from '../lib/roles'
import { baht } from '../lib/format'
import RequireRole from '../components/RequireRole'
import MediaManager, { MediaThumb } from '../components/MediaManager'
import PosterEditor, { type PosterTarget } from '../components/PosterEditor'
import DisplaySettingsPanel from '../components/DisplaySettingsPanel'
import type { DisplayMediaRow, MenuCategory, MenuItem } from '../lib/types'
import { useCachedState } from '../lib/useCachedState'

// จัดการเมนูและหมวด (เจ้าของ, ผู้จัดการ) / โต๊ะ (เจ้าของเท่านั้น)
// สิทธิ์จริงบังคับที่ฐานข้อมูล: menu_items_owner / menu_categories_owner / tables_owner

interface DiningTable {
  id: string
  label: string
}

function errText(message: string, code?: string): string {
  if (code === '23503') return 'ลบไม่ได้เพราะมีประวัติการขายแล้ว ให้ปิดขายแทน'
  if (code === '23505') return 'ชื่อนี้มีอยู่แล้ว'
  if (code === '42501') return 'ไม่มีสิทธิ์ทำรายการนี้'
  return message
}

function Board({ restaurantId, myRoles }: { restaurantId: string; myRoles: Role[] }) {
  const mutation = useRef(false)
  const isOwner = myRoles.includes('owner')
  const [categories, setCategories] = useCachedState<MenuCategory[]>(`menu.categories:${restaurantId}`, [])
  const [items, setItems] = useCachedState<MenuItem[]>(`menuadmin.items:${restaurantId}`, [])
  const [tables, setTables] = useCachedState<DiningTable[]>(`menu.tables:${restaurantId}`, [])
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const [editing, setEditing] = useState<MenuItem | null>(null)
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [newCategory, setNewCategory] = useState('')
  const [newTable, setNewTable] = useState('')
  const [options, setOptions] = useState<{ id: string; name: string; price: number }[]>([])
  const [optionName, setOptionName] = useState('')
  const [optionPrice, setOptionPrice] = useState('0')
  const [description, setDescription] = useState('')
  const [recommended, setRecommended] = useState(false)
  // 0023: ขายตามน้ำหนัก (ราคา = ต่อ 1 กก.) และวัตถุดิบที่ตัดตามน้ำหนักจริง
  const [soldByWeight, setSoldByWeight] = useState(false)
  const [weightIngredientId, setWeightIngredientId] = useState('')
  const [hasWeight, setHasWeight] = useState(true)
  const [weighable, setWeighable] = useCachedState<{ id: string; name: string; unit: string }[]>(`menuadmin.weighable:${restaurantId}`, [])
  const [media, setMedia] = useCachedState<DisplayMediaRow[]>(`menuadmin.media:${restaurantId}`, [])
  const [poster, setPoster] = useState<PosterTarget | null>(null)
  // false = ยังไม่ได้รัน migration 0013 (ซ่อนส่วนจอแสดงผล)
  const [hasDisplay, setHasDisplay] = useCachedState(`menuadmin.hasDisplay:${restaurantId}`, true)
  const [displayToken, setDisplayToken] = useCachedState<string | null>(`menuadmin.displayToken:${restaurantId}`, null)

  const load = useCallback(async () => {
    const [c, full, t, d, dm] = await Promise.all([
      supabase.from('menu_categories').select('id,name,sort_order').eq('restaurant_id', restaurantId).order('sort_order'),
      supabase
        .from('menu_items')
        .select('id,category_id,name,price,is_available,is_recommended,description,sold_by_weight,weight_ingredient_id,option_choices')
        .eq('restaurant_id', restaurantId)
        .order('name'),
      isOwner
        ? supabase.from('dining_tables').select('id,label').eq('restaurant_id', restaurantId).order('label')
        : Promise.resolve({ data: [], error: null }),
      supabase.from('display_screens').select('token').eq('restaurant_id', restaurantId).maybeSingle(),
      supabase.from('display_media').select('*').eq('restaurant_id', restaurantId).order('sort_order').order('created_at'),
    ])
    const noWeight = full.error
      ? await supabase.from('menu_items').select('id,category_id,name,price,is_available,is_recommended,description').eq('restaurant_id', restaurantId).order('name')
      : null
    const m = !full.error
      ? full
      : noWeight && !noWeight.error
        ? noWeight
        : await supabase.from('menu_items').select('id,category_id,name,price,is_available').eq('restaurant_id', restaurantId).order('name')
    setHasWeight(!full.error)
    setHasDisplay(!full.error || Boolean(noWeight && !noWeight.error))
    // วัตถุดิบหน่วย g/kg สำหรับของชั่งขาย (ผู้จัดการอ่านวัตถุดิบไม่ได้ จะได้รายการว่าง)
    const ing = await supabase.from('ingredients').select('id,name,unit').eq('restaurant_id', restaurantId).order('name')
    setWeighable((ing.data ?? []).filter((i) => ['g', 'kg', 'กรัม', 'กก', 'กก.', 'กิโลกรัม', 'กิโล', 'gram', 'grams', 'kilogram'].includes(i.unit.trim().toLowerCase())))
    setDisplayToken(d.error ? null : (d.data?.token ?? null))
    if (dm.error) setMessage({ ok: false, text: 'โหลดสื่อไม่สำเร็จ กรุณาลองใหม่' })
    else setMedia(dm.data as DisplayMediaRow[])
    if (c.error || m.error || t.error) {
      setMessage({ ok: false, text: 'โหลดข้อมูลไม่สำเร็จ' })
      return
    }
    setCategories(c.data as MenuCategory[])
    setItems((m.data as MenuItem[]).map((x) => ({ ...x, price: Number(x.price) })))
    setTables(t.data as DiningTable[])
  }, [restaurantId, isOwner])

  useEffect(() => {
    void load()
  }, [load])

  function result(error: { message: string; code?: string } | null, okText: string) {
    setMessage(error ? { ok: false, text: errText(error.message, error.code) } : { ok: true, text: okText })
    void load()
    return !error
  }

  function startEdit(item: MenuItem | null) {
    setEditing(item)
    setName(item?.name ?? '')
    setPrice(item ? String(item.price) : '')
    setCategoryId(item?.category_id ?? '')
    setDescription(item?.description ?? '')
    setOptions(item?.option_choices ?? [])
    setRecommended(item?.is_recommended ?? false)
    setSoldByWeight(item?.sold_by_weight ?? false)
    setWeightIngredientId(item?.weight_ingredient_id ?? '')
  }

  async function saveItem(e: FormEvent) {
    e.preventDefault()
    const value = Number(price)
    if (!name.trim() || !(value >= 0) || price === '') return setMessage({ ok: false, text: 'กรอกชื่อและราคาให้ถูกต้อง' })
    const base = { name: name.trim(), price: value, category_id: categoryId || null, option_choices: options }
    if (soldByWeight && !weightIngredientId && weighable.length > 0) return setMessage({ ok: false, text: 'ของชั่งขายต้องเลือกวัตถุดิบที่ตัดสต็อก (หน่วย g หรือ kg)' })
    const withDisplay = hasDisplay ? { ...base, description: description.trim() || null, is_recommended: recommended } : base
    const row = hasWeight
      ? { ...withDisplay, sold_by_weight: soldByWeight, weight_ingredient_id: soldByWeight ? weightIngredientId || null : null }
      : withDisplay
    if (mutation.current) return
    mutation.current = true
    const { error } = editing
      ? await supabase.from('menu_items').update(row).eq('id', editing.id)
      : await supabase.from('menu_items').insert({ ...row, restaurant_id: restaurantId })
    mutation.current = false
    if (result(error, editing ? `แก้ไข ${row.name} แล้ว` : `เพิ่ม ${row.name} แล้ว`)) startEdit(null)
  }

  async function toggle(item: MenuItem) {
    const { error } = await supabase.rpc('set_menu_availability', { p_item_id: item.id, p_available: !item.is_available })
    result(error, `${item.name}: ${item.is_available ? 'ปิดขาย (หมด)' : 'เปิดขาย'}แล้ว`)
  }

  async function toggleRecommended(item: MenuItem) {
    const { error } = await supabase.from('menu_items').update({ is_recommended: !item.is_recommended }).eq('id', item.id)
    result(error, `${item.name}: ${item.is_recommended ? 'เอาออกจากเมนูแนะนำ' : 'ตั้งเป็นเมนูแนะนำ'}แล้ว`)
  }

  async function rotateDisplay() {
    if (displayToken && !window.confirm('สร้างลิงก์ใหม่? จอที่เปิดลิงก์เดิมอยู่จะใช้ไม่ได้ ต้องเปิดลิงก์ใหม่')) return
    const { error } = await supabase.rpc('display_rotate_token', { p_restaurant_id: restaurantId })
    result(error, 'สร้างลิงก์จอแสดงผลแล้ว')
  }

  async function disableDisplay() {
    if (!window.confirm('ปิดลิงก์จอแสดงผล? จอที่เปิดอยู่จะหยุดแสดงภายใน 60 วินาที')) return
    const { error } = await supabase.rpc('display_disable', { p_restaurant_id: restaurantId })
    result(error, 'ปิดลิงก์จอแสดงผลแล้ว')
  }

  // ลบไฟล์ใน Storage ที่ไม่มีสื่อไหนใช้แล้ว (เช่น รูปพื้นหลังโปสเตอร์เก่า ไฟล์ที่อัปโหลดแล้วลบสื่อไม่สำเร็จ)
  async function cleanStorage() {
    setMessage({ ok: false, text: 'ปิดการลบไฟล์อัตโนมัติชั่วคราว เพื่อป้องกันการลบสื่อที่จอหรือโปสเตอร์อื่นกำลังใช้งาน' })
  }

  async function copyDisplayLink(link: string) {
    try {
      await navigator.clipboard.writeText(link)
      setMessage({ ok: true, text: 'คัดลอกลิงก์แล้ว' })
    } catch {
      setMessage({ ok: false, text: 'คัดลอกไม่ได้ ให้กดค้างที่ลิงก์เพื่อคัดลอกเอง' })
    }
  }

  async function removeItem(item: MenuItem) {
    if (!window.confirm(`ลบเมนู ${item.name}?`)) return
    const { error } = await supabase.from('menu_items').delete().eq('id', item.id)
    result(error, `ลบ ${item.name} แล้ว`)
  }

  async function addCategory(e: FormEvent) {
    e.preventDefault()
    if (!newCategory.trim() || mutation.current) return
    mutation.current = true
    const sort = Math.max(0, ...categories.map((c) => c.sort_order)) + 1
    const { error } = await supabase.from('menu_categories').insert({ restaurant_id: restaurantId, name: newCategory.trim(), sort_order: sort })
    mutation.current = false
    if (result(error, `เพิ่มหมวด ${newCategory.trim()} แล้ว`)) setNewCategory('')
  }

  async function renameCategory(c: MenuCategory) {
    const next = window.prompt('ชื่อหมวดใหม่', c.name)?.trim()
    if (!next || next === c.name) return
    const { error } = await supabase.from('menu_categories').update({ name: next }).eq('id', c.id)
    result(error, 'เปลี่ยนชื่อหมวดแล้ว')
  }

  async function removeCategory(c: MenuCategory) {
    if (!window.confirm(`ลบหมวด ${c.name}? เมนูในหมวดนี้จะกลายเป็น "ไม่มีหมวด"`)) return
    const { error } = await supabase.from('menu_categories').delete().eq('id', c.id)
    result(error, `ลบหมวด ${c.name} แล้ว`)
  }

  async function addTable(e: FormEvent) {
    e.preventDefault()
    if (!newTable.trim() || mutation.current) return
    mutation.current = true
    const { error } = await supabase.from('dining_tables').insert({ restaurant_id: restaurantId, label: newTable.trim() })
    mutation.current = false
    if (result(error, `เพิ่ม ${newTable.trim()} แล้ว`)) setNewTable('')
  }

  async function removeTable(t: DiningTable) {
    if (!window.confirm(`ลบ ${t.label}?`)) return
    const { error } = await supabase.from('dining_tables').delete().eq('id', t.id)
    result(error, `ลบ ${t.label} แล้ว`)
  }

  const catName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? 'ไม่มีหมวด'
  const displayLink = displayToken ? `${window.location.origin}/display/${displayToken}` : null
  const recommendedCount = items.filter((i) => i.is_recommended && i.is_available).length
  const firstMedia = (itemId: string) => media.find((m) => m.menu_item_id === itemId && m.is_active)
  const ads = media.filter((m) => m.menu_item_id === null)
  const [search, setSearch] = useState('')
  const pagination = useLocalPagination(items.filter(item => item.name.toLowerCase().includes(search.toLowerCase())), restaurantId + search, translateUi('เมนู'))

  return (
    <div className="page">
      <h1 className="page-title mb-5">{translateUi("จัดการเมนู")}</h1>
      {message && (
        <p className={message.ok ? 'alert-success' : 'alert-error'}>{message.text}</p>
      )}

      <section className="card mb-6">
        <h2 className="section-title">{editing ? `แก้ไข: ${editing.name}` : 'เพิ่มเมนู'}</h2>
        <form onSubmit={saveItem} className="grid gap-2 sm:grid-cols-[1fr_120px_180px_auto]">
          <input className="input" placeholder={translateUi("ชื่อเมนู")} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} required />
          <input className="input" type="number" min="0" step="0.01" placeholder={soldByWeight ? 'ราคาต่อ กก.' : 'ราคา'} value={price} onChange={(e) => setPrice(e.target.value)} required />
          <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">{translateUi("ไม่มีหมวด")}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <div className="flex gap-2">
            <button className="btn btn-primary">{editing ? 'บันทึก' : 'เพิ่ม'}</button>
            {editing && (
              <button type="button" className="btn btn-secondary" onClick={() => startEdit(null)}>{translateUi("ยกเลิก")}</button>
            )}
          </div>
          <fieldset className="rounded-xl border p-3 sm:col-span-4"><legend>{translateUi("ตัวเลือกที่มีราคาเพิ่มเติม")}</legend><div className="toolbar"><input aria-label={translateUi("ชื่อตัวเลือก")} className="input" placeholder={translateUi("เช่น เพิ่มไข่ดาว")} value={optionName} onChange={(e) => setOptionName(e.target.value)} /><input aria-label={translateUi("ราคาตัวเลือก")} className="input w-28" type="number" min="0" step="0.01" value={optionPrice} onChange={(e) => setOptionPrice(e.target.value)} /><button type="button" className="btn btn-secondary" disabled={!optionName.trim() || !Number.isFinite(Number(optionPrice)) || Number(optionPrice) < 0} onClick={() => { setOptions([...options, { id: crypto.randomUUID(), name: optionName.trim(), price: Number(optionPrice) }]); setOptionName(''); setOptionPrice('0') }}>{translateUi("เพิ่มตัวเลือก")}</button></div><ul>{options.map((o) => <li key={o.id} className="toolbar mt-2">{o.name} +{baht(o.price)}<button type="button" className="link-danger" onClick={() => setOptions(options.filter((x) => x.id !== o.id))}>{translateUi("เอาออก")}</button></li>)}</ul></fieldset>
          {hasWeight && (
            <div className="grid gap-2 rounded-xl bg-gray-50 p-3 sm:col-span-4 sm:grid-cols-[auto_1fr] sm:items-center">
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-gray-700">
                <input type="checkbox" className="h-4 w-4 accent-brand-500" checked={soldByWeight} onChange={(e) => setSoldByWeight(e.target.checked)} />{"" + translateUi("ขายตามน้ำหนักจริง (ชั่งหน้าตู้)") + " "}</label>
              {soldByWeight && (
                <select className="input" value={weightIngredientId} onChange={(e) => setWeightIngredientId(e.target.value)}>
                  <option value="">{weighable.length ? 'ตัดสต็อกจากวัตถุดิบ...' : 'ไม่มีวัตถุดิบหน่วย g/kg (หรือไม่มีสิทธิ์ดูวัตถุดิบ)'}</option>
                  {weighable.map((i) => (
                    <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>
                  ))}
                </select>
              )}
              {soldByWeight && (
                <p className="hint sm:col-span-2">{"" + translateUi("ราคาที่กรอก = ราคาต่อ 1 กก. / หน้ารับออเดอร์จะให้กรอกน้ำหนักที่ชั่ง ระบบคิดราคาและตัดสต็อกตามน้ำหนักจริง / น้ำจิ้ม/เครื่องเคียงใส่ในสูตรอาหารได้ตามปกติ") + " "}</p>
              )}
            </div>
          )}
          {hasDisplay && (
            <div className="grid gap-2 sm:col-span-4 sm:grid-cols-[1fr_auto] sm:items-center">
              <input
                className="input"
                placeholder={translateUi("คำโปรยบนจอแสดงผล เช่น หอมกะเพราแท้ ไข่ดาวกรอบ (ไม่บังคับ)")}
                maxLength={200}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-gray-700">
                <input type="checkbox" className="h-4 w-4 accent-brand-500" checked={recommended} onChange={(e) => setRecommended(e.target.checked)} />{"" + translateUi("ร้านแนะนำ (ขึ้นจอ iPad)") + " "}</label>
            </div>
          )}
        </form>
        {hasDisplay && editing && (
          <div className="mt-4 border-t pt-4">
            <h3 className="mb-2 text-sm strong-text">{"" + translateUi("รูป/วิดีโอของ") + " "}{editing.name}{" " + translateUi("บนจอ iPad") + ""}</h3>
            <MediaManager
              restaurantId={restaurantId}
              menuItemId={editing.id}
              media={media.filter((m) => m.menu_item_id === editing.id)}
              reload={() => void load()}
              notify={setMessage}
              onPoster={(m) => setPoster({ media: m, menuItemId: editing.id })}
            />
          </div>
        )}
      </section>

      <section className="mb-6">
        <h2 className="section-title">{translateUi("เมนูทั้งหมด (")}{items.length})</h2>
        <input className="input mt-4 w-full" aria-label={translateUi('ค้นหาเมนู')} placeholder={translateUi('ค้นหาเมนู')} value={search} onChange={e => setSearch(e.target.value)} />
        {pagination.controls}
        <div className="table-wrap history-scroll">
          <table className="w-full text-left text-sm [&_td]:px-3 [&_td]:py-2.5 [&_th]:px-3 [&_th]:py-2.5 [&_tbody_tr:hover]:bg-gray-50">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="p-2">{translateUi("เมนู")}</th>
                <th className="p-2">{translateUi("หมวด")}</th>
                <th className="p-2 text-right">{translateUi("ราคา")}</th>
                <th className="p-2">{translateUi("สถานะ")}</th>
                {hasDisplay && <th className="p-2">{translateUi("ร้านแนะนำ")}</th>}
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {pagination.items.map((it) => (
                <tr key={it.id} className="border-t">
                  <td className="p-2">
                    <span className="flex items-center gap-2">
                      {firstMedia(it.id) && <MediaThumb m={firstMedia(it.id)!} size="h-9 w-12" />}
                      {it.name}
                    </span>
                  </td>
                  <td className="p-2 text-gray-500">{catName(it.category_id)}</td>
                  <td className="p-2 text-right">{baht(it.price)}{it.sold_by_weight && <span className="block hint">{translateUi("ต่อ กก. (ชั่ง)")}</span>}</td>
                  <td className="p-2">
                    <button
                      className={`badge ${it.is_available ? 'badge-green' : 'badge-gray'}`}
                      onClick={() => void toggle(it)}
                      title={translateUi("กดเพื่อสลับ")}
                    >
                      {it.is_available ? 'เปิดขาย' : 'หมด'}
                    </button>
                  </td>
                  {hasDisplay && (
                    <td className="p-2">
                      <button
                        className={`badge ${it.is_recommended ? 'badge-brand' : 'badge-gray'}`}
                        onClick={() => void toggleRecommended(it)}
                        title={translateUi("กดเพื่อสลับ")}
                      >
                        {it.is_recommended ? '★ แนะนำ' : '☆ ไม่แสดง'}
                      </button>
                    </td>
                  )}
                  <td className="whitespace-nowrap p-2 text-right">
                    <button className="link mr-3" onClick={() => startEdit(it)}>{translateUi("แก้ไข")}</button>
                    <button className="link-danger" onClick={() => void removeItem(it)}>{translateUi("ลบ")}</button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td className="empty-cell" colSpan={hasDisplay ? 6 : 5}>{translateUi("ยังไม่มีเมนู")}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-1 hint">{translateUi("เมนูที่เคยขายแล้วลบไม่ได้ (เพื่อเก็บประวัติบัญชี) ให้ตั้งเป็น \"หมด\" แทน / สูตรอาหารแก้ที่หน้าสต็อก")}</p>
      </section>

      {hasDisplay && (
        <section className="card mb-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="section-title mb-1">{translateUi("จอแสดงผล iPad (แมกกาซีนเมนูแนะนำ)")}</h2>
              <p className="text-sm text-gray-500">{translateUi("เปิดลิงก์นี้บน iPad ได้เลยไม่ต้องล็อกอิน / แสดงเมนู \"ร้านแนะนำ\" ที่ยังไม่หมด (")}{recommendedCount}{" " + translateUi("เมนู) และโปรที่ใช้ได้ตอนนี้ / อัปเดตเองทุกนาที") + " "}</p>
            </div>
            <div className="flex gap-2">
              <button className="btn btn-primary btn-sm" onClick={() => void rotateDisplay()}>
                {displayToken ? 'สร้างลิงก์ใหม่' : 'สร้างลิงก์จอ'}
              </button>
              {displayToken && (
                <button className="btn btn-ghost btn-sm" onClick={() => void disableDisplay()}>{translateUi("ปิดลิงก์")}</button>
              )}
            </div>
          </div>
          {displayLink && (
            <div className="mt-3 toolbar rounded-xl bg-gray-50 p-3">
              <code className="min-w-0 flex-1 truncate text-sm text-gray-700" title={displayLink}>{displayLink}</code>
              <button className="btn btn-secondary btn-sm" onClick={() => void copyDisplayLink(displayLink)}>{translateUi("คัดลอก")}</button>
              <a className="btn btn-secondary btn-sm" href={displayLink} target="_blank" rel="noreferrer">{translateUi("เปิดดู")}</a>
            </div>
          )}
          {displayLink && (
            <p className="note mt-2">{translateUi("ใครมีลิงก์ก็เปิดดูได้ (เห็นเฉพาะเมนูแนะนำและโปร) ถ้าลิงก์หลุดให้กด \"สร้างลิงก์ใหม่\"")}</p>
          )}
          <div className="mt-5 border-t pt-4">
            <h3 className="text-sm strong-text">{translateUi("สไลด์โฆษณาร้าน (")}{ads.filter((a) => a.is_active).length})</h3>
            <p className="mb-2 hint">{translateUi("คลิปบรรยากาศร้าน วิดีโอแนะนำ หรือภาพโปสเตอร์ ที่ไม่ผูกกับเมนูใด / กด \"แก้ไข\" เพื่อใส่หัวข้อ/คำบรรยาย")}</p>
            <MediaManager
              restaurantId={restaurantId}
              menuItemId={null}
              media={ads}
              reload={() => void load()}
              notify={setMessage}
              onPoster={(m) => setPoster({ media: m, menuItemId: null })}
            />
          </div>
          <div className="mt-4 toolbar justify-between">
            <p className="hint">{translateUi("รูป/วิดีโอของแต่ละเมนู: กด \"แก้ไข\" ที่เมนูในตารางด้านล่าง")}</p>
            <button className="btn btn-ghost btn-sm" onClick={() => void cleanStorage()} title={translateUi("ลบไฟล์ใน Storage ที่ไม่มีสื่อไหนใช้แล้ว")}>{"" + translateUi("ล้างไฟล์ที่ไม่ได้ใช้") + " "}</button>
          </div>
        </section>
      )}

      {hasDisplay && (
        <section className="card mb-6">
          <h2 className="section-title mb-1">{translateUi("หน้าตาจอ iPad")}</h2>
          <p className="mb-4 text-sm text-gray-500">{translateUi("สี ฟอนต์ เวลาต่อสไลด์ และสิ่งที่แสดงบนจอ")}</p>
          <DisplaySettingsPanel restaurantId={restaurantId} token={displayToken} notify={setMessage} />
        </section>
      )}

      {poster && (
        <PosterEditor
          restaurantId={restaurantId}
          items={items}
          media={media}
          target={poster}
          onClose={() => setPoster(null)}
          onSaved={(text) => {
            setPoster(null)
            setMessage({ ok: true, text })
            void load()
          }}
        />
      )}

      <section className="mb-6">
        <h2 className="section-title">{translateUi("หมวดเมนู")}</h2>
        <form onSubmit={addCategory} className="mb-2 flex gap-2">
          <input className="input flex-1" placeholder={translateUi("ชื่อหมวดใหม่")} maxLength={50} value={newCategory} onChange={(e) => setNewCategory(e.target.value)} />
          <button className="btn btn-secondary">{translateUi("เพิ่มหมวด")}</button>
        </form>
        <ul className="list-card">
          {categories.map((c) => (
            <li key={c.id} className="flex justify-between p-2">
              <span>{c.name}</span>
              <span>
                <button className="link mr-3" onClick={() => void renameCategory(c)}>{translateUi("เปลี่ยนชื่อ")}</button>
                <button className="link-danger" onClick={() => void removeCategory(c)}>{translateUi("ลบ")}</button>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {isOwner && (
        <section>
          <h2 className="section-title">{translateUi("โต๊ะ (เจ้าของร้านเท่านั้น)")}</h2>
          <form onSubmit={addTable} className="mb-2 flex gap-2">
            <input className="input flex-1" placeholder={translateUi("ชื่อโต๊ะ เช่น โต๊ะ 6")} maxLength={30} value={newTable} onChange={(e) => setNewTable(e.target.value)} />
            <button className="btn btn-secondary">{translateUi("เพิ่มโต๊ะ")}</button>
          </form>
          <div className="flex flex-wrap gap-2">
            {tables.map((t) => (
              <span key={t.id} className="flex items-center gap-2 rounded-full border px-3 py-1 text-sm">
                {t.label}
                <button className="link-danger" onClick={() => void removeTable(t)} aria-label={`ลบ ${t.label}`}>×</button>
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

export default function MenuAdmin() {
  return (
    <RequireRole roles={rolesFor('/menu')}>{(ctx) => <Board restaurantId={ctx.restaurantId} myRoles={ctx.roles} />}</RequireRole>
  )
}
