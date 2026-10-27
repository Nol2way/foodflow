import { useMemo, useState, type FormEvent } from 'react'
import RequireRole from '../components/RequireRole'
import RecipeEditor from '../components/stock/RecipeEditor'
import { PageHead, StockNav } from '../components/stock/ui'
import { baht } from '../lib/format'
import { rolesFor, type Role } from '../lib/roles'
import { supabase } from '../lib/supabase'
import { errorText, stockApi, useLoad, type StockIngredient, type Supplier } from '../lib/stockApi'
import { displayQty, fmtNum, RECIPE_UNITS, yieldUnitCost, type AbcClass, type RecipeUnit } from '../lib/stockMath'
import { useUnits } from '../lib/units'

// ตั้งค่าสต็อก: วัตถุดิบ · ผู้ขาย · สูตร (รองรับสูตรย่อย) · หน่วย · เกณฑ์ตรวจรับ · เปิด/ปิดเมนูเอง
// ยอดคงเหลือ/ต้นทุนแก้ที่นี่ไม่ได้ (มาจากรับเข้า ตัดตามสูตร และการนับ)

const DAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส']

interface IngForm {
  name: string
  recipe_unit: RecipeUnit
  unit: string
  purchase_unit: string
  conversion_factor: string
  display_unit: string
  display_factor: string
  trim_yield_pct: string
  cook_yield_pct: string
  abc_class: AbcClass
  storage_location: string
  shelf_order: string
  reorder_level: string
  safety_stock: string
  par_level: string
  supplier_id: string
  category: string
  is_active: boolean
  opening: string // สร้างใหม่: ยอดยกมา (หน่วยฐาน)
  cost: string // สร้างใหม่: ราคาต่อหน่วยซื้อ
}
const NEW_ING: IngForm = {
  name: '', recipe_unit: 'g', unit: '', purchase_unit: 'kg', conversion_factor: '1000', display_unit: '', display_factor: '1',
  trim_yield_pct: '100', cook_yield_pct: '100', abc_class: 'C', storage_location: '', shelf_order: '0', reorder_level: '0',
  safety_stock: '0', par_level: '', supplier_id: '', category: '', is_active: true, opening: '', cost: '',
}
const toForm = (i: StockIngredient): IngForm => ({
  name: i.name, recipe_unit: i.recipe_unit, unit: i.recipe_unit === 'pcs' ? i.unit : '', purchase_unit: i.purchase_unit,
  conversion_factor: String(i.conversion_factor), display_unit: i.display_unit ?? '', display_factor: String(i.display_factor),
  trim_yield_pct: String(i.trim_yield_pct), cook_yield_pct: String(i.cook_yield_pct), abc_class: i.abc_class,
  storage_location: i.storage_location ?? '', shelf_order: String(i.shelf_order), reorder_level: String(i.reorder_level),
  safety_stock: String(i.safety_stock), par_level: i.par_level === null ? '' : String(i.par_level), supplier_id: i.supplier_id ?? '',
  category: i.category ?? '', is_active: i.is_active, opening: '', cost: '',
})

