// แดชบอร์ดบัญชี 3 โหมด จากข้อมูลชุดเดียวกัน (acct_dashboard)
//   ง่าย: เงินเข้า / เงินออก / คงเหลือ (มุมมองเงินสด ซื้อของ = รายจ่ายวันนั้น)
//   มาตรฐาน: ยอดขาย - ต้นทุนอาหารที่ใช้จริง - ค่าใช้จ่าย = กำไร · Food/Prime Cost · ส่วนต่างสต็อก · ต้นทุนต่อจาน
//   มืออาชีพ: งบกำไรขาดทุนย่อ + ตรวจ perpetual + กระทบยอดสต็อก (สมุดรายวัน/งบเต็มอยู่ที่แท็บรายงาน)
import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import {
  SOURCE_LABEL,
  cashView,
  changePct,
  metrics,
  stockCheck,
  vatThreshold,
  type AccountingMode,
  type Dashboard,
  type PeriodKey,
} from '../../lib/accounting'
import { baht } from '../../lib/format'
import { AmountTable, CostBar, Money, Section, Stat } from './ui'

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'today', label: 'วันนี้' },
  { key: 'd7', label: '7 วัน' },
  { key: 'd30', label: '30 วัน' },
  { key: 'month', label: 'เดือนนี้' },
]

interface MenuCost {
  menu_item_id: string
  name: string
  price: number
  unit_cost: number
  ingredient_count: number
}

function Change({ now, before, label }: { now: number; before: number; label: string }) {
  const c = changePct(now, before)
  if (c === null) return <span className="text-gray-400">{label}: ยังไม่มีข้อมูลเทียบ</span>
  return (
    <span className={c >= 0 ? 'text-emerald-700' : 'text-red-600'}>
      {c >= 0 ? '▲' : '▼'} {Math.abs(c).toFixed(1)}% {label}
    </span>
  )
}

