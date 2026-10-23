import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { rolesFor } from '../lib/roles'
import RequireRole from '../components/RequireRole'
import RecipeEditor from '../components/RecipeEditor'
import type { Ingredient } from '../lib/types'

interface MenuRow {
  id: string
  name: string
  is_available: boolean
}

function Board({ restaurantId }: { restaurantId: string }) {
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [menu, setMenu] = useState<MenuRow[]>([])
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', unit: '', reorder: '', cost: '' })

  const load = useCallback(async () => {
    const [ing, mi] = await Promise.all([
      supabase
        .from('ingredients')
        .select('id,name,unit,quantity_on_hand,reorder_level,cost_per_unit')
        .eq('restaurant_id', restaurantId)
        .order('name'),
      supabase.from('menu_items').select('id,name,is_available').eq('restaurant_id', restaurantId).order('name'),
    ])
    if (ing.error || mi.error) {
      setError('โหลดข้อมูลสต็อกไม่สำเร็จ')
      return
    }
    setIngredients((ing.data ?? []) as Ingredient[])
    setMenu((mi.data ?? []) as MenuRow[])
  }, [restaurantId])

  useEffect(() => {
    void load()
  }, [load])

  async function move(ing: Ingredient, sign: 1 | -1, reason: 'purchase' | 'waste') {
    const amt = Number(amounts[ing.id])
    if (!(amt > 0)) {
      setError('กรอกจำนวนที่มากกว่า 0')
      return
    }
    const { error: err } = await supabase.from('stock_movements').insert({
      restaurant_id: restaurantId,
      ingredient_id: ing.id,
      change: sign * amt,
      reason,
    })
    if (err) {
      setError(
        err.message.includes('quantity_on_hand') || err.message.includes('check')
          ? 'สต็อกไม่พอสำหรับตัดจำนวนนี้'
          : err.message,
      )
      return
    }
    setError(null)
    setAmounts((prev) => ({ ...prev, [ing.id]: '' }))
    void load()
  }

  async function addIngredient(e: FormEvent) {
    e.preventDefault()
    const { error: err } = await supabase.from('ingredients').insert({
      restaurant_id: restaurantId,
      name: form.name.trim(),
      unit: form.unit.trim(),
      reorder_level: Number(form.reorder) || 0,
      cost_per_unit: Number(form.cost) || 0,
    })
    if (err) {
      setError(err.message)
      return
    }
    setError(null)
    setForm({ name: '', unit: '', reorder: '', cost: '' })
    void load()
  }

  async function toggleMenu(m: MenuRow) {
    const { error: err } = await supabase.rpc('set_menu_availability', {
      p_item_id: m.id,
      p_available: !m.is_available,
    })
    if (err) setError(err.message)
    else void load()
  }

  return (
    <div className="page-narrow">
      <h1 className="page-title mb-5">สต็อก</h1>
      {error && <p className="alert-error">{error}</p>}

      <section>
        <h2 className="section-title">วัตถุดิบ</h2>
        <ul className="card-flush divide-y">
          {ingredients.map((ing) => {
            const low = ing.reorder_level > 0 && ing.quantity_on_hand <= ing.reorder_level
            return (
              <li key={ing.id} className="flex flex-wrap items-center gap-2 p-3">
                <div className="min-w-32 flex-1">
                  <div className="font-medium">{ing.name}</div>
                  <div className="text-sm text-gray-500">
                    คงเหลือ {ing.quantity_on_hand} {ing.unit}
                    {low && <span className="badge badge-red ml-2">ใกล้หมด</span>}
                  </div>
                </div>
                <input
                  className="input w-24 py-1.5"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="จำนวน"
                  value={amounts[ing.id] ?? ''}
                  onChange={(e) => setAmounts((prev) => ({ ...prev, [ing.id]: e.target.value }))}
                />
                <button className="btn btn-success btn-sm" onClick={() => void move(ing, 1, 'purchase')}>
                  รับเข้า
                </button>
                <button className="btn btn-secondary btn-sm border-red-200 text-red-600 hover:bg-red-50" onClick={() => void move(ing, -1, 'waste')}>
                  ของเสีย
                </button>
              </li>
            )
          })}
          {ingredients.length === 0 && <li className="p-6 text-center text-gray-400">ยังไม่มีวัตถุดิบ เพิ่มด้านล่างได้เลย</li>}
        </ul>
      </section>

      <section className="mt-6">
        <h2 className="section-title">เพิ่มวัตถุดิบ</h2>
        <form onSubmit={addIngredient} className="grid gap-2 sm:grid-cols-2">
          <input className="input" placeholder="ชื่อ เช่น หมูสับ" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <input className="input" placeholder="หน่วย เช่น g, ml, ชิ้น" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} required />
          <input className="input" type="number" min="0" step="any" placeholder="ระดับแจ้งเตือนใกล้หมด" value={form.reorder} onChange={(e) => setForm({ ...form, reorder: e.target.value })} />
          <input className="input" type="number" min="0" step="any" placeholder="ต้นทุนต่อหน่วย (บาท)" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} />
          <button className="btn btn-primary sm:col-span-2">เพิ่มวัตถุดิบ</button>
        </form>
      </section>

      <section className="mt-6">
        <h2 className="section-title">สูตรอาหาร</h2>
        <p className="mb-2 text-sm text-gray-500">
          กำหนดวัตถุดิบต่อ 1 จาน ระบบจะตัดสต็อกให้อัตโนมัติเมื่อครัวเริ่มทำออเดอร์ และใช้คำนวณต้นทุนต่อเมนู
        </p>
        <RecipeEditor menu={menu} ingredients={ingredients} onError={setError} />
      </section>

      <section className="mt-6">
        <h2 className="section-title">เมนูที่หมด</h2>
        <p className="mb-2 text-sm text-gray-500">กดเพื่อสลับสถานะ เมนูที่หมดลูกค้าจะสั่งไม่ได้</p>
        <ul className="card-flush divide-y">
          {menu.map((m) => (
            <li key={m.id} className="flex items-center justify-between p-3">
              <span className={m.is_available ? '' : 'text-gray-400 line-through'}>{m.name}</span>
              <button
                className={`btn btn-sm ${m.is_available ? 'btn-secondary' : 'bg-gray-200 text-gray-600'}`}
                onClick={() => void toggleMenu(m)}
              >
                {m.is_available ? 'ตั้งเป็นหมด' : 'เปิดขายอีกครั้ง'}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

export default function Stock() {
  return <RequireRole roles={rolesFor('/stock')}>{(ctx) => <Board restaurantId={ctx.restaurantId} />}</RequireRole>
}
