import { useEffect, useState, type ReactNode } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useSession, useStaff } from '../lib/auth'
import { ROLE_LABEL, STAFF_PAGES, type Role } from '../lib/roles'
import Icon from './Icon'

export interface StaffContext {
  restaurantId: string
  role: Role
}

export function Logo({ className = '' }: { className?: string }) {
  return (
    <span className={`flex items-center gap-2 font-bold tracking-tight text-gray-900 ${className}`}>
      <span className="grid h-8 w-8 place-items-center rounded-xl bg-brand-500 text-white shadow-sm">
        <Icon name="kitchen" className="h-4.5 w-4.5" />
      </span>
      FoodFlow
    </span>
  )
}

export function FullPageMessage({ children }: { children: ReactNode }) {
  return <div className="grid min-h-screen place-items-center p-6 text-center text-sm text-gray-500">{children}</div>
}

// ครอบหน้าสำหรับพนักงาน: ตรวจล็อกอิน + บทบาท แล้วแสดงแถบเมนูตามสิทธิ์
export default function RequireRole({
  roles,
  children,
}: {
  roles: Role[]
  children: (ctx: StaffContext) => ReactNode
}) {
  const { session, loading } = useSession()
  const staff = useStaff(session?.user.id)
  const { pathname } = useLocation()
  const [drawer, setDrawer] = useState(false)

  useEffect(() => setDrawer(false), [pathname])

  if (loading || (session && staff.loading)) return <FullPageMessage>กำลังโหลด...</FullPageMessage>
  if (!session) return <Navigate to="/login" replace />

  const { role, restaurantId } = staff
  if (!role || !restaurantId) {
    return (
      <FullPageMessage>
        <div className="card max-w-sm">
          <p className="text-red-600">{staff.error ?? 'ไม่พบสิทธิ์การใช้งาน'}</p>
          <button className="btn btn-secondary mt-4" onClick={() => void supabase.auth.signOut()}>
            ออกจากระบบ
          </button>
        </div>
      </FullPageMessage>
    )
  }

  const pages = STAFF_PAGES.filter((p) => p.roles.includes(role))
  const current = pages.find((p) => p.path === pathname)

  const nav = (
    <nav className="flex flex-col gap-1">
      {pages.map((p) => {
        const active = pathname === p.path
        return (
          <Link
            key={p.path}
            to={p.path}
            className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
              active ? 'bg-brand-50 font-semibold text-brand-700' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
            }`}
          >
            <Icon name={p.icon} className={`h-5 w-5 ${active ? 'text-brand-600' : 'text-gray-400'}`} />
            {p.title}
          </Link>
        )
      })}
    </nav>
  )

  const account = (
    <div className="border-t pt-3">
      <div className="px-3 text-xs text-gray-400">เข้าสู่ระบบในฐานะ</div>
      <div className="truncate px-3 text-sm font-medium text-gray-700">{ROLE_LABEL[role]}</div>
      <div className="truncate px-3 text-xs text-gray-400">{session.user.email}</div>
      <button
        className="mt-2 flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-900"
        onClick={() => void supabase.auth.signOut()}
      >
        <Icon name="logout" className="h-5 w-5 text-gray-400" />
        ออกจากระบบ
      </button>
    </div>
  )

  return (
    <div className="min-h-screen lg:pl-64">
      {/* แถบด้านข้าง (จอใหญ่) */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col gap-6 border-r bg-white p-4 lg:flex">
        <Link to="/" className="px-2 pt-1">
          <Logo />
        </Link>
        <div className="flex-1 overflow-y-auto">{nav}</div>
        {account}
      </aside>

      {/* แถบด้านบน (มือถือ/แท็บเล็ต) */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b bg-white/90 px-4 py-2.5 backdrop-blur lg:hidden">
        <button className="btn btn-ghost -ml-2 p-2" onClick={() => setDrawer(true)} aria-label="เปิดเมนู">
          <Icon name="bars" />
        </button>
        <span className="font-semibold text-gray-900">{current?.title ?? 'FoodFlow'}</span>
        <span className="badge badge-gray ml-auto">{ROLE_LABEL[role]}</span>
      </header>

      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-gray-900/30" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col gap-6 bg-white p-4 shadow-xl">
            <div className="flex items-center justify-between px-2 pt-1">
              <Link to="/">
                <Logo />
              </Link>
              <button className="btn btn-ghost p-2" onClick={() => setDrawer(false)} aria-label="ปิดเมนู">
                <Icon name="close" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">{nav}</div>
            {account}
          </aside>
        </div>
      )}

      <main>
        {roles.includes(role) ? (
          children({ restaurantId, role })
        ) : (
          <div className="page">
            <div className="alert-error">บทบาท "{ROLE_LABEL[role]}" ไม่มีสิทธิ์เข้าหน้านี้</div>
          </div>
        )}
      </main>
    </div>
  )
}
