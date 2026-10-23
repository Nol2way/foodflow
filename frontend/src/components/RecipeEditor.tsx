import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { baht } from '../lib/format'
import type { Ingredient } from '../lib/types'

interface Line {
  ingredient_id: string
  quantity_used: number
}

// แก้สูตรอาหารรายเมนู: วัตถุดิบและปริมาณที่ใช้ต่อ 1 จาน
export default function RecipeEditor({
  menu,
  ingredients,
  onError,
}: {
  menu: { id: string; name: string }[]
  ingredients: Ingredient[]
  onError: (message: string | null) => void
}) {
  const [menuId, setMenuId] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [ingredientId, setIngredientId] = useState('')
  const [amount, setAmount] = useState('')

  const byId = useMemo(() => new Map(ingredients.map((i) => [i.id, i])), [ingredients])

  const load = useCallback(async () => {
    if (!menuId) {
      setLines([])
      return
    }
    const { data, error } = await supabase
      .from('recipes')
      .select('ingredient_id,quantity_used')
      .eq('menu_item_id', menuId)
    if (error) onError('โหลดสูตรอาหารไม่สำเร็จ')
    else setLines((data ?? []) as Line[])
  }, [menuId, onError])

  useEffect(() => {
    void load()
  }, [load])

  async function save(e: FormEvent) {
    e.preventDefault()
    const value = Number(amount)
    if (!menuId || !ingredientId || !(value > 0)) {
      onError('เลือกเมนู วัตถุดิบ และกรอกปริมาณที่มากกว่า 0')
      return
    }
    const { error } = await supabase
      .from('recipes')
      .upsert({ menu_item_id: menuId, ingredient_id: ingredientId, quantity_used: value }, { onConflict: 'menu_item_id,ingredient_id' })
    if (error) {
      onError(error.message)
      return
    }
    onError(null)
    setAmount('')
    void load()
  }

  async function remove(id: string) {
    const { error } = await supabase.from('recipes').delete().eq('menu_item_id', menuId).eq('ingredient_id', id)
    if (error) onError(error.message)
    else void load()
  }

  const totalCost = lines.reduce((sum, l) => sum + l.quantity_used * (byId.get(l.ingredient_id)?.cost_per_unit ?? 0), 0)

  return (
    <div className="card">
      <select className="input w-full" value={menuId} onChange={(e) => setMenuId(e.target.value)}>
        <option value="">เลือกเมนู...</option>
        {menu.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>

      {menuId && (
        <>
          <ul className="mt-3 divide-y text-sm">
            {lines.map((l) => {
              const ing = byId.get(l.ingredient_id)
              return (
                <li key={l.ingredient_id} className="flex items-center justify-between gap-2 py-2">
                  <span>
                    {ing?.name ?? '(ไม่พบวัตถุดิบ)'} · {l.quantity_used} {ing?.unit}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-gray-500">{baht(l.quantity_used * (ing?.cost_per_unit ?? 0))}</span>
                    <button className="link-danger" onClick={() => void remove(l.ingredient_id)}>
                      ลบ
                    </button>
                  </span>
                </li>
              )
            })}
            {lines.length === 0 && <li className="py-2 text-gray-400">เมนูนี้ยังไม่มีสูตร (จะไม่ตัดสต็อกและไม่มีต้นทุน)</li>}
          </ul>
          {lines.length > 0 && (
            <div className="flex justify-between border-t pt-2 text-sm font-semibold">
              <span>ต้นทุนวัตถุดิบต่อจาน</span>
              <span>{baht(totalCost)}</span>
            </div>
          )}

          <form onSubmit={save} className="mt-3 grid gap-2 sm:grid-cols-3">
            <select className="input" value={ingredientId} onChange={(e) => setIngredientId(e.target.value)}>
              <option value="">วัตถุดิบ...</option>
              {ingredients.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} ({i.unit})
                </option>
              ))}
            </select>
            <input
              className="input"
              type="number"
              min="0"
              step="any"
              placeholder="ปริมาณต่อจาน"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <button className="btn btn-primary">เพิ่ม/แก้ไข</button>
          </form>
        </>
      )}
    </div>
  )
}
