import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { rolesFor, type Role } from '../lib/roles'
import { baht } from '../lib/format'
import RequireRole from '../components/RequireRole'
import type { MenuCost } from '../lib/types'

type Category = 'ingredients' | 'labor' | 'rent' | 'utilities' | 'other'

const CATEGORY_LABEL: Record<Category, string> = {
  ingredients: 'วัตถุดิบ',
  labor: 'ค่าแรง',
  rent: 'ค่าเช่า',
  utilities: 'ค่าน้ำไฟ',
  other: 'อื่นๆ',
}

const RANGES = [
  { days: 1, label: 'วันนี้' },
  { days: 7, label: '7 วัน' },
  { days: 30, label: '30 วัน' },
]

// เกณฑ์ตัวอย่างสำหรับไฮไลต์เมนูที่ต้นทุนวัตถุดิบสูง ปรับตามประเภทร้านได้
const FOOD_COST_WARN_PERCENT = 40

interface Summary {
  from_date: string
  to_date: string
  revenue_total: number
  paid_orders: number
  expense_total: number
  expenses_by_category: Record<string, number>
  discount_total: number
}

const EXPENSE_LIST_LIMIT = 100

interface Expense {
  id: string
  category: Category
  amount: number
  spent_on: string
  note: string | null
}

const ymd = (d: Date) => d.toLocaleDateString('sv-SE') // yyyy-mm-dd ตามเวลาท้องถิ่น

