// แก้สูตร (สูตรเมนู + สูตรย่อย/สูตรซ้อน) · บันทึกทั้งสูตรในธุรกรรมเดียว (stock_save_recipe ใน 0029)
// ปริมาณในสูตร = สุทธิที่ใช้จริง · ระบบตัดดิบ = สุทธิ ÷ (trim x cook) · ต้นทุน = ราคาซื้อล่าสุด ÷ (trim x cook)
import { useMemo, useState, type FormEvent } from 'react'
import { baht } from '../../lib/format'
import { errorText, stockApi, type Recipe, type StockIngredient, type StockMenu } from '../../lib/stockApi'
import { fmtNum, rawQty, yieldUnitCost } from '../../lib/stockMath'

interface Draft {
  id: string | null
  name: string
  menu_item_id: string
  output_qty: string
  output_unit: string
  lines: { key: number; ref: string; qty: string }[] // ref = "i:<ingredient>" | "r:<sub recipe>"
}
let seq = 1
const toDraft = (r: Recipe | null, menuId = ''): Draft => ({
  id: r?.id ?? null,
  name: r?.name ?? '',
  menu_item_id: r?.menu_item_id ?? menuId,
  output_qty: String(r?.output_qty ?? 1),
  output_unit: r?.output_unit ?? 'จาน',
  lines: (r?.recipe_lines ?? []).map((l) => ({ key: seq++, ref: l.ingredient_id ? `i:${l.ingredient_id}` : `r:${l.sub_recipe_id}`, qty: String(l.qty) })),
})

