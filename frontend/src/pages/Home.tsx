import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { signOut, useSession, useStaff } from '../lib/auth'
import { groupPages, pagesFor, roleLabels } from '../lib/roles'
import type { OrderStatus } from '../lib/types'
import Icon, { type IconName } from '../components/Icon'
import { FullPageMessage, Logo } from '../components/RequireRole'

const FEATURES: { icon: IconName; title: string; text: string }[] = [
  { icon: 'pos', title: 'รับออเดอร์', text: 'เลือกโต๊ะหรือกลับบ้าน ส่งเข้าครัวทันที' },
  { icon: 'kitchen', title: 'หน้าจอครัว', text: 'เห็นออเดอร์ใหม่แบบเรียลไทม์' },
  { icon: 'stock', title: 'สต็อกวัตถุดิบ', text: 'รับเข้า นับ ตัดตามสูตร เตือนใกล้หมด' },
  { icon: 'accounting', title: 'บัญชีและรายงาน', text: 'ปิดวัน กำไร ส่งสรุปเข้า LINE' },
]

function greeting(hour: number) {
  if (hour < 11) return 'อรุณสวัสดิ์'
  if (hour < 17) return 'สวัสดีตอนบ่าย'
  return 'สวัสดีตอนเย็น'
}

// ออเดอร์ที่ยังไม่ปิดบิล แยกตามสถานะ (เฉพาะบทบาทที่เห็นหน้าร้าน)
const LIVE: { status: OrderStatus; label: string; to: string; dot: string }[] = [
  { status: 'received', label: 'รอเข้าครัว', to: '/kitchen', dot: 'bg-amber-500' },
  { status: 'preparing', label: 'กำลังทำ', to: '/kitchen', dot: 'bg-brand-400' },
  { status: 'ready', label: 'พร้อมเสิร์ฟ', to: '/serve', dot: 'bg-emerald-500' },
  { status: 'served', label: 'รอชำระ', to: '/counter', dot: 'bg-white/70' },
]

