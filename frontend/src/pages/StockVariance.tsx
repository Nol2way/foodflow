import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import RequireRole from '../components/RequireRole'
import { Empty, PageHead, StockNav, VarianceBadge, varianceText } from '../components/stock/ui'
import { baht } from '../lib/format'
import { rolesFor, type Role } from '../lib/roles'
import { dateTime, stockApi, useLoad, type VarianceLine } from '../lib/stockApi'
import { COUNT_TYPES, displayQty, fmtNum, type VarianceColor } from '../lib/stockMath'

// รายงานส่วนต่างของใบนับ (stock_variance_report ใน 0029) · Actual vs Theoretical
//   ยอดที่ควรเหลือ = นับรอบก่อน + นำเข้า − ตัดตามสูตร · ส่วนต่าง = นับจริง − ยอดที่ควรเหลือ (ติดลบ = ของหาย)
//   เรียงตามมูลค่า · สี: เขียว < 2% · เหลือง 2-5% · แดง > 5% · ติดลบต่อเนื่อง 3 รอบ = สูตรหรือ yield อาจไม่ตรง

const pct = (n: number | null) => (n === null ? '–' : `${n > 0 ? '+' : ''}${Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 })}%`)
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmtNum(Math.abs(n))}`

function Board({ restaurantId, roles }: { restaurantId: string; roles: Role[] }) {
  const [params, setParams] = useSearchParams()
  const counts = useLoad(() => stockApi.counts(restaurantId), [restaurantId])
  const countId = params.get('count') ?? counts.data?.counts[0]?.id ?? null
  const report = useLoad(async () => (countId ? stockApi.variance(restaurantId, countId) : { lines: [] as VarianceLine[] }), [restaurantId, countId])
  const [kitchenUnits, setKitchenUnits] = useState(false)
  const [only, setOnly] = useState<VarianceColor | 'alert' | null>(null)

  const lines = useMemo(() => report.data?.lines ?? [], [report.data])
  const shown = lines.filter((l) => (only === 'alert' ? l.recipe_alert : only ? l.color === only : true))
  const sum = (c: VarianceColor) => lines.filter((l) => l.color === c).length
  const net = lines.reduce((s, l) => s + Number(l.variance_value), 0)
  const loss = lines.reduce((s, l) => s + Math.min(Number(l.variance_value), 0), 0)
  const head = counts.data?.counts.find((c) => c.id === countId)
  const q = (l: VarianceLine, n: number | null) =>
    n === null ? '–' : kitchenUnits ? displayQty(Number(n), l.unit, l.display_unit, Number(l.display_factor)) : `${fmtNum(Number(n))} ${l.unit}`
  const chip = (on: boolean) => `rounded-full border px-3 py-1 text-xs transition ${on ? 'border-gray-900 bg-gray-900 text-white' : 'bg-white text-gray-600'}`

  return (
    <div className="page">
      <PageHead title="รายงานส่วนต่าง" subtitle="นับจริง เทียบยอดที่ควรเหลือ (นับรอบก่อน + นำเข้า − ตัดตามสูตร) · ไม่มีของเสียแยก ของหายทั้งหมดอยู่ในส่วนต่าง" />
      <StockNav roles={roles} />
      {(counts.error || report.error) && <p className="alert-error">{counts.error ?? report.error}</p>}
      {counts.data && counts.data.counts.length === 0 && <Empty>ยังไม่มีใบนับ เริ่มที่หน้า "นับสต็อก"</Empty>}

      {countId && (
        <>
          <div className="card mb-4 flex flex-wrap items-end gap-3">
            <label className="min-w-64 flex-1">
              <span className="label">ใบนับ</span>
              <select className="input w-full" value={countId} onChange={(e) => setParams({ count: e.target.value })}>
                {(counts.data?.counts ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {dateTime(c.created_at)} · {COUNT_TYPES[c.count_type]} · {c.counted_by_name ?? '-'} {c.verified_at ? '· รับรองแล้ว' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input type="checkbox" checked={kitchenUnits} onChange={(e) => setKitchenUnits(e.target.checked)} />
              แสดงเป็นหน่วยครัว (ถุง ฟอง)
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="stat">
              <div className="stat-label">ส่วนต่างสุทธิ</div>
              <div className={`stat-value ${net < 0 ? 'text-red-600' : ''}`}>{baht(net)}</div>
              <div className="mt-1 text-xs text-gray-500">ของหายรวม {baht(loss)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">ปกติ (&lt; 2%)</div>
              <div className="stat-value text-emerald-700">{sum('green')}</div>
            </div>
            <div className="stat">
              <div className="stat-label">เฝ้าดู (2–5%)</div>
              <div className="stat-value text-amber-800">{sum('yellow')}</div>
            </div>
            <div className="stat">
              <div className="stat-label">ผิดปกติ (&gt; 5%)</div>
              <div className="stat-value text-red-600">{sum('red')}</div>
              {head && !head.verified_at && <div className="mt-1 text-xs text-gray-500">ใบนี้ยังรอผู้ตรวจรับรอง</div>}
            </div>
          </div>

          {lines.some((l) => l.recipe_alert) && (
            <div className="alert-warn mt-4">
              ติดลบต่อเนื่อง 3 รอบ (สูตรหรือ yield อาจไม่ตรง): {lines.filter((l) => l.recipe_alert).map((l) => l.ingredient_name).join(' · ')}
            </div>
          )}

          <div className="mt-4 mb-2 flex flex-wrap gap-1.5" role="group" aria-label="กรองสถานะ">
            <button className={chip(only === null)} onClick={() => setOnly(null)}>ทั้งหมด {lines.length}</button>
            <button className={chip(only === 'red')} onClick={() => setOnly('red')}>ผิดปกติ</button>
            <button className={chip(only === 'yellow')} onClick={() => setOnly('yellow')}>เฝ้าดู</button>
            <button className={chip(only === 'alert')} onClick={() => setOnly('alert')}>สูตร/yield อาจไม่ตรง</button>
          </div>

          <div className="card-flush overflow-x-auto">
            <table className="w-full min-w-[920px] text-sm">
              <thead>
                <tr className="text-right">
                  <th className="px-3 py-2 text-left">วัตถุดิบ</th>
                  <th className="px-3 py-2">นับรอบก่อน</th>
                  <th className="px-3 py-2">+ นำเข้า</th>
                  <th className="px-3 py-2">− ตัดตามสูตร</th>
                  <th className="px-3 py-2">= ควรเหลือ</th>
                  <th className="px-3 py-2">นับจริง</th>
                  <th className="px-3 py-2">ส่วนต่าง</th>
                  <th className="px-3 py-2">บาท</th>
                  <th className="px-3 py-2">%</th>
                  <th className="px-3 py-2 text-left">สถานะ</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {shown.map((l) => (
                  <tr key={l.ingredient_id} className="text-right tabular-nums align-top">
                    <td className="px-3 py-2 text-left">
                      <span className="font-medium text-gray-900">{l.ingredient_name}</span>
                      {l.abc_class && <span className="badge badge-gray ml-1.5">{l.abc_class}</span>}
                      {l.note && <div className="text-xs text-gray-500">เหตุผล: {l.note}</div>}
                      {l.entered_text && <div className="text-xs text-gray-400">กรอก {l.entered_text}</div>}
                    </td>
                    <td className="px-3 py-2 text-gray-600">{q(l, l.opening_qty)}</td>
                    <td className="px-3 py-2 text-gray-600">{q(l, l.received_qty)}</td>
                    <td className="px-3 py-2 text-gray-600">{q(l, l.deducted_qty)}</td>
                    <td className="px-3 py-2">{q(l, l.expected_qty)}</td>
                    <td className="px-3 py-2 font-medium text-gray-900">{q(l, l.counted_qty)}</td>
                    <td className={`px-3 py-2 font-semibold ${varianceText[l.color]}`}>{signed(Number(l.variance_qty))} {l.unit}</td>
                    <td className={`px-3 py-2 ${Number(l.variance_value) < 0 ? 'text-red-700' : 'text-gray-700'}`}>{baht(Number(l.variance_value))}</td>
                    <td className={`px-3 py-2 ${varianceText[l.color]}`}>{pct(l.variance_pct === null ? null : Number(l.variance_pct))}</td>
                    <td className="px-3 py-2 text-left">
                      <VarianceBadge color={l.color} />
                      {l.negative_streak >= 2 && (
                        <div className={`mt-1 text-xs ${l.recipe_alert ? 'font-medium text-red-700' : 'text-gray-500'}`}>ติดลบ {l.negative_streak} รอบติด</div>
                      )}
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && !report.loading && (
                  <tr><td colSpan={10} className="p-6 text-center text-gray-400">ไม่มีรายการ</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            ติดลบ = ของหายไม่ทราบสาเหตุ (ตักเกินสูตร ของเสียที่ไม่ได้บันทึก ชั่งรับไม่ตรง) · มูลค่าคิดจากต้นทุน FIFO ณ ตอนนับ
          </p>
        </>
      )}
    </div>
  )
}

export default function StockVariance() {
  return <RequireRole roles={rolesFor('/stock-variance')}>{(ctx) => <Board restaurantId={ctx.restaurantId} roles={ctx.roles} />}</RequireRole>
}