export default function AcctDashboard({ restaurantId, dash, mode }: { restaurantId: string; dash: Dashboard; mode: AccountingMode }) {
  const [period, setPeriod] = useState<PeriodKey>('today')
  const [costs, setCosts] = useState<MenuCost[]>([])
  const s = dash.periods[period]
  const m = metrics(s)
  const set = dash.settings

  useEffect(() => {
    if (mode !== 'standard') return
    void supabase
      .from('menu_item_costs')
      .select('menu_item_id,name,price,unit_cost,ingredient_count')
      .eq('restaurant_id', restaurantId)
      .order('name')
      .then(({ data }) =>
        setCosts(((data ?? []) as MenuCost[]).map((x) => ({ ...x, price: Number(x.price), unit_cost: Number(x.unit_cost), ingredient_count: Number(x.ingredient_count) }))),
      )
  }, [restaurantId, mode])

  const month = metrics(dash.periods.month)
  const prev = metrics(dash.periods.prev_month)
  const ytdSales = dash.periods.ytd.sales - dash.periods.ytd.discounts
  const vat = vatThreshold(ytdSales, set.vat_registered)

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="ช่วงเวลา">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            role="tab"
            aria-selected={period === p.key}
            onClick={() => setPeriod(p.key)}
            className={`rounded-full border px-3.5 py-1.5 text-sm transition ${period === p.key ? 'border-gray-900 bg-gray-900 text-white' : 'bg-white text-gray-600 hover:border-gray-300'}`}
          >
            {p.label}
          </button>
        ))}
        <span className="ml-auto self-center text-xs text-gray-500">
          {s.from === s.to ? s.to : `${s.from} ถึง ${s.to}`} (เวลาร้าน)
        </span>
      </div>

      {mode === 'simple' && <SimpleView s={s} />}

      {mode === 'standard' && (
        <>
          <div className="card">
            <div className="grid gap-3 text-center sm:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] sm:items-center">
              <div>
                <div className="stat-label">ยอดขาย</div>
                <div className="text-xl font-bold tabular-nums">{baht(m.netSales)}</div>
              </div>
              <span className="text-gray-400" aria-hidden>−</span>
              <div>
                <div className="stat-label">ต้นทุนอาหารที่ใช้จริง</div>
                <div className="text-xl font-bold tabular-nums">{baht(m.foodCost)}</div>
              </div>
              <span className="text-gray-400" aria-hidden>−</span>
              <div>
                <div className="stat-label">ค่าใช้จ่าย</div>
                <div className="text-xl font-bold tabular-nums">{baht(m.expenses)}</div>
              </div>
              <span className="text-gray-400" aria-hidden>=</span>
              <div>
                <div className="stat-label">กำไร</div>
                <div className={`text-2xl font-bold tabular-nums ${m.netProfit < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{baht(m.netProfit)}</div>
              </div>
            </div>
            <p className="mt-3 text-center text-xs text-gray-500">
              {s.bills} บิล{s.cancelled_bills > 0 && ` · ยกเลิก ${s.cancelled_bills}`} · ส่วนลด {baht(s.discounts)} · เดือนนี้{' '}
              <Change now={month.netProfit} before={prev.netProfit} label="กำไรเทียบเดือนก่อน" />
            </p>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <CostBar label="Food Cost %" value={m.foodCostPct} min={set.food_cost_target_min} max={set.food_cost_target_max} />
            <CostBar label="Prime Cost % (อาหาร + ค่าแรง)" value={m.primeCostPct} min={set.prime_cost_target_min} max={set.prime_cost_target_max} />
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Stat label="ต้นทุนตามสูตร" value={baht(s.cogs_recipe)} hint="ตัดสต็อกตามสูตรเมื่อครัวเริ่มทำ" />
            <Stat
              label="ส่วนต่างสต็อก"
              value={baht(s.stock_variance)}
              hint="นับขาด/เกิน ของเสีย ยกเลิกหลังทำ"
              tone={s.stock_variance > 0 ? 'bad' : undefined}
            />
            <Stat label="ค่าแรง" value={baht(m.labor)} hint={`ค่าใช้จ่ายอื่น ${baht(m.opex)}`} />
          </div>

          <Section title="ต้นทุนต่อจาน (ตามสูตรปัจจุบัน)">
            <div className="card-flush overflow-x-auto">
              <table className="w-full text-left text-sm [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2">
                <thead>
                  <tr>
                    <th>เมนู</th>
                    <th className="text-right">ราคา</th>
                    <th className="text-right">ต้นทุน</th>
                    <th className="text-right">กำไร/จาน</th>
                    <th className="text-right">Food Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {costs
                    .filter((c) => c.ingredient_count > 0)
                    .sort((a, b) => b.unit_cost / (b.price || 1) - a.unit_cost / (a.price || 1))
                    .map((c) => {
                      const p = c.price > 0 ? (c.unit_cost / c.price) * 100 : 0
                      return (
                        <tr key={c.menu_item_id} className="border-t">
                          <td>{c.name}</td>
                          <td className="text-right tabular-nums">{baht(c.price)}</td>
                          <td className="text-right tabular-nums">{baht(c.unit_cost)}</td>
                          <td className="text-right tabular-nums">{baht(c.price - c.unit_cost)}</td>
                          <td className={`text-right tabular-nums ${p > set.food_cost_target_max ? 'font-semibold text-red-600' : ''}`}>{p.toFixed(0)}%</td>
                        </tr>
                      )
                    })}
                  {costs.every((c) => c.ingredient_count === 0) && (
                    <tr>
                      <td colSpan={5} className="p-6 text-center text-gray-400">
                        ยังไม่มีเมนูที่ใส่สูตร ใส่สูตรที่หน้าสต็อกเพื่อให้ระบบตัดต้นทุนอัตโนมัติ
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}

      {mode === 'pro' && <ProView dash={dash} period={period} />}

      {!set.vat_registered && vat.level !== 'none' && (
        <Section title="รายรับสะสมปีนี้ เทียบเกณฑ์จด VAT">
          <div className="card">
            <div className="flex justify-between text-sm">
              <span>{baht(ytdSales)}</span>
              <span className="text-gray-500">เกณฑ์ ฿1,800,000</span>
            </div>
            <div className="mt-2 h-3 overflow-hidden rounded-full bg-gray-100">
              <div
                className={`h-full rounded-full ${vat.level === 'danger' ? 'bg-red-500' : vat.level === 'warn' ? 'bg-amber-500' : 'bg-emerald-500'}`}
                style={{ width: `${Math.min(vat.pct, 100)}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-gray-500">
              {vat.pct}% ของเกณฑ์ · รายรับเกิน 1.8 ล้านบาทต่อปีต้องจดทะเบียนภาษีมูลค่าเพิ่ม (ปรึกษานักบัญชี)
            </p>
          </div>
        </Section>
      )}

      <p className="mt-4 text-xs text-gray-500">
        สต็อก:{' '}
        {dash.reconcile.ok ? (
          <span className="text-emerald-700">มูลค่าในโมดูลสต็อก {baht(dash.reconcile.stock_value)} ตรงกับบัญชีสต็อก</span>
        ) : (
          <span className="font-semibold text-red-600">
            มูลค่าในโมดูลสต็อก {baht(dash.reconcile.stock_value)} ≠ บัญชีสต็อก {baht(dash.reconcile.ledger_value)}
          </span>
        )}
        {dash.last_close && ` · ปิดวันล่าสุด ${dash.last_close}`}
      </p>
    </div>
  )
}

