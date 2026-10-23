import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { rolesFor } from '../lib/roles'
import { baht } from '../lib/format'
import RequireRole from '../components/RequireRole'
import AiPanel from '../components/AiPanel'
import {
  DAY_NAMES,
  DAY_SHORT,
  OFF_RATIO,
  PEAK_RATIO,
  buildInsights,
  classifyHours,
  forecastForDay,
  hourTotals,
  toRanges,
  type HourRow,
  type Level,
} from '../lib/analytics'

interface Summary {
  order_count: number
  revenue_total: number
  avg_bill: number
  avg_prep_minutes: number
  first_order_at: string | null
}

interface TopItem {
  item_name: string
  quantity_sold: number
}

const PERIODS = [
  { days: 14, label: '14 วัน' },
  { days: 28, label: '28 วัน' },
  { days: 56, label: '56 วัน' },
]

const BAR_COLOR: Record<Level, string> = {
  peak: 'bg-brand-500',
  normal: 'bg-gray-400',
  off: 'bg-sky-400',
  none: 'bg-gray-200',
}

function HourBars({ values, levels, from, to }: { values: number[]; levels: Level[]; from: number; to: number }) {
  const max = Math.max(1, ...values.slice(from, to + 1))
  const hours = Array.from({ length: to - from + 1 }, (_, i) => from + i)
  return (
    <div className="flex gap-1">
      {hours.map((h) => (
        <div key={h} className="flex flex-1 flex-col items-center">
          <span className="h-4 text-[11px] font-medium tabular-nums text-gray-700">{Math.round(values[h] * 10) / 10}</span>
          <div className="flex h-32 w-full items-end">
            <div
              className={`w-full rounded-t ${BAR_COLOR[levels[h]]}`}
              style={{ height: `${(values[h] / max) * 100}%`, minHeight: values[h] > 0 ? 2 : 0 }}
            />
          </div>
          <span className="mt-1 text-[10px] text-gray-500">{h}</span>
        </div>
      ))}
    </div>
  )
}

// แผนที่ความหนาแน่น: สีส้มโทนเดียว แบ่งเป็น 5 ขั้น (อ่อน → เข้ม) ให้แยกระดับได้ชัดกว่าไล่ความโปร่งใส
// ตรวจแล้ว: ความสว่างไล่ลำดับ ขั้นติดกันต่างกันพอ และขั้นอ่อนสุดยังต่างจากพื้นขาว (≥ 2:1) จึงไม่ปนกับช่องว่าง
const HEAT_STEPS = [
  { bg: '#fb9a50', ink: '#431407' },
  { bg: '#f2700f', ink: '#431407' },
  { bg: '#c9500a', ink: '#ffffff' },
  { bg: '#9a3a0b', ink: '#ffffff' },
  { bg: '#6b2508', ink: '#ffffff' },
]
const HEAT_EMPTY = '#f3f4f6'

function heatStep(n: number, max: number) {
  return Math.min(HEAT_STEPS.length - 1, Math.floor((n / max) * HEAT_STEPS.length - 1e-9))
}