export default function RecipeEditor({
  restaurantId,
  recipes,
  menus,
  ingredients,
  canWrite,
  onSaved,
}: {
  restaurantId: string
  recipes: Recipe[]
  menus: StockMenu[]
  ingredients: StockIngredient[]
  canWrite: boolean
  onSaved: (msg: string) => void
}) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const ing = useMemo(() => new Map(ingredients.map((i) => [i.id, i])), [ingredients])
  const rec = useMemo(() => new Map(recipes.map((r) => [r.id, r])), [recipes])
  const subs = recipes.filter((r) => !r.menu_item_id)
  const menuName = new Map(menus.map((m) => [m.id, m]))

  // ต้นทุนตัวอย่างก่อนบันทึก (ฐานข้อมูลคำนวณจริงอีกครั้ง)
  const preview = useMemo(() => {
    if (!draft) return null
    const total = draft.lines.reduce((s, l) => {
      const q = Number(l.qty) || 0
      if (l.ref.startsWith('i:')) {
        const i = ing.get(l.ref.slice(2))
        return i ? s + q * yieldUnitCost(Number(i.last_unit_cost ?? i.cost_per_unit), Number(i.trim_yield_pct), Number(i.cook_yield_pct)) : s
      }
      const r = rec.get(l.ref.slice(2))
      return r ? s + q * Number(r.cost_per_output) : s
    }, 0)
    return { total, per: total / (Number(draft.output_qty) || 1) }
  }, [draft, ing, rec])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!draft) return
    const lines = draft.lines.filter((l) => l.ref)
    if (lines.some((l) => !(Number(l.qty) > 0))) return setError('ปริมาณทุกบรรทัดต้องมากกว่า 0')
    if (new Set(lines.map((l) => l.ref)).size !== lines.length) return setError('มีวัตถุดิบ/สูตรย่อยซ้ำในสูตรเดียวกัน')
    setSaving(true)
    try {
      await stockApi.saveRecipe(restaurantId, draft.id, {
        name: draft.name,
        menu_item_id: draft.menu_item_id || null,
        output_qty: Number(draft.output_qty),
        output_unit: draft.output_unit,
        lines: lines.map((l) => (l.ref.startsWith('i:') ? { ingredient_id: l.ref.slice(2), qty: Number(l.qty) } : { sub_recipe_id: l.ref.slice(2), qty: Number(l.qty) })),
      })
      setError(null)
      setDraft(null)
      onSaved(`บันทึกสูตร ${draft.name} แล้ว (ต้นทุนสูตรนี้และสูตรที่ใช้เป็นสูตรย่อยคำนวณใหม่)`)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  async function remove(r: Recipe) {
    if (!window.confirm(`ลบสูตร ${r.name}?`)) return
    try {
      await stockApi.deleteRecipe(restaurantId, r.id)
      onSaved(`ลบสูตร ${r.name} แล้ว`)
    } catch (err) {
      setError(errorText(err))
    }
  }

  const row = (r: Recipe) => (
    <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-sm">
      <span className="min-w-48 flex-1">
        <span className="font-medium text-gray-900">{r.name}</span>
        {r.menu_item_id && menuName.get(r.menu_item_id)?.stock_disabled && <span className="badge badge-red ml-2">ระบบปิดเมนู: ของไม่พอ</span>}
        <span className="block text-xs text-gray-500">
          ได้ {fmtNum(Number(r.output_qty))} {r.output_unit} · {r.recipe_lines.length} บรรทัด
          {r.recipe_lines.some((l) => l.sub_recipe_id) && ' · มีสูตรย่อย'}
        </span>
      </span>
      <span className="tabular-nums text-gray-700">{baht(Number(r.cost_per_output))} / {r.output_unit}</span>
      {canWrite && (
        <span className="flex gap-3">
          <button className="link-muted" onClick={() => setDraft(toDraft(r))}>แก้ไข</button>
          <button className="link-danger" onClick={() => void remove(r)}>ลบ</button>
        </span>
      )}
    </li>
  )

  const noRecipe = menus.filter((m) => !m.recipe_id)
  return (
    <div className="space-y-4">
      {error && !draft && <p className="alert-error">{error}</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700">สูตรเมนู</h3>
            {canWrite && noRecipe.length > 0 && (
              <select className="input py-1.5 text-sm" value="" onChange={(e) => {
                const m = menuName.get(e.target.value)
                if (m) setDraft({ ...toDraft(null, m.id), name: m.name })
              }}>
                <option value="">+ เพิ่มสูตรให้เมนู...</option>
                {noRecipe.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            )}
          </div>
          <ul className="card-flush divide-y">{recipes.filter((r) => r.menu_item_id).map(row)}</ul>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700">สูตรย่อย (เช่น น้ำจิ้ม ซอส)</h3>
            {canWrite && <button className="btn btn-secondary btn-sm" onClick={() => setDraft({ ...toDraft(null), output_qty: '1000', output_unit: 'g' })}>+ สูตรย่อย</button>}
          </div>
          {subs.length === 0 ? <p className="empty">ยังไม่มีสูตรย่อย</p> : <ul className="card-flush divide-y">{subs.map(row)}</ul>}
        </div>
      </div>

      {draft && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-gray-900/40 p-4" onClick={() => setDraft(null)}>
          <form onSubmit={save} className="card max-h-[90vh] w-full max-w-2xl space-y-3 overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}
            role="dialog" aria-modal="true" aria-label="แก้สูตร">
            <h2 className="text-lg font-bold text-gray-900">{draft.id ? `แก้สูตร ${draft.name}` : draft.menu_item_id ? 'สูตรเมนู' : 'สูตรย่อยใหม่'}</h2>
            {error && <p className="alert-error">{error}</p>}
            <div className="grid gap-3 sm:grid-cols-4">
              <label className="sm:col-span-2">
                <span className="label">ชื่อสูตร</span>
                <input className="input w-full" maxLength={100} required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </label>
              <label>
                <span className="label">ทำ 1 ครั้งได้</span>
                <input className="input w-full text-right" type="number" min="0" step="any" required value={draft.output_qty} onChange={(e) => setDraft({ ...draft, output_qty: e.target.value })} />
              </label>
              <label>
                <span className="label">หน่วยที่ได้</span>
                <input className="input w-full" maxLength={20} required value={draft.output_unit} onChange={(e) => setDraft({ ...draft, output_unit: e.target.value })} />
              </label>
            </div>
            {draft.menu_item_id && <p className="text-xs text-gray-500">ผูกกับเมนู {menuName.get(draft.menu_item_id)?.name} · ขาย 1 ที่ = ใช้ 1 {draft.output_unit}</p>}

            <div className="space-y-2">
              <span className="label">ส่วนผสม (ปริมาณสุทธิที่ใช้จริง)</span>
              {draft.lines.map((l) => {
                const i = l.ref.startsWith('i:') ? ing.get(l.ref.slice(2)) : undefined
                const s = l.ref.startsWith('r:') ? rec.get(l.ref.slice(2)) : undefined
                const unit = i?.unit ?? s?.output_unit ?? ''
                const raw = i && Number(l.qty) > 0 ? rawQty(Number(l.qty), Number(i.trim_yield_pct), Number(i.cook_yield_pct)) : null
                return (
                  <div key={l.key} className="flex flex-wrap items-center gap-2 text-sm">
                    <select className="input min-w-48 flex-1 py-1.5" value={l.ref}
                      onChange={(e) => setDraft({ ...draft, lines: draft.lines.map((x) => (x.key === l.key ? { ...x, ref: e.target.value } : x)) })}>
                      <option value="">เลือก...</option>
                      <optgroup label="วัตถุดิบ">
                        {ingredients.map((x) => <option key={x.id} value={`i:${x.id}`}>{x.name}</option>)}
                      </optgroup>
                      {subs.some((x) => x.id !== draft.id) && (
                        <optgroup label="สูตรย่อย">
                          {subs.filter((x) => x.id !== draft.id).map((x) => <option key={x.id} value={`r:${x.id}`}>{x.name}</option>)}
                        </optgroup>
                      )}
                    </select>
                    <input className="input w-24 py-1.5 text-right" type="number" min="0" step="any" inputMode="decimal" value={l.qty}
                      onChange={(e) => setDraft({ ...draft, lines: draft.lines.map((x) => (x.key === l.key ? { ...x, qty: e.target.value } : x)) })} aria-label="ปริมาณสุทธิ" />
                    <span className="w-14 text-gray-500">{unit}</span>
                    {raw !== null && raw !== Number(l.qty) && <span className="text-xs text-gray-500">ตัดดิบ {fmtNum(raw)} {unit}</span>}
                    <button type="button" className="link-danger ml-auto" onClick={() => setDraft({ ...draft, lines: draft.lines.filter((x) => x.key !== l.key) })}>ลบ</button>
                  </div>
                )
              })}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraft({ ...draft, lines: [...draft.lines, { key: seq++, ref: '', qty: '' }] })}>+ เพิ่มส่วนผสม</button>
            </div>
            {preview && (
              <p className="rounded-xl bg-gray-50 px-3 py-2 text-sm">
                ต้นทุนรวม {baht(preview.total)} · ต่อ 1 {draft.output_unit} <strong>{baht(preview.per)}</strong>
                <span className="block text-xs text-gray-500">คิดจากราคาซื้อล่าสุด ÷ (trim yield × cook yield) รวมสูตรย่อย</span>
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className="btn btn-secondary" onClick={() => setDraft(null)}>ยกเลิก</button>
              <button className="btn btn-primary" disabled={saving}>{saving ? 'กำลังบันทึก...' : 'บันทึกสูตร'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
