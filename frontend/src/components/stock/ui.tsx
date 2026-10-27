// ชิ้นส่วนที่ใช้ร่วมกันในหน้าสต็อก
import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { canAccess, STAFF_PAGES, type Role } from '../../lib/roles'
import { fmtNum, type VarianceColor } from '../../lib/stockMath'

// แถบไปหน้าอื่นของสต็อก (ตามสิทธิ์)
export function StockNav({ roles }: { roles: Role[] }) {
  const { pathname } = useLocation()
  const pages = STAFF_PAGES.filter((p) => p.group === 'stock' && canAccess(roles, p.roles))
  return (
    <nav className="-mx-1 mb-5 flex gap-1.5 overflow-x-auto px-1 pb-1 print:hidden" aria-label="เมนูสต็อก">
      {pages.map((p) => (
        <Link
          key={p.path}
          to={p.path}
          aria-current={pathname === p.path ? 'page' : undefined}
          className={`shrink-0 rounded-full border px-3.5 py-1.5 text-sm transition ${
            pathname === p.path ? 'border-charcoal bg-charcoal text-white' : 'bg-white text-gray-600 hover:border-gray-300'
          }`}
        >
          {p.title}
        </Link>
      ))}
    </nav>
  )
}

export function PageHead({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="page-header print:hidden">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  )
}

// สีสถานะส่วนต่าง: เขียว < 2% · เหลือง 2-5% · แดง > 5% (สีแดง/เหลืองใช้บอกสถานะเท่านั้น)
const COLOR: Record<VarianceColor, { badge: string; label: string }> = {
  green: { badge: 'badge-green', label: 'ปกติ' },
  yellow: { badge: 'badge-amber', label: 'เฝ้าดู' },
  red: { badge: 'badge-red', label: 'ผิดปกติ' },
}
export function VarianceBadge({ color }: { color: VarianceColor }) {
  return <span className={`badge ${COLOR[color].badge}`}>{COLOR[color].label}</span>
}
export const varianceText: Record<VarianceColor, string> = { green: 'text-emerald-700', yellow: 'text-amber-800', red: 'text-red-700' }

// ปุ่ม +/- ใหญ่ (นับด้วยนิ้วบนแท็บเล็ต) · ช่องกลางพิมพ์ได้
export function Stepper({
  value,
  onChange,
  step = 1,
  unit,
  label,
}: {
  value: string
  onChange: (v: string) => void
  step?: number
  unit: string
  label: string
}) {
  const n = Number(value) || 0
  const bump = (d: number) => onChange(String(Math.max(0, Math.round((n + d) * 1000) / 1000)))
  return (
    <div className="flex items-center gap-2">
      <button type="button" className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-gray-300 bg-white text-2xl font-semibold text-gray-700 active:scale-95"
        aria-label={`ลด ${label} ${fmtNum(step)} ${unit}`} onClick={() => bump(-step)}>−</button>
      <label className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="sr-only">{label} ({unit})</span>
        <input className="input h-12 w-full min-w-0 text-center text-lg font-semibold tabular-nums" inputMode="decimal" type="number" min="0" step="any"
          placeholder="-" value={value} onChange={(e) => onChange(e.target.value)} />
        <span className="w-12 shrink-0 text-sm text-gray-500">{unit}</span>
      </label>
      <button type="button" className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand-500 text-2xl font-semibold text-white active:scale-95"
        aria-label={`เพิ่ม ${label} ${fmtNum(step)} ${unit}`} onClick={() => bump(step)}>+</button>
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}