function Heatmap({ cell, from, to }: { cell: (d: number, h: number) => number; from: number; to: number }) {
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null)
  const hours = Array.from({ length: to - from + 1 }, (_, i) => from + i)
  const grid = DAY_SHORT.map((_, d) => hours.map((h) => cell(d, h)))
  const max = Math.max(1, ...grid.flat())
  const rowTotals = grid.map((r) => r.reduce((a, b) => a + b, 0))
  const colTotals = hours.map((_, i) => grid.reduce((a, r) => a + r[i], 0))
  const busiest = grid.flat().indexOf(max)
  const peak = busiest >= 0 ? { d: Math.floor(busiest / hours.length), h: hours[busiest % hours.length] } : null
  const cols = { gridTemplateColumns: `3rem repeat(${hours.length}, minmax(1.9rem, 1fr)) 3.5rem` }
  const lit = (d: number) => hover?.d === d

  const readout = hover ?? peak
  const readoutValue = readout ? cell(readout.d, readout.h) : 0

  return (
    <div className="card">
      <div className="mb-3 flex min-h-6 flex-wrap items-center justify-between gap-2 text-sm">
        {readout && (
          <span className="text-gray-700">
            {hover ? '' : 'ช่วงที่แน่นที่สุด: '}
            <strong className="text-gray-900">
              วัน{DAY_NAMES[readout.d]} {readout.h}:00–{readout.h + 1}:00
            </strong>{' '}
            · {readoutValue.toLocaleString('th-TH')} ออเดอร์
          </span>
        )}
        <span className="text-xs text-gray-400">แตะหรือชี้ที่ช่องเพื่อไฮไลต์วันและชั่วโมง</span>
      </div>

      <div className="overflow-x-auto" onMouseLeave={() => setHover(null)}>
        <div className="grid min-w-max gap-[2px] text-xs" style={cols}>
          <div />
          {hours.map((h) => (
            <div key={h} className="mb-1 py-0.5 text-center tabular-nums text-gray-500">
              {h}
            </div>
          ))}
          <div className="pb-1 text-right font-medium text-gray-500">รวม</div>

          {DAY_SHORT.map((label, d) => (
            <div key={label} className="contents">
              <div className={`mr-1 flex items-center px-1.5 transition ${hover?.d === d ? 'rounded-md bg-gray-900 font-semibold text-white' : 'text-gray-600'}`}>{label}</div>
              {hours.map((h, i) => {
                const n = grid[d][i]
                const step = n > 0 ? HEAT_STEPS[heatStep(n, max)] : null
                const isPeak = peak?.d === d && peak.h === h
                const isHover = hover?.d === d && hover.h === h
                return (
                  <button
                    key={h}
                    type="button"
                    aria-label={`${DAY_NAMES[d]} ${h}:00 ${n} ออเดอร์`}
                    onMouseEnter={() => setHover({ d, h })}
                    onFocus={() => setHover({ d, h })}
                    onClick={() => setHover({ d, h })}
                    className={`relative grid h-9 place-items-center rounded-md text-[11px] font-semibold tabular-nums outline-none transition ${
                      isHover
                        ? 'z-10 scale-110 shadow-lg ring-2 ring-gray-900'
                        : lit(d)
                          ? 'ring-2 ring-inset ring-gray-900/40'
                          : isPeak && !hover
                            ? 'ring-2 ring-brand-700 ring-offset-1'
                            : ''
                    } ${hover && !lit(d) ? 'opacity-25' : ''}`}
                    style={{ background: step?.bg ?? HEAT_EMPTY, color: step?.ink ?? '#9ca3af' }}
                  >
                    {n}
                  </button>
                )
              })}
              <div className={`ml-1 flex items-center justify-end px-1.5 tabular-nums transition ${hover?.d === d ? 'rounded-md bg-gray-900 font-semibold text-white' : 'font-medium text-gray-700'}`}>{rowTotals[d].toLocaleString('th-TH')}</div>
            </div>
          ))}

          <div className="pt-1 font-medium text-gray-500">รวม</div>
          {colTotals.map((t, i) => (
            <div key={hours[i]} className="mt-1 py-0.5 text-center tabular-nums text-gray-600">
              {t}
            </div>
          ))}
          <div />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-600">
        <span className="font-medium text-gray-700">จำนวนออเดอร์ต่อช่อง</span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-3.5 w-5 rounded" style={{ background: HEAT_EMPTY }} />0
        </span>
        {HEAT_STEPS.map((s, i) => {
          const lo = Math.floor((max * i) / HEAT_STEPS.length) + 1
          const hi = Math.floor((max * (i + 1)) / HEAT_STEPS.length)
          if (hi < lo) return null
          return (
            <span key={s.bg} className="flex items-center gap-1.5 tabular-nums">
              <i className="inline-block h-3.5 w-5 rounded" style={{ background: s.bg }} />
              {lo === hi ? lo : `${lo}–${hi}`}
            </span>
          )
        })}
      </div>
    </div>
  )
}

function Legend() {
  return (
    <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-600">
      <span><i className="mr-1 inline-block h-2 w-2 rounded bg-brand-500" />พีค</span>
      <span><i className="mr-1 inline-block h-2 w-2 rounded bg-gray-400" />ปกติ</span>
      <span><i className="mr-1 inline-block h-2 w-2 rounded bg-sky-400" />ออฟพีค</span>
    </div>
  )
}

