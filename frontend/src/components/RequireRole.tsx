import { useEffect, useState, type ReactNode } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { signOut, useSession, useStaff } from '../lib/auth'
import { canAccess, groupPages, pagesFor, roleLabels, type Role } from '../lib/roles'
import Icon from './Icon'

export interface StaffContext {
  restaurantId: string
  roles: Role[]
}

export function Logo({ className = '' }: { className?: string }) {
  return (
    <span className={`flex items-center gap-2 font-bold tracking-tight ${className || 'text-gray-900'}`}>
      <span className="grid h-8 w-8 place-items-center rounded-xl bg-brand-500 text-white shadow-sm">
        <Icon name="kitchen" className="h-4.5 w-4.5" />
      </span>
      Plato
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
  if (session.user.must_change_password) return <Navigate to="/set-password" replace />

  const { roles: mine, restaurantId } = staff
  if (mine.length === 0 || !restaurantId) {
    return (
      <FullPageMessage>
        <div className="card max-w-sm">
          <p className="text-red-600">{staff.error ?? 'ไม่พบสิทธิ์การใช้งาน'}</p>
          <button className="btn btn-secondary mt-4" onClick={() => signOut()}>
            ออกจากระบบ
          </button>
        </div>
      </FullPageMessage>
    )
  }

  const pages = pagesFor(mine)
  const current = pages.find((p) => p.path === pathname)

  const nav = (
    <nav className="flex flex-col gap-5">
      {groupPages(pages).map((g) => (
        <div key={g.id} className="flex flex-col gap-1">
          <div className="px-3 pb-1 text-xs font-semibold tracking-wide text-white/40">{g.title}</div>
          {g.pages.map((p) => {
            const active = pathname === p.path
            return (
              <Link
                key={p.path}
                to={p.path}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
                  active ? 'bg-brand-500 font-semibold text-white' : 'text-white/75 hover:bg-white/10 hover:text-white'
                }`}
              >
                <Icon name={p.icon} className={`h-5 w-5 ${active ? 'text-white' : 'text-white/50'}`} />
                {p.title}
              </Link>
            )
          })}
        </div>
      ))}
    </nav>
  )

  const account = (
    <div className="border-t border-white/10 pt-3">
      <div className="px-3 text-xs text-white/50">เข้าสู่ระบบในฐานะ</div>
      <div className="px-3 text-sm font-medium text-white">{roleLabels(mine)}</div>
      <div className="truncate px-3 text-xs text-white/50">{session.user.display_name ?? session.user.email}</div>
      <Link
        to="/set-password"
        className="mt-2 flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-white/75 hover:bg-white/10 hover:text-white"
      >
        <Icon name="settings" className="h-5 w-5 text-white/50" />
        เปลี่ยนรหัสผ่าน
      </Link>
      <button
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-white/75 hover:bg-white/10 hover:text-white"
        onClick={() => signOut()}
      >
        <Icon name="logout" className="h-5 w-5 text-white/50" />
        ออกจากระบบ
      </button>
    </div>
  )

  return (
    <div className="min-h-screen lg:pl-64">
      {/* แถบด้านข้าง (จอใหญ่) */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col gap-6 bg-charcoal p-4 lg:flex">
        <Link to="/" className="px-2 pt-1">
          <Logo className="text-white" />
        </Link>
        <div className="flex-1 overflow-y-auto">{nav}</div>
        {account}
      </aside>

      {/* แถบด้านบน (มือถือ/แท็บเล็ต) */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b bg-white/90 px-4 py-2.5 backdrop-blur lg:hidden">
        <button className="btn btn-ghost -ml-2 p-2" onClick={() => setDrawer(true)} aria-label="เปิดเมนู">
          <Icon name="bars" />
        </button>
        <span className="font-semibold text-gray-900">{current?.title ?? 'Plato'}</span>
        <span className="badge badge-gray ml-auto max-w-[45%] truncate">{roleLabels(mine)}</span>
      </header>

      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-gray-900/30" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col gap-6 bg-charcoal p-4 shadow-xl">
            <div className="flex items-center justify-between px-2 pt-1">
              <Link to="/">
                <Logo className="text-white" />
              </Link>
              <button className="btn p-2 text-white/75 hover:bg-white/10 hover:text-white" onClick={() => setDrawer(false)} aria-label="ปิดเมนู">
                <Icon name="close" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">{nav}</div>
            {account}
          </aside>
        </div>
      )}

      <main>
        {canAccess(mine, roles) ? (
          children({ restaurantId, roles: mine })
        ) : (
          <div className="page">
            <div className="alert-error">บทบาท "{roleLabels(mine)}" ไม่มีสิทธิ์เข้าหน้านี้</div>
          </div>
        )}
      </main>
    </div>
  )
}