function IngredientsSection({ restaurantId, canWrite, suppliers, ingredients, reload, notify }: {
  restaurantId: string
  canWrite: boolean
  suppliers: Supplier[]
  ingredients: StockIngredient[]
  reload: () => void
  notify: (ok: boolean, text: string) => void
}) {
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<StockIngredient | 'new' | null>(null)
  const [form, setForm] = useState<IngForm>(NEW_ING)
  const [saving, setSaving] = useState(false)
  const supName = new Map(suppliers.map((s) => [s.id, s.name]))
  const visible = ingredients.filter((i) => {
    const q = search.trim().toLowerCase()
    return !q || i.name.toLowerCase().includes(q) || (i.storage_location ?? '').toLowerCase().includes(q) || (i.category ?? '').toLowerCase().includes(q)
  })
  const base = form.recipe_unit === 'pcs' ? form.unit || 'ชิ้น' : form.recipe_unit
  const f = (k: keyof IngForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value })

  async function save(e: FormEvent) {
    e.preventDefault()
    const n = (v: string) => Number(v)
    const row: Record<string, unknown> = {
      name: form.name.trim(), purchase_unit: form.purchase_unit.trim() || base, conversion_factor: n(form.conversion_factor),
      display_unit: form.display_unit.trim() || null, display_factor: n(form.display_factor) || 1,
      trim_yield_pct: n(form.trim_yield_pct), cook_yield_pct: n(form.cook_yield_pct), abc_class: form.abc_class,
      storage_location: form.storage_location.trim() || null, shelf_order: Math.round(n(form.shelf_order) || 0),
      reorder_level: n(form.reorder_level) || 0, safety_stock: n(form.safety_stock) || 0,
      par_level: form.par_level === '' ? null : n(form.par_level), supplier_id: form.supplier_id || null,
      category: form.category.trim() || null, is_active: form.is_active,
    }
    if (form.recipe_unit === 'pcs') row.unit = form.unit.trim() || 'ชิ้น'
    setSaving(true)
    try {
      if (editing === 'new') {
        await stockApi.createIngredient(restaurantId, {
          ...row, recipe_unit: form.recipe_unit,
          quantity_on_hand: n(form.opening) || 0,
          // ราคาต่อหน่วยซื้อ -> ต่อหน่วยฐาน (ล็อตแรก)
          cost_per_unit: form.cost ? n(form.cost) / (n(form.conversion_factor) || 1) : 0,
        })
      } else if (editing) {
        await stockApi.updateIngredient(restaurantId, editing.id, row)
      }
      notify(true, `บันทึก ${row.name} แล้ว`)
      setEditing(null)
      reload()
    } catch (err) {
      notify(false, errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="section-title mb-0 flex-1">วัตถุดิบ</h2>
        <input className="input w-48 py-1.5" placeholder="ค้นหา ชื่อ/ตำแหน่ง/หมวด" value={search} onChange={(e) => setSearch(e.target.value)} />
        {canWrite && <button className="btn btn-primary btn-sm" onClick={() => { setEditing('new'); setForm(NEW_ING) }}>+ เพิ่มวัตถุดิบ</button>}
      </div>
      <div className="card-flush overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="text-left">
              <th className="px-3 py-2">วัตถุดิบ</th>
              <th className="px-3 py-2 text-right">คงเหลือ</th>
              <th className="px-3 py-2 text-right">ต้นทุนใช้ได้/หน่วย</th>
              <th className="px-3 py-2">Yield</th>
              <th className="px-3 py-2">ตำแหน่ง</th>
              <th className="px-3 py-2">ผู้ขาย</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {visible.map((i) => (
              <tr key={i.id} className={i.is_active ? '' : 'text-gray-400'}>
                <td className="px-3 py-2">
                  <span className="font-medium">{i.name}</span>
                  <span className="badge badge-gray ml-1.5">{i.abc_class}</span>
                  {!i.is_active && <span className="badge badge-gray ml-1">ปิดใช้งาน</span>}
                  <div className="text-xs text-gray-500">
                    ซื้อเป็น {i.purchase_unit} (= {fmtNum(Number(i.conversion_factor))} {i.unit})
                    {i.display_unit && Number(i.display_factor) !== 1 && ` · ครัวนับเป็น ${i.display_unit} (= ${fmtNum(Number(i.display_factor))} ${i.unit})`}
                  </div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{displayQty(Number(i.quantity_on_hand), i.unit, i.display_unit, Number(i.display_factor))}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                  {baht(yieldUnitCost(Number(i.last_unit_cost ?? i.cost_per_unit), Number(i.trim_yield_pct), Number(i.cook_yield_pct)))}/{i.unit}
                </td>
                <td className="px-3 py-2 text-xs text-gray-600">ตัดแต่ง {fmtNum(Number(i.trim_yield_pct), 2)}% · สุก {fmtNum(Number(i.cook_yield_pct), 2)}%</td>
                <td className="px-3 py-2 text-gray-600">{i.storage_location ?? '-'}</td>
                <td className="px-3 py-2 text-gray-600">{i.supplier_id ? supName.get(i.supplier_id) : '-'}</td>
                <td className="px-3 py-2 text-right">{canWrite && <button className="link-muted" onClick={() => { setEditing(i); setForm(toForm(i)) }}>แก้ไข</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-gray-900/40 p-4" onClick={() => setEditing(null)}>
          <form onSubmit={save} className="card max-h-[92vh] w-full max-w-2xl space-y-4 overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}
            role="dialog" aria-modal="true" aria-label="วัตถุดิบ">
            <h2 className="text-lg font-bold text-gray-900">{editing === 'new' ? 'เพิ่มวัตถุดิบ' : `แก้ไข ${editing.name}`}</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="sm:col-span-2">
                <span className="label">ชื่อ</span>
                <input className="input w-full" required maxLength={100} value={form.name} onChange={f('name')} />
              </label>
              <label>
                <span className="label">หน่วยฐาน (สต็อก/สูตร)</span>
                <select className="input w-full" value={form.recipe_unit} disabled={editing !== 'new'} onChange={f('recipe_unit')}>
                  {RECIPE_UNITS.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
                </select>
              </label>
              {form.recipe_unit === 'pcs' && (
                <label>
                  <span className="label">ชื่อหน่วย (เช่น ฟอง ตัว ขวด)</span>
                  <input className="input w-full" maxLength={30} value={form.unit} onChange={f('unit')} />
                </label>
              )}
            </div>

            <fieldset className="grid gap-3 sm:grid-cols-4">
              <legend className="mb-1 text-sm font-semibold text-gray-700">หน่วยซื้อ / หน่วยที่ครัวพูด</legend>
              <label>
                <span className="label">หน่วยซื้อ</span>
                <input className="input w-full" maxLength={30} placeholder="kg, ลัง" value={form.purchase_unit} onChange={f('purchase_unit')} />
              </label>
              <label>
                <span className="label">1 หน่วยซื้อ = ? {base}</span>
                <input className="input w-full text-right" type="number" min="0" step="any" required value={form.conversion_factor} onChange={f('conversion_factor')} />
              </label>
              <label>
                <span className="label">หน่วยครัว (นับ)</span>
                <input className="input w-full" maxLength={30} placeholder="ถุง, ฟอง" value={form.display_unit} onChange={f('display_unit')} />
              </label>
              <label>
                <span className="label">1 หน่วยครัว = ? {base}</span>
                <input className="input w-full text-right" type="number" min="0" step="any" value={form.display_factor} onChange={f('display_factor')} />
              </label>
            </fieldset>

            <fieldset className="grid gap-3 sm:grid-cols-4">
              <legend className="mb-1 text-sm font-semibold text-gray-700">Yield (ทำ yield test ได้ที่หน้า Yield test)</legend>
              <label>
                <span className="label">ตัดแต่ง trim %</span>
                <input className="input w-full text-right" type="number" min="0.01" max="100" step="any" required value={form.trim_yield_pct} onChange={f('trim_yield_pct')} />
              </label>
              <label>
                <span className="label">ปรุงสุก cook %</span>
                <input className="input w-full text-right" type="number" min="0.01" max="400" step="any" required value={form.cook_yield_pct} onChange={f('cook_yield_pct')} />
              </label>
              <p className="self-end text-xs text-gray-500 sm:col-span-2">
                ต้นทุนต่อหน่วยที่ใช้ได้ = ราคาซื้อ ÷ (trim × cook) · สูตรใช้สุทธิ 100 {base} ตัดดิบ{' '}
                {fmtNum((100 * 10000) / ((Number(form.trim_yield_pct) || 100) * (Number(form.cook_yield_pct) || 100)))} {base}
              </p>
            </fieldset>

            <fieldset className="grid gap-3 sm:grid-cols-4">
              <legend className="mb-1 text-sm font-semibold text-gray-700">จัดเก็บ / สั่งซื้อ</legend>
              <label>
                <span className="label">คลาส ABC</span>
                <select className="input w-full" value={form.abc_class} onChange={f('abc_class')}>
                  <option value="A">A มูลค่าสูง</option>
                  <option value="B">B ปานกลาง</option>
                  <option value="C">C มูลค่าต่ำ</option>
                </select>
              </label>
              <label>
                <span className="label">ตำแหน่งจัดเก็บ</span>
                <input className="input w-full" maxLength={40} placeholder="ตู้แช่ 1" value={form.storage_location} onChange={f('storage_location')} />
              </label>
              <label>
                <span className="label">ลำดับบนชั้น</span>
                <input className="input w-full text-right" type="number" min="0" step="1" value={form.shelf_order} onChange={f('shelf_order')} />
              </label>
              <label>
                <span className="label">ผู้ขายหลัก</span>
                <select className="input w-full" value={form.supplier_id} onChange={f('supplier_id')}>
                  <option value="">-</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label>
                <span className="label">จุดสั่ง/ใกล้หมด ({base})</span>
                <input className="input w-full text-right" type="number" min="0" step="any" value={form.reorder_level} onChange={f('reorder_level')} />
              </label>
              <label>
                <span className="label">Safety stock ({base})</span>
                <input className="input w-full text-right" type="number" min="0" step="any" value={form.safety_stock} onChange={f('safety_stock')} />
              </label>
              <label>
                <span className="label">Par ({base}) ว่าง = คำนวณให้</span>
                <input className="input w-full text-right" type="number" min="0" step="any" placeholder="อัตโนมัติ" value={form.par_level} onChange={f('par_level')} />
              </label>
              <label>
                <span className="label">หมวด</span>
                <input className="input w-full" maxLength={40} value={form.category} onChange={f('category')} />
              </label>
            </fieldset>

            {editing === 'new' ? (
              <fieldset className="grid gap-3 sm:grid-cols-2">
                <legend className="mb-1 text-sm font-semibold text-gray-700">ยอดยกมา (ไม่บังคับ บันทึกเป็นรายการแรกใน ledger)</legend>
                <label>
                  <span className="label">มีอยู่ตอนนี้ ({base})</span>
                  <input className="input w-full text-right" type="number" min="0" step="any" value={form.opening} onChange={f('opening')} />
                </label>
                <label>
                  <span className="label">ราคาต่อ {form.purchase_unit || base} (บาท)</span>
                  <input className="input w-full text-right" type="number" min="0" step="any" value={form.cost} onChange={f('cost')} />
                </label>
              </fieldset>
            ) : (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
                ใช้งานอยู่ (ปิดแล้วไม่แสดงในใบนับ/รับเข้า · ประวัติยังอยู่)
              </label>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>ยกเลิก</button>
              <button className="btn btn-primary" disabled={saving}>{saving ? 'กำลังบันทึก...' : 'บันทึก'}</button>
            </div>
          </form>
        </div>
      )}
    </section>
  )
}

function SuppliersSection({ restaurantId, canWrite, suppliers, reload, notify }: {
  restaurantId: string
  canWrite: boolean
  suppliers: Supplier[]
  reload: () => void
  notify: (ok: boolean, text: string) => void
}) {
  const [edit, setEdit] = useState<{ id: string | null; name: string; phone: string; lead: string; days: number[] } | null>(null)
  async function save(e: FormEvent) {
    e.preventDefault()
    if (!edit) return
    if (!edit.days.length) return notify(false, 'เลือกวันที่ผู้ขายมาส่งอย่างน้อย 1 วัน')
    try {
      await stockApi.saveSupplier(restaurantId, edit.id, { name: edit.name, phone: edit.phone, lead_time_days: Number(edit.lead) || 0, delivery_days: edit.days })
      notify(true, `บันทึกผู้ขาย ${edit.name} แล้ว`)
      setEdit(null)
      reload()
    } catch (err) {
      notify(false, errorText(err))
    }
  }
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="section-title mb-0">ผู้ขาย</h2>
        {canWrite && <button className="btn btn-secondary btn-sm" onClick={() => setEdit({ id: null, name: '', phone: '', lead: '1', days: [1, 2, 3, 4, 5, 6] })}>+ ผู้ขาย</button>}
      </div>
      <ul className="card-flush divide-y text-sm">
        {suppliers.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3">
            <span className="min-w-40 flex-1 font-medium text-gray-900">{s.name}{s.phone && <span className="ml-2 font-normal text-gray-500">{s.phone}</span>}</span>
            <span className="text-gray-600">สั่งแล้วได้ของใน {s.lead_time_days} วัน · ส่ง {s.delivery_days.map((d) => DAYS[d]).join(' ')}</span>
            {canWrite && (
              <button className="link-muted" onClick={() => setEdit({ id: s.id, name: s.name, phone: s.phone ?? '', lead: String(s.lead_time_days), days: s.delivery_days })}>แก้ไข</button>
            )}
          </li>
        ))}
        {suppliers.length === 0 && <li className="p-6 text-center text-gray-400">ยังไม่มีผู้ขาย</li>}
      </ul>
      {edit && (
        <form onSubmit={save} className="card mt-3 grid gap-3 sm:grid-cols-4">
          <label className="sm:col-span-2">
            <span className="label">ชื่อผู้ขาย</span>
            <input className="input w-full" required maxLength={100} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          </label>
          <label>
            <span className="label">โทร</span>
            <input className="input w-full" maxLength={30} value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} />
          </label>
          <label>
            <span className="label">Lead time (วัน)</span>
            <input className="input w-full text-right" type="number" min="0" max="60" step="1" value={edit.lead} onChange={(e) => setEdit({ ...edit, lead: e.target.value })} />
          </label>
          <div className="sm:col-span-3">
            <span className="label">วันที่มาส่ง (ใช้คิดรอบสั่ง)</span>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((d, i) => (
                <button key={d} type="button" aria-pressed={edit.days.includes(i)}
                  className={`h-10 w-10 rounded-xl border text-sm ${edit.days.includes(i) ? 'border-charcoal bg-charcoal text-white' : 'bg-white text-gray-600'}`}
                  onClick={() => setEdit({ ...edit, days: edit.days.includes(i) ? edit.days.filter((x) => x !== i) : [...edit.days, i].sort() })}>
                  {d}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-end justify-end gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => setEdit(null)}>ยกเลิก</button>
            <button className="btn btn-primary">บันทึก</button>
          </div>
        </form>
      )}
    </section>
  )
}

function UnitsSection({ restaurantId, canWrite, notify }: { restaurantId: string; canWrite: boolean; notify: (ok: boolean, text: string) => void }) {
  const units = useUnits(restaurantId)
  const [name, setName] = useState('')
  async function add(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    const { error } = await supabase.from('units').insert({ restaurant_id: restaurantId, name: name.trim(), sort_order: 50 })
    if (error) return notify(false, error.code === '23505' ? `มีหน่วย "${name}" อยู่แล้ว` : error.message)
    setName('')
    void units.reload()
  }
  async function remove(id: string) {
    const { error } = await supabase.from('units').delete().eq('id', id)
    if (error) notify(false, error.message)
    else void units.reload()
  }
  return (
    <section className="mt-8">
      <h2 className="section-title">หน่วยนับของร้าน</h2>
      <p className="mb-2 text-sm text-gray-500">ใช้เป็นหน่วยซื้อ/หน่วยแปลงตอนรับของ (เช่น ลัง เข่ง) · สต็อกและสูตรเก็บเป็นหน่วยฐาน g / ml / pcs เสมอ</p>
      <div className="card">
        <div className="flex flex-wrap gap-1.5">
          {units.rows.map((u) => (
            <span key={u.id} className="inline-flex items-center gap-1 rounded-full border bg-white py-1 pr-1.5 pl-3 text-sm">
              {u.name}
              {canWrite && <button className="grid h-5 w-5 place-items-center rounded-full text-gray-400 hover:bg-gray-100" aria-label={`ลบหน่วย ${u.name}`} onClick={() => void remove(u.id)}>×</button>}
            </span>
          ))}
        </div>
        {canWrite && (
          <form onSubmit={add} className="mt-3 flex gap-2">
            <input className="input w-40" maxLength={30} placeholder="หน่วยใหม่ เช่น เข่ง" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn btn-secondary">เพิ่มหน่วย</button>
          </form>
        )}
      </div>
    </section>
  )
}

// เกณฑ์ตรวจรับของ (เจ้าของ): รับจริงห่างจากบิลเกิน ± % = ขาด/เกิน · น้ำแข็งเคลือบสูงสุด
function ReceiveSettings({ restaurantId, notify }: { restaurantId: string; notify: (ok: boolean, text: string) => void }) {
  const [v, setV] = useState({ tolerance: '2', glaze: '12' })
  useLoad(async () => {
    const { data } = await supabase.from('shop_settings').select('receive_tolerance_pct,glaze_max_pct').eq('restaurant_id', restaurantId).maybeSingle()
    if (data) setV({ tolerance: String(Number(data.receive_tolerance_pct)), glaze: String(Number(data.glaze_max_pct)) })
    return null
  }, [restaurantId])
  async function save(e: FormEvent) {
    e.preventDefault()
    const tolerance = Number(v.tolerance)
    const glaze = Number(v.glaze)
    if (!(tolerance >= 0 && tolerance <= 50) || !(glaze >= 0 && glaze <= 60)) return notify(false, 'เกณฑ์รับของ 0-50% และน้ำแข็ง 0-60%')
    const { error } = await supabase
      .from('shop_settings')
      .upsert({ restaurant_id: restaurantId, receive_tolerance_pct: tolerance, glaze_max_pct: glaze }, { onConflict: 'restaurant_id' })
    notify(!error, error ? error.message : 'บันทึกเกณฑ์ตรวจรับของแล้ว')
  }
  return (
    <section className="mt-8">
      <h2 className="section-title">เกณฑ์ตรวจรับของ</h2>
      <form onSubmit={save} className="card flex flex-wrap items-end gap-3">
        <label>
          <span className="label">รับจริงห่างจากบิลเกิน ± (%) = ขาด/เกิน</span>
          <input className="input w-28" type="number" min="0" max="50" step="any" value={v.tolerance} onChange={(e) => setV({ ...v, tolerance: e.target.value })} />
        </label>
        <label>
          <span className="label">น้ำแข็งเคลือบสูงสุด (%)</span>
          <input className="input w-28" type="number" min="0" max="60" step="any" value={v.glaze} onChange={(e) => setV({ ...v, glaze: e.target.value })} />
        </label>
        <button className="btn btn-secondary">บันทึกเกณฑ์</button>
      </form>
    </section>
  )
}

function Board({ restaurantId, roles }: { restaurantId: string; roles: Role[] }) {
  const canWrite = roles.some((r) => ['owner', 'manager', 'stock'].includes(r))
  const data = useLoad(async () => {
    const [i, s, r] = await Promise.all([stockApi.ingredients(restaurantId, true), stockApi.suppliers(restaurantId), stockApi.recipes(restaurantId)])
    return { ingredients: i.ingredients, suppliers: s.suppliers, recipes: r.recipes, menus: r.menus }
  }, [restaurantId])
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const notify = (ok: boolean, text: string) => setMsg({ ok, text })
  const reload = () => void data.reload()
  const active = useMemo(() => (data.data?.ingredients ?? []).filter((i) => i.is_active), [data.data])

  async function toggleMenu(id: string, available: boolean) {
    const { error } = await supabase.rpc('set_menu_availability', { p_item_id: id, p_available: available })
    if (error) notify(false, error.message)
    else reload()
  }

  return (
    <div className="page">
      <PageHead title="ตั้งค่าสต็อก" subtitle="วัตถุดิบ ผู้ขาย สูตร หน่วย · ยอดคงเหลือแก้ที่นี่ไม่ได้ (มาจากรับเข้า ตัดตามสูตร และการนับ)" />
      <StockNav roles={roles} />
      {msg && <p className={msg.ok ? 'alert-success' : 'alert-error'}>{msg.text}</p>}
      {data.error && <p className="alert-error">{data.error}</p>}
      {data.data && (
        <>
          <IngredientsSection restaurantId={restaurantId} canWrite={canWrite} suppliers={data.data.suppliers} ingredients={data.data.ingredients} reload={reload} notify={notify} />
          <SuppliersSection restaurantId={restaurantId} canWrite={canWrite} suppliers={data.data.suppliers} reload={reload} notify={notify} />
          <section className="mt-8">
            <h2 className="section-title">สูตร</h2>
            <p className="mb-3 text-sm text-gray-500">
              ตัดสต็อกเมื่อครัวกด "เริ่มทำ" ตามสูตร (แตกสูตรย่อยถึงวัตถุดิบดิบ) · ยกเลิกออเดอร์ = คืนสต็อกอัตโนมัติ · ของไม่พอ ระบบปิดเมนูให้เอง
            </p>
            <RecipeEditor restaurantId={restaurantId} recipes={data.data.recipes} menus={data.data.menus} ingredients={active} canWrite={canWrite}
              onSaved={(text) => { notify(true, text); reload() }} />
          </section>
          <section className="mt-8">
            <h2 className="section-title">เปิด/ปิดเมนูเอง</h2>
            <ul className="card-flush divide-y text-sm">
              {data.data.menus.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2 p-3">
                  <span className={m.is_available ? '' : 'text-gray-400 line-through'}>{m.name}</span>
                  {m.stock_disabled && <span className="badge badge-red ml-auto">ระบบปิด: ของไม่พอ</span>}
                  <button className={`btn btn-sm ${m.is_available ? 'btn-secondary' : 'bg-gray-200 text-gray-600'}`} onClick={() => void toggleMenu(m.id, !m.is_available)}>
                    {m.is_available ? 'ตั้งเป็นหมด' : 'เปิดขาย'}
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <UnitsSection restaurantId={restaurantId} canWrite={canWrite} notify={notify} />
          {roles.includes('owner') && <ReceiveSettings restaurantId={restaurantId} notify={notify} />}
        </>
      )}
    </div>
  )
}

export default function StockSetup() {
  return <RequireRole roles={rolesFor('/stock-setup')}>{(ctx) => <Board restaurantId={ctx.restaurantId} roles={ctx.roles} />}</RequireRole>
}