// ผู้จัดการดูได้อย่างเดียว (0016): ไม่เห็นฟอร์มบันทึกรายจ่าย ฐานข้อมูลก็ไม่ให้บันทึก
function Board({ restaurantId, myRole }: { restaurantId: string; myRole: Role }) {
  const canWrite = myRole === 'owner' || myRole === 'accountant'
  const [days, setDays] = useState(1)
  const [revenue, setRevenue] = useState(0)
  const [totalExpense, setTotalExpense] = useState(0)
  const [byCategory, setByCategory] = useState<Partial<Record<Category, number>>>({})
  const [period, setPeriod] = useState('')
  const [discount, setDiscount] = useState(0)
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [costs, setCosts] = useState<MenuCost[]>([])
  const [error, setError] = useState<string | null>(null)

  const [category, setCategory] = useState<Category>('ingredients')
  const [amount, setAmount] = useState('')
  const [spentOn, setSpentOn] = useState(() => ymd(new Date()))
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    // ยอดรวมคำนวณในฐานข้อมูลตามเขตเวลาของร้าน (ไม่ติดขีด 1,000 แถวของ Supabase)
    const [sm, e, c] = await Promise.all([
      supabase.rpc('accounting_summary', { p_restaurant_id: restaurantId, p_days: days }),
      supabase
        .from('expenses')
        .select('id,category,amount,spent_on,note')
        .eq('restaurant_id', restaurantId)
        .order('spent_on', { ascending: false })
        .limit(EXPENSE_LIST_LIMIT),
      supabase
        .from('menu_item_costs')
        .select('menu_item_id,name,price,unit_cost,ingredient_count')
        .eq('restaurant_id', restaurantId)
        .order('name'),
    ])
    const summary = (sm.data as Summary[] | null)?.[0]
    if (sm.error || e.error || c.error || !summary) {
      setError('โหลดข้อมูลบัญชีไม่สำเร็จ (ต้องเป็นเจ้าของร้านหรือพนักงานบัญชี และรัน migration 0006 แล้ว)')
      return
    }
    setError(null)
    setRevenue(Number(summary.revenue_total))
    setTotalExpense(Number(summary.expense_total))
    setDiscount(Number(summary.discount_total ?? 0))
    setByCategory(
      Object.fromEntries(Object.entries(summary.expenses_by_category).map(([k, v]) => [k, Number(v)])) as Partial<Record<Category, number>>,
    )
    setPeriod(summary.from_date === summary.to_date ? summary.to_date : `${summary.from_date} ถึง ${summary.to_date}`)
    setExpenses((e.data ?? []) as Expense[])
    setCosts(
      ((c.data ?? []) as MenuCost[]).map((x) => ({
        ...x,
        price: Number(x.price),
        unit_cost: Number(x.unit_cost),
        ingredient_count: Number(x.ingredient_count),
      })),
    )
  }, [restaurantId, days])

  useEffect(() => {
    void load()
  }, [load])

  const profit = revenue - totalExpense

  const withRecipe = useMemo(
    () => costs.filter((x) => x.ingredient_count > 0).sort((a, b) => b.price - b.unit_cost - (a.price - a.unit_cost)),
    [costs],
  )
  const withoutRecipe = costs.filter((x) => x.ingredient_count === 0)

  async function addExpense(e: FormEvent) {
    e.preventDefault()
    const value = Number(amount)
    if (!(value > 0)) {
      setError('กรอกจำนวนเงินที่มากกว่า 0')
      return
    }
    const { error: err } = await supabase.from('expenses').insert({
      restaurant_id: restaurantId,
      category,
      amount: value,
      spent_on: spentOn,
      note: note.trim() || null,
    })
    if (err) {
      setError(err.message)
      return
    }
    setAmount('')
    setNote('')
    void load()
  }

  return (
    <div className="page-narrow">
      <h1 className="page-title mb-5">บัญชี</h1>

      <div className="mb-4 flex gap-2">
        {RANGES.map((r) => (
          <button
            key={r.days}
            onClick={() => setDays(r.days)}
            className={`rounded-full border px-3.5 py-1.5 text-sm transition ${days === r.days ? 'border-gray-900 bg-gray-900 text-white' : 'bg-white text-gray-600 hover:border-gray-300'}`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {error && <p className="alert-error">{error}</p>}
      {period && <p className="mb-3 text-xs text-gray-500">ช่วงวันที่ {period} (ตามเขตเวลาของร้าน)</p>}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="card">
          <div className="stat-label">รายรับ (ชำระแล้ว)</div>
          <div className="stat-value text-emerald-600">{baht(revenue)}</div>
        </div>
        <div className="card">
          <div className="stat-label">รายจ่าย</div>
          <div className="stat-value text-red-600">{baht(totalExpense)}</div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500">กำไร-ขาดทุน</div>
          <div className={`stat-value ${profit < 0 ? 'text-red-600' : ''}`}>{baht(profit)}</div>
        </div>
      </div>

      {discount > 0 && (
        <p className="mt-2 text-sm text-gray-600">
          รายรับข้างต้นเป็นยอดหลังหักส่วนลดโปรโมชันแล้ว · ส่วนลดที่ให้ลูกค้าในช่วงนี้ {baht(discount)}
        </p>
      )}

      <section className="mt-6">
        <h2 className="section-title">รายจ่ายแยกหมวด</h2>
        <ul className="space-y-1 text-sm">
          {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
            <li key={c} className="flex justify-between">
              <span>{CATEGORY_LABEL[c]}</span>
              <span>{baht(byCategory[c] ?? 0)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6">
        <h2 className="mb-1 font-semibold text-gray-900">ต้นทุนและกำไรต่อเมนู</h2>
        <p className="mb-3 text-xs text-gray-500">
          คำนวณจากสูตรอาหารและต้นทุนวัตถุดิบต่อหน่วย (ยังไม่รวมค่าแรง ค่าเช่า ค่าน้ำไฟ) แถบสีแดง = ต้นทุนวัตถุดิบเกิน{' '}
          {FOOD_COST_WARN_PERCENT}% ของราคาขาย (เกณฑ์ตัวอย่าง)
        </p>
        <div className="card-flush overflow-x-auto">
          <table className="w-full text-left text-sm [&_td]:px-3 [&_td]:py-2.5 [&_th]:px-3 [&_th]:py-2.5 [&_tbody_tr:hover]:bg-gray-50">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="p-2">เมนู</th>
                <th className="p-2 text-right">ราคาขาย</th>
                <th className="p-2 text-right">ต้นทุน</th>
                <th className="p-2 text-right">กำไร/จาน</th>
                <th className="p-2 text-right">ต้นทุน %</th>
              </tr>
            </thead>
            <tbody>
              {withRecipe.map((x) => {
                const percent = x.price > 0 ? (x.unit_cost / x.price) * 100 : 0
                return (
                  <tr key={x.menu_item_id} className="border-t">
                    <td className="p-2">{x.name}</td>
                    <td className="p-2 text-right">{baht(x.price)}</td>
                    <td className="p-2 text-right">{baht(x.unit_cost)}</td>
                    <td className="p-2 text-right">{baht(x.price - x.unit_cost)}</td>
                    <td className={`p-2 text-right ${percent > FOOD_COST_WARN_PERCENT ? 'font-semibold text-red-600' : ''}`}>
                      {percent.toFixed(0)}%
                    </td>
                  </tr>
                )
              })}
              {withRecipe.length === 0 && (
                <tr>
                  <td className="p-6 text-center text-gray-400" colSpan={5}>
                    ยังไม่มีเมนูที่ใส่สูตรอาหาร ให้พนักงานสต็อกหรือเจ้าของเพิ่มสูตรที่หน้าสต็อก
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {withoutRecipe.length > 0 && (
          <p className="mt-2 text-xs text-gray-500">ยังไม่มีสูตร: {withoutRecipe.map((x) => x.name).join(', ')}</p>
        )}
      </section>

      {canWrite ? (
        <section className="mt-6">
          <h2 className="section-title">บันทึกรายจ่าย</h2>
          <form onSubmit={addExpense} className="grid gap-2 sm:grid-cols-2">
            <select className="input" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
              {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
            <input
              className="input"
              type="number"
              min="0"
              step="0.01"
              placeholder="จำนวนเงิน (บาท)"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
            <input className="input" type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)} required />
            <input className="input" placeholder="หมายเหตุ (ไม่บังคับ)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="btn btn-primary sm:col-span-2">บันทึก</button>
          </form>
        </section>
      ) : (
        <p className="note mt-6">ผู้จัดการดูบัญชีได้อย่างเดียว · บันทึกรายจ่ายได้เฉพาะเจ้าของร้านและพนักงานบัญชี</p>
      )}

      <section className="mt-6">
        <h2 className="section-title">รายการรายจ่ายล่าสุด ({EXPENSE_LIST_LIMIT} รายการ)</h2>
        <ul className="card-flush divide-y text-sm">
          {expenses.map((x) => (
            <li key={x.id} className="flex justify-between gap-3 p-3">
              <span>
                {x.spent_on} · {CATEGORY_LABEL[x.category]}
                {x.note && <span className="text-gray-500"> · {x.note}</span>}
              </span>
              <span>{baht(Number(x.amount))}</span>
            </li>
          ))}
          {expenses.length === 0 && <li className="p-6 text-center text-gray-400">ยังไม่มีรายจ่ายในช่วงนี้</li>}
        </ul>
      </section>
    </div>
  )
}

export default function Accounting() {
  return <RequireRole roles={rolesFor('/accounting')}>{(ctx) => <Board restaurantId={ctx.restaurantId} myRole={ctx.role} />}</RequireRole>
}