function useLiveCounts(restaurantId: string | null, enabled: boolean) {
  const [counts, setCounts] = useState<Partial<Record<OrderStatus, number>> | null>(null)
  useEffect(() => {
    if (!restaurantId || !enabled) return
    let cancelled = false
    const load = () =>
      supabase
        .from('orders')
        .select('status')
        .eq('restaurant_id', restaurantId)
        .in('status', LIVE.map((l) => l.status))
        .then(({ data, error }) => {
          if (cancelled || error || !data) return
          const next: Partial<Record<OrderStatus, number>> = {}
          for (const r of data) next[r.status as OrderStatus] = (next[r.status as OrderStatus] ?? 0) + 1
          setCounts(next)
        })
    void load()
    const timer = setInterval(load, 20000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [restaurantId, enabled])
  return counts
}

function Landing() {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <section className="relative hidden overflow-hidden bg-charcoal p-12 text-white lg:flex lg:flex-col">
        <div className="pointer-events-none absolute -top-32 -right-32 h-96 w-96 rounded-full bg-brand-500/25 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-40 -left-24 h-96 w-96 rounded-full bg-sage-500/20 blur-3xl" />
        <Logo className="relative text-xl text-white" />
        <div className="relative my-auto max-w-md">
          <h2 className="text-4xl leading-tight font-bold tracking-tight">
            ร้านเดียว
            <br />
            <span className="text-brand-300">ทุกงานในจอเดียว</span>
          </h2>
          <p className="mt-4 text-white/60">ตั้งแต่รับออเดอร์ ครัว เสิร์ฟ ชำระเงิน จนถึงสต็อกและบัญชีปลายวัน</p>
          <ul className="mt-10 grid gap-5">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex items-start gap-4">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/10 text-brand-300">
                  <Icon name={f.icon} />
                </span>
                <span>
                  <span className="block font-semibold">{f.title}</span>
                  <span className="block text-sm text-white/55">{f.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-white/35">ออเดอร์ · ครัว · บัญชี · สต็อก · AI คาดการณ์ยอดขาย</p>
      </section>

      <section className="grid place-items-center px-4 py-10">
        <div className="w-full max-w-sm">
          <Logo className="justify-center text-2xl lg:hidden" />
          <h1 className="mt-6 text-center text-3xl font-bold tracking-tight text-gray-900 lg:mt-0 lg:text-left">ระบบบริหารร้านอาหาร</h1>
          <p className="mt-2 text-center text-gray-500 lg:text-left">เข้าสู่ระบบด้วยบัญชีพนักงานที่เจ้าของร้านสร้างให้</p>
          <Link className="btn btn-primary btn-lg mt-8 w-full" to="/login">
            เข้าสู่ระบบพนักงาน
          </Link>
          <div className="mt-8 grid grid-cols-2 gap-3 lg:hidden">
            {FEATURES.map((f) => (
              <div key={f.title} className="card flex flex-col gap-2 p-3">
                <Icon name={f.icon} className="h-5 w-5 text-brand-500" />
                <span className="text-sm font-semibold text-gray-900">{f.title}</span>
              </div>
            ))}
          </div>
          <p className="mt-6 text-center text-sm text-gray-400 lg:text-left">พนักงานหน้าร้านรับออเดอร์ แล้วส่งเข้าหน้าจอครัวทันที</p>
        </div>
      </section>
    </div>
  )
}

export default function Home() {
  const { session, loading } = useSession()
  const staff = useStaff(session?.user.id)
  const hasRole = staff.roles.length > 0
  const pages = pagesFor(staff.roles)
  const groups = groupPages(pages)
  const seesFront = pages.some((p) => p.path === '/kitchen' || p.path === '/counter')
  const counts = useLiveCounts(staff.restaurantId, seesFront)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000)
    return () => clearInterval(t)
  }, [])

  if (loading || (session && staff.loading)) return <FullPageMessage>กำลังโหลด...</FullPageMessage>
  if (session?.user.must_change_password) return <Navigate to="/set-password" replace />
  if (!session) return <Landing />

  const name = session.user.display_name ?? session.user.email
  const date = now.toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const time = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b bg-white/90 backdrop-blur">
        <div className="page flex items-center gap-3 py-3!">
          <Logo />
          <span className="ml-auto hidden max-w-[40%] truncate text-sm text-gray-500 sm:block">{name}</span>
          <Link to="/set-password" className="btn btn-ghost btn-sm" title="เปลี่ยนรหัสผ่าน" aria-label="เปลี่ยนรหัสผ่าน">
            <Icon name="settings" className="h-4 w-4" />
          </Link>
          <button className="btn btn-ghost btn-sm" onClick={() => signOut()}>
            <Icon name="logout" className="h-4 w-4" />
            ออกจากระบบ
          </button>
        </div>
      </header>

      <div className="page">
        <section className="relative mb-8 overflow-hidden rounded-3xl bg-charcoal p-6 text-white shadow-sm sm:p-8">
          <div className="pointer-events-none absolute -top-24 -right-20 h-72 w-72 rounded-full bg-brand-500/30 blur-3xl" />
          <div className="relative flex flex-wrap items-end justify-between gap-6">
            <div className="min-w-0">
              <p className="text-sm text-white/55">{date}</p>
              <h1 className="mt-1 truncate text-2xl font-bold tracking-tight sm:text-3xl">
                {greeting(now.getHours())}, {name}
              </h1>
              {hasRole && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {roleLabels(staff.roles)
                    .split(' · ')
                    .map((r) => (
                      <span key={r} className="badge bg-white/10 text-white/85">
                        {r}
                      </span>
                    ))}
                </div>
              )}
            </div>
            <div className="text-4xl font-bold tracking-tight tabular-nums text-white/90 sm:text-5xl">{time}</div>
          </div>

          {seesFront && (
            <div className="relative mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {LIVE.map((l) => (
                <Link
                  key={l.status}
                  to={l.to}
                  className="rounded-2xl bg-white/8 px-4 py-3 transition hover:bg-white/14"
                >
                  <span className="flex items-center gap-2 text-xs text-white/60">
                    <span className={`h-2 w-2 rounded-full ${l.dot}`} />
                    {l.label}
                  </span>
                  <span className="mt-1 block text-2xl font-bold tabular-nums">{counts ? (counts[l.status] ?? 0) : '–'}</span>
                </Link>
              ))}
            </div>
          )}
        </section>

        {!hasRole && <div className="alert-error">{staff.error}</div>}

        <div className="flex flex-col gap-8">
          {groups.map((g, gi) => (
            <section key={g.id}>
              <h2 className="section-title flex items-center gap-2">
                {g.title}
                <span className="badge badge-gray">{g.pages.length}</span>
              </h2>
              <div className={`grid gap-3 ${gi === 0 ? 'grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-2 lg:grid-cols-3'}`}>
                {g.pages.map((p) =>
                  gi === 0 ? (
                    // หัวข้อแรก = งานหลักของบทบาทนี้: การ์ดใหญ่ กดง่ายบนแท็บเล็ต
                    <Link
                      key={p.path}
                      to={p.path}
                      className="card group flex min-h-36 flex-col justify-between gap-4 p-5 transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md"
                    >
                      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-500 text-white shadow-sm transition group-hover:bg-brand-600">
                        <Icon name={p.icon} className="h-6 w-6" />
                      </span>
                      <span>
                        <span className="block text-lg font-semibold text-gray-900">{p.title}</span>
                        <span className="mt-0.5 block text-sm text-gray-500">{p.label}</span>
                      </span>
                    </Link>
                  ) : (
                    <Link
                      key={p.path}
                      to={p.path}
                      className="card group flex items-center gap-4 transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md"
                    >
                      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 transition group-hover:bg-brand-500 group-hover:text-white">
                        <Icon name={p.icon} className="h-5.5 w-5.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold text-gray-900">{p.title}</span>
                        <span className="mt-0.5 block truncate text-sm text-gray-500">{p.label}</span>
                      </span>
                      <span className="text-gray-300 transition group-hover:translate-x-0.5 group-hover:text-brand-500">›</span>
                    </Link>
                  ),
                )}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
