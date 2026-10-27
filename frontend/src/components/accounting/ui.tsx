// ชิ้นส่วนที่ใช้ร่วมกันในหน้าบัญชี
import type { ReactNode } from 'react'
import { baht } from '../../lib/format'
import { band, type Band } from '../../lib/accounting'

export interface AccountRow {
  id: string
  code: string
  name: string
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
  grp: string
  system_key: string | null
  is_active: boolean
}

// บัญชีที่ระบบลงเอง ห้ามเลือกเป็นหมวดรายจ่าย (ฐานข้อมูลบังคับซ้ำ)
export const AUTO_ONLY = ['cogs', 'variance', 'recv_variance', 'cash_over_short']
export const expenseCategories = (accounts: AccountRow[]) =>
  accounts.filter((a) => a.type === 'expense' && a.is_active && !AUTO_ONLY.includes(a.system_key ?? ''))

export const PAYMENT_LABEL: Record<string, string> = { cash: 'เงินสด', bank: 'โอน/QR', credit: 'ค้างจ่าย (เจ้าหนี้)' }
export const GROUP_LABEL: Record<string, string> = { food_cost: 'ต้นทุนอาหาร', labor: 'ค่าแรง', opex: 'ค่าใช้จ่ายดำเนินงาน' }

export const Money = ({ value, className = '' }: { value: number; className?: string }) => (
  <span className={`tabular-nums ${value < 0 ? 'text-red-600' : ''} ${className}`}>{baht(value)}</span>
)

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'bad' }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone === 'good' ? 'text-emerald-700' : tone === 'bad' ? 'text-red-600' : ''}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-gray-500">{hint}</div>}
    </div>
  )
}

const BAND_COLOR: Record<Band, string> = { ok: 'bg-emerald-500', high: 'bg-red-500', low: 'bg-amber-500', none: 'bg-gray-300' }
const BAND_TEXT: Record<Band, string> = { ok: 'อยู่ในเป้า', high: 'สูงกว่าเป้า', low: 'ต่ำกว่าเป้า', none: 'ยังไม่มียอดขาย' }

// แถบสีเทียบเป้า (เช่น Food Cost 28–35%): แถบเทา = ช่วงเป้า · แท่งสี = ค่าจริง
export function CostBar({ label, value, min, max }: { label: string; value: number | null; min: number; max: number }) {
  const b = band(value, min, max)
  const scale = Math.max(100, value ?? 0)
  const at = (x: number) => `${Math.min(100, (x / scale) * 100)}%`
  return (
    <div className="card">
      <div className="flex items-baseline justify-between gap-2">
        <span className="stat-label">{label}</span>
        <span className="text-xs text-gray-500">เป้า {min}–{max}%</span>
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="stat-value">{value === null ? '–' : `${value.toFixed(1)}%`}</span>
        <span className={`badge ${b === 'ok' ? 'badge-green' : b === 'high' ? 'badge-red' : b === 'low' ? 'badge-amber' : 'badge-gray'}`}>{BAND_TEXT[b]}</span>
      </div>
      <div className="relative mt-3 h-3 overflow-hidden rounded-full bg-gray-100" role="img" aria-label={`${label} ${value ?? '-'}% เป้า ${min}-${max}%`}>
        <div className="absolute inset-y-0 bg-gray-300/70" style={{ left: at(min), width: `calc(${at(max)} - ${at(min)})` }} />
        {value !== null && <div className={`absolute inset-y-0 left-0 rounded-full ${BAND_COLOR[b]}`} style={{ width: at(value) }} />}
      </div>
    </div>
  )
}

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="mt-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

// ตาราง 2 คอลัมน์ (รายการ / จำนวนเงิน) ใช้ในงบต่างๆ
export function AmountTable({ rows }: { rows: { label: ReactNode; amount: number | null; strong?: boolean; indent?: boolean }[] }) {
  return (
    <div className="card-flush">
      <table className="w-full text-sm">
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={`border-t first:border-t-0 ${r.strong ? 'bg-gray-50 font-semibold' : ''}`}>
              <td className={`px-3 py-2 ${r.indent ? 'pl-7 text-gray-600' : ''}`}>{r.label}</td>
              <td className="px-3 py-2 text-right">{r.amount === null ? '' : <Money value={r.amount} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export const ymd = (d: Date) => d.toLocaleDateString('sv-SE')
export const addDays = (s: string, n: number) => {
  const d = new Date(s + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return ymd(d)
}
export const monthStart = (s: string) => s.slice(0, 8) + '01'
export const prevMonthRange = (s: string) => {
  const end = addDays(monthStart(s), -1)
  return { from: monthStart(end), to: end }
}

export function Disclaimer() {
  return (
    <p className="mt-8 text-xs text-gray-400">
      ตัวเลขภาษีและงบในหน้านี้เป็นข้อมูลประกอบการบริหาร ระบบนี้ไม่ใช่เครื่องมือยื่นภาษีอย่างเป็นทางการ ควรให้นักบัญชีตรวจก่อนยื่น
    </p>
  )
}