function SimpleView({ s }: { s: Dashboard['periods'][PeriodKey] }) {
  const c = cashView(s)
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="เงินเข้า" value={<span className="text-emerald-700">{baht(c.in)}</span>} hint={`${s.bills} บิล`} />
        <Stat label="เงินออก" value={<span className="text-red-600">{baht(c.out)}</span>} hint="ซื้อของ = รายจ่ายวันนั้น" />
        <Stat label="คงเหลือ (เงินสด + ธนาคาร)" value={baht(c.balance)} hint={`ในลิ้นชัก ${baht(s.cash_drawer)}`} />
      </div>
      <Section title="เงินเข้า-ออกมาจากอะไร">
        <ul className="card-flush divide-y text-sm">
          {s.cash_by_source.map((r) => (
            <li key={r.source_type} className="flex justify-between gap-3 px-3 py-2.5">
              <span>{SOURCE_LABEL[r.source_type] ?? r.source_type}</span>
              <span className="tabular-nums">
                {r.in > 0 && <span className="text-emerald-700">+{baht(r.in)}</span>} {r.out > 0 && <span className="text-red-600">−{baht(r.out)}</span>}
              </span>
            </li>
          ))}
          {s.cash_by_source.length === 0 && <li className="p-6 text-center text-gray-400">ยังไม่มีเงินเข้า-ออกในช่วงนี้</li>}
        </ul>
      </Section>
    </>
  )
}

function ProView({ dash, period }: { dash: Dashboard; period: PeriodKey }) {
  const s = dash.periods[period]
  const m = metrics(s)
  const k = stockCheck(s)
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div>
        <h2 className="section-title">งบกำไรขาดทุน (ย่อ)</h2>
        <AmountTable
          rows={[
            ...s.sales_by_account.map((r) => ({ label: r.name, amount: r.amount, indent: true })),
            { label: 'หัก ส่วนลด', amount: -s.discounts, indent: true },
            { label: 'ยอดขายสุทธิ', amount: m.netSales, strong: true },
            { label: 'ต้นทุนขายตามสูตร', amount: s.cogs_recipe, indent: true },
            { label: 'ส่วนต่างสต็อก', amount: s.stock_variance, indent: true },
            { label: 'ต้นทุนอาหารรวม', amount: m.foodCost, strong: true },
            { label: 'กำไรขั้นต้น', amount: m.grossProfit, strong: true },
            ...s.expenses_by_account.filter((r) => r.grp !== 'food_cost').map((r) => ({ label: r.name, amount: r.amount, indent: true })),
            { label: 'กำไรสุทธิ', amount: m.netProfit, strong: true },
          ]}
        />
        <p className="mt-2 text-xs text-gray-500">
          Food Cost {m.foodCostPct ?? '–'}% · Prime Cost {m.primeCostPct ?? '–'}% · ภาษีขาย {baht(s.vat_output)} · ภาษีซื้อ {baht(s.vat_input)}
        </p>
      </div>
      <div>
        <h2 className="section-title">ต้นทุนขาย (perpetual)</h2>
        <AmountTable
          rows={[
            { label: 'สต็อกต้นงวด', amount: k.opening },
            { label: 'บวก รับเข้า', amount: k.purchases },
            { label: 'หัก สต็อกปลายงวด', amount: -k.closing },
            { label: 'ใช้ไปจริง', amount: k.usage, strong: true },
            { label: 'ต้นทุนตามสูตร + ส่วนต่างสต็อก', amount: k.cogsActual, strong: true },
          ]}
        />
        <p className={`mt-2 text-xs ${k.matches ? 'text-emerald-700' : 'font-semibold text-red-600'}`}>
          {k.matches ? 'ตรงกัน: ต้นทุนขายจริง = ต้นงวด + ซื้อ − ปลายงวด' : 'ไม่ตรงกัน ให้ตรวจรายการปรับสต็อก'}
        </p>
        <h2 className="section-title mt-5">เงินสดและธนาคาร</h2>
        <AmountTable
          rows={[
            { label: 'ยอดต้นงวด', amount: s.cash_open },
            { label: 'รับเข้า', amount: s.cash_in, indent: true },
            { label: 'จ่ายออก', amount: -s.cash_out, indent: true },
            { label: 'ยอดปลายงวด', amount: s.cash_close, strong: true },
          ]}
        />
        <p className="mt-2 text-xs text-gray-500">
          สมุดรายวัน บัญชีแยกประเภท งบดุล และงบกระแสเงินสดฉบับเต็ม อยู่ที่แท็บ "รายงาน" · <Money value={dash.reconcile.ledger_value} className="font-medium" /> = ยอดบัญชีสต็อก
        </p>
      </div>
    </div>
  )
}