function Board({ restaurantId }: { restaurantId: string }) {
  const [days, setDays] = useState(28)
  const [rows, setRows] = useState<HourRow[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [top, setTop] = useState<TopItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [forecastDow, setForecastDow] = useState(() => (new Date().getDay() + 1) % 7)

  const load = useCallback(async () => {
    const args = { p_restaurant_id: restaurantId, p_days: days }
    const [h, s, t] = await Promise.all([
      supabase.rpc('analytics_hourly', args),
      supabase.rpc('analytics_summary', args),
      supabase.rpc('analytics_top_items', args),
    ])
    if (h.error || s.error || t.error) {
      setError('โหลดข้อมูลวิเคราะห์ไม่สำเร็จ (ต้องเป็นเจ้าของร้านหรือพนักงานบัญชี และรัน migration 0004 แล้ว)')
      return
    }
    setError(null)
    setRows(
      ((h.data ?? []) as HourRow[]).map((r) => ({
        day_of_week: Number(r.day_of_week),
        hour_of_day: Number(r.hour_of_day),
        order_count: Number(r.order_count),
        revenue_total: Number(r.revenue_total),
      })),
    )
    const sm = ((s.data ?? []) as Summary[])[0]
    setSummary(sm ? { ...sm, order_count: Number(sm.order_count), revenue_total: Number(sm.revenue_total), avg_bill: Number(sm.avg_bill), avg_prep_minutes: Number(sm.avg_prep_minutes) } : null)
    setTop(((t.data ?? []) as TopItem[]).map((x) => ({ ...x, quantity_sold: Number(x.quantity_sold) })))
    setLoaded(true)
  }, [restaurantId, days])

  useEffect(() => {
    void load()
  }, [load])

  const totals = useMemo(() => hourTotals(rows), [rows])
  const levels = useMemo(() => classifyHours(totals), [totals])
  const insights = useMemo(() => buildInsights({ rows }), [rows])

  const activeHours = totals.flatMap((t, h) => (t > 0 ? [h] : []))
  const from = activeHours.length > 0 ? activeHours[0] : 8
  const to = activeHours.length > 0 ? activeHours[activeHours.length - 1] : 22

  const cell = (d: number, h: number) => rows.find((r) => r.day_of_week === d && r.hour_of_day === h)?.order_count ?? 0

  const forecast = useMemo(() => forecastForDay(rows, forecastDow, days), [rows, forecastDow, days])
  const forecastLevels = useMemo(() => classifyHours(forecast.hours), [forecast])
  const forecastPeaks = forecastLevels.flatMap((l, h) => (l === 'peak' ? [h] : []))

  const dataDays = summary?.first_order_at
    ? Math.ceil((Date.now() - new Date(summary.first_order_at).getTime()) / 86400000)
    : 0

  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)

  return (
    <div className="page-narrow">
      <h1 className="page-title">วิเคราะห์ลูกค้า: ช่วงพีค / ออฟพีค</h1>
      <p className="mb-4 text-sm text-gray-500">
        นับจากออเดอร์ที่ไม่ถูกยกเลิก ตามเวลาของร้าน ไม่ใช้ข้อมูลส่วนบุคคลของลูกค้า
      </p>

      <div className="mb-4 flex gap-2">
        {PERIODS.map((p) => (
          <button
            key={p.days}
            onClick={() => setDays(p.days)}
            className={`rounded-full border px-3.5 py-1.5 text-sm transition ${days === p.days ? 'border-gray-900 bg-gray-900 text-white' : 'bg-white text-gray-600 hover:border-gray-300'}`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {error && <p className="alert-error">{error}</p>}
      {loaded && rows.length === 0 && !error && (
        <p className="empty text-gray-500">
          ยังไม่มีออเดอร์ในช่วงนี้ ลองรัน <code>database/seed/seed_demo.sql</code> เพื่อดูตัวอย่างข้อมูลทดลอง
        </p>
      )}

      {summary && rows.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="card">
              <div className="text-xs text-gray-500">ออเดอร์</div>
              <div className="stat-value">{summary.order_count.toLocaleString('th-TH')}</div>
            </div>
            <div className="card">
              <div className="text-xs text-gray-500">รายได้ (ชำระแล้ว)</div>
              <div className="stat-value">{baht(summary.revenue_total)}</div>
            </div>
            <div className="card">
              <div className="text-xs text-gray-500">เฉลี่ยต่อบิล</div>
              <div className="stat-value">{baht(Math.round(summary.avg_bill))}</div>
            </div>
            <div className="card">
              <div className="text-xs text-gray-500">เวลาทำอาหารเฉลี่ย</div>
              <div className="stat-value">{summary.avg_prep_minutes.toFixed(1)} นาที</div>
            </div>
          </div>

          {insights.length > 0 && (
            <section className="mt-6 rounded-2xl border border-brand-200 bg-brand-50 p-4">
              <h2 className="section-title">ข้อสังเกต</h2>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {insights.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-gray-500">
                เกณฑ์: พีค = ตั้งแต่ {PEAK_RATIO * 100}% ของค่าเฉลี่ยชั่วโมงที่มีออเดอร์ · ออฟพีค = ไม่เกิน {OFF_RATIO * 100}%
              </p>
            </section>
          )}

          <AiPanel restaurantId={restaurantId} days={days} />

          <section className="mt-6">
            <h2 className="section-title">ออเดอร์รวมแยกตามชั่วโมง</h2>
            <HourBars values={totals} levels={levels} from={from} to={to} />
            <Legend />
          </section>

          <section className="mt-6">
            <h2 className="mb-1 font-semibold text-gray-900">แผนที่ความหนาแน่น (วัน × ชั่วโมง)</h2>
            <p className="mb-3 text-xs text-gray-500">ยิ่งสีเข้ม ยิ่งมีออเดอร์มาก · ตัวเลขคือจำนวนออเดอร์รวมในช่วง {days} วัน</p>
            <Heatmap cell={cell} from={from} to={to} />
          </section>

          <section className="mt-6">
            <h2 className="section-title">เมนูขายดี</h2>
            <ol className="card-flush divide-y text-sm">
              {top.map((x, i) => (
                <li key={x.item_name} className="flex justify-between p-2">
                  <span>
                    {i + 1}. {x.item_name}
                  </span>
                  <span>{x.quantity_sold.toLocaleString('th-TH')} จาน</span>
                </li>
              ))}
            </ol>
          </section>

          <section className="mt-6">
            <h2 className="mb-1 font-semibold text-gray-900">คาดการณ์จำนวนออเดอร์รายชั่วโมง</h2>
            <p className="mb-3 text-xs text-gray-500">
              คำนวณจากค่าเฉลี่ยของวันเดียวกันในสัปดาห์ย้อนหลัง {days} วัน ไม่รวมวันหยุดพิเศษ ฝน หรือโปรโมชัน เป็นค่าประมาณ ไม่ใช่การรับประกัน
            </p>
            <div className="mb-3 flex flex-wrap gap-2">
              {Array.from({ length: 7 }, (_, i) => {
                const d = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate() + i)
                const dow = d.getDay()
                return (
                  <button
                    key={dow}
                    onClick={() => setForecastDow(dow)}
                    className={`rounded-full border px-3.5 py-1.5 text-sm transition ${forecastDow === dow ? 'border-gray-900 bg-gray-900 text-white' : 'bg-white text-gray-600 hover:border-gray-300'}`}
                  >
                    {DAY_SHORT[dow]}
                    {i === 0 ? ' (พรุ่งนี้)' : ''}
                  </button>
                )
              })}
            </div>
            {dataDays < 14 && (
              <p className="alert-warn mb-3 text-xs">
                ข้อมูลสะสมแค่ {dataDays} วัน แนะนำอย่างน้อย 4 สัปดาห์ ตัวเลขคาดการณ์จะยังแกว่งมาก
              </p>
            )}
            {!forecast.enough ? (
              <p className="alert-warn mb-0">
                วัน{DAY_NAMES[forecastDow]}ย้อนหลังมีไม่ถึง 2 ครั้งในช่วงนี้ ยังคาดการณ์ไม่ได้
              </p>
            ) : (
              <>
                <HourBars values={forecast.hours} levels={forecastLevels} from={from} to={to} />
                <Legend />
                <p className="mt-2 text-sm">
                  {forecastPeaks.length > 0
                    ? `วัน${DAY_NAMES[forecastDow]}คาดว่าจะแน่นช่วง ${toRanges(forecastPeaks).join(', ')} (เฉลี่ยจาก ${forecast.samples} วัน${DAY_NAMES[forecastDow]}ที่ผ่านมา)`
                    : 'ยังไม่เห็นช่วงที่แน่นชัดเจนในวันนี้'}
                </p>
              </>
            )}
          </section>
        </>
      )}
    </div>
  )
}

export default function Analytics() {
  return <RequireRole roles={rolesFor('/analytics')}>{(ctx) => <Board restaurantId={ctx.restaurantId} />}</RequireRole>
}
