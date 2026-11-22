import { translateUi } from "../lib/uiText"
import { useEffect, useState, type ReactNode } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { signOut, useSession, useStaff } from '../lib/auth'
import { canAccess, groupPages, pagesFor, roleLabels, type Role } from '../lib/roles'
import Icon from './Icon'
import { preloadPage, preloadPages } from '../pages/loaders'
import OfflineOrders from './OfflineOrders'
import Modal from './Modal'
import { useText } from '../lib/preferences'

export interface StaffContext {
  restaurantId: string
  roles: Role[]
}

export function Logo({ className = '' }: { className?: string }) {
  return (
    <span className={`flex items-center gap-2 font-bold tracking-tight ${className || 'text-gray-900'}`}>
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-md shadow-brand-500/30">
        <Icon name="kitchen" className="h-4.5 w-4.5" />
      </span>
      Plato
    </span>
  )
}

export function FullPageMessage({ children }: { children: ReactNode }) {
  const loading = children === 'กำลังโหลด...'
  return (
    <div className="grid min-h-screen place-items-center p-6 text-center text-sm text-gray-500">
      {loading ? (
        <div className="flex flex-col items-center gap-3" role="status">
          <span className="spinner" />
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  )
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
  const t = useText()

  useEffect(() => setDrawer(false), [pathname])

  // โหลดโค้ดหน้าอื่นที่ผู้ใช้เข้าได้ไว้ล่วงหน้าตอนเครื่องว่าง (เปลี่ยนหน้าแล้วขึ้นทันที)
  const roleKey = staff.roles.join(',')
  useEffect(() => {
    if (roleKey) preloadPages(['/', ...pagesFor(roleKey.split(',') as Role[]).map((p) => p.path)])
  }, [roleKey])

  if (loading || (session && staff.loading)) return <FullPageMessage>{translateUi("กำลังโหลด...")}</FullPageMessage>
  if (!session) return <Navigate to="/login" replace />
  if (session.user.must_change_password) return <Navigate to="/set-password" replace />

  const { roles: mine, restaurantId } = staff
  if (mine.length === 0 || !restaurantId) {
    return (
      <FullPageMessage>
        <div className="card max-w-sm">
          <p className="text-red-600">{staff.error ?? 'ไม่พบสิทธิ์การใช้งาน'}</p>
          <button className="btn btn-secondary mt-4" onClick={() => signOut()}>{"" + translateUi("ออกจากระบบ") + " "}</button>
        </div>
      </FullPageMessage>
    )
  }

  const pages = pagesFor(mine)
  const current = pages.find((p) => p.path === pathname)

  const nav = (
    <nav aria-label={t('เมนูหลัก', 'Main navigation')} className="flex flex-col gap-5">
      {groupPages(pages).map((g) => (
        <div key={g.id} className="flex flex-col gap-1">
          <div className="px-3 pb-1 text-xs font-semibold text-white/75">{translateUi(g.title)}</div>
          {g.pages.map((p) => {
            const active = pathname === p.path
            return (
              <Link
                key={p.path}
                to={p.path}
                onPointerEnter={() => preloadPage(p.path)}
                onFocus={() => preloadPage(p.path)}
                aria-current={active ? 'page' : undefined}
                className={`group relative flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                  active
                    ? 'bg-brand-600 font-semibold text-white'
                    : 'text-white/85 hover:bg-white/10 hover:text-white'
                }`}
              >
                <Icon
                  name={p.icon}
                  className="h-5 w-5 shrink-0 text-white/85"
                />
                {translateUi(p.title)}
              </Link>
            )
          })}
        </div>
      ))}
    </nav>
  )

  const account = (
    <div className="border-t border-white/10 pt-3">
      <div className="mb-1 flex items-center gap-3 rounded-xl bg-white/[.05] px-3 py-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/15 text-sm font-semibold text-white uppercase">
          {(session.user.display_name ?? session.user.email ?? '?').trim().charAt(0)}
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-white">{session.user.display_name ?? session.user.email}</div>
          <div className="truncate text-xs text-white/75">{roleLabels(mine).split(' · ').map(translateUi).join(' · ')}</div>
        </div>
      </div>
      <Link
        to="/set-password"
        className="mt-2 flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-white/75 hover:bg-white/10 hover:text-white"
      >
        <Icon name="settings" className="h-5 w-5 text-white/50" />{"" + translateUi("เปลี่ยนรหัสผ่าน") + " "}</Link>
      <button
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-white/75 hover:bg-white/10 hover:text-white"
        onClick={() => signOut()}
      >
        <Icon name="logout" className="h-5 w-5 text-white/50" />{"" + translateUi("ออกจากระบบ") + " "}</button>
    </div>
  )

  return (
    <div className="min-h-screen lg:pl-64">
      <a href="#main-content" className="skip-link">{t('ข้ามไปเนื้อหา', 'Skip to content')}</a>
      {/* แถบด้านข้าง (จอใหญ่) */}
      <aside className="app-sidebar fixed inset-y-0 left-0 hidden w-64 flex-col gap-6 p-4 lg:flex">
        <Link to="/" className="px-2 pt-1">
          <Logo className="text-white" />
        </Link>
        <div className="min-h-0 flex-1 overflow-y-auto">{nav}</div>
        {account}
      </aside>

      {/* แถบด้านบน (มือถือ/แท็บเล็ต) */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-gray-200/70 bg-white/80 px-4 py-2.5 shadow-xs backdrop-blur-md lg:hidden">
        <button className="btn btn-ghost -ml-2 p-2" onClick={() => setDrawer(true)} aria-expanded={drawer} aria-haspopup="dialog" aria-label={translateUi("เปิดเมนู")}>
          <Icon name="bars" />
        </button>
        <span className="strong-text">{translateUi(current?.title ?? 'Plato')}</span>
        <span className="badge badge-gray ml-auto max-w-[45%] truncate">{roleLabels(mine).split(' · ').map(translateUi).join(' · ')}</span>
      </header>

      {drawer && (
        <Modal label={t('เมนูหลัก', 'Main navigation')} onClose={() => setDrawer(false)} className="navigation-dialog max-w-sm p-0">
          <aside
            className="app-sidebar flex max-h-[calc(100dvh-2rem)] flex-col gap-6 p-4"
          >
            <div className="flex items-center justify-between px-2 pt-1">
              <Link to="/">
                <Logo className="text-white" />
              </Link>
              <button className="btn p-2 text-white/75 hover:bg-white/10 hover:text-white" onClick={() => setDrawer(false)} aria-label={translateUi("ปิดเมนู")}>
                <Icon name="close" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{nav}</div>
            {account}
          </aside>
        </Modal>
      )}

      <main id="main-content" tabIndex={-1} className="min-w-0 outline-none">
        <OfflineOrders key={`${session.user.id}:${restaurantId}`} userId={session.user.id} restaurantId={restaurantId} />
        {canAccess(mine, roles) ? (
          children({ restaurantId, roles: mine })
        ) : (
          <div className="page">
            <div className="alert-error">{translateUi("บทบาท \"")}{roleLabels(mine).split(' · ').map(translateUi).join(' · ')}{translateUi("\" ไม่มีสิทธิ์เข้าหน้านี้")}</div>
          </div>
        )}
      </main>
    </div>
  )
}
