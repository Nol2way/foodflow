import { lazy, Suspense } from 'react'
import { Link, Route, Routes } from 'react-router-dom'
import { isConfigured, supabase } from './lib/supabase'
import { useSession, useStaff } from './lib/auth'
import { ROLE_LABEL, STAFF_PAGES } from './lib/roles'
import Icon from './components/Icon'
import { FullPageMessage, Logo } from './components/RequireRole'

// โหลดโค้ดของแต่ละหน้าเมื่อเปิดหน้านั้น (iPad/มือถือไม่ต้องโหลดทั้งแอปตั้งแต่แรก)
const Pos = lazy(() => import('./pages/Pos'))
const Kitchen = lazy(() => import('./pages/Kitchen'))
const Counter = lazy(() => import('./pages/Counter'))
const Serve = lazy(() => import('./pages/Serve'))
const Accounting = lazy(() => import('./pages/Accounting'))
const Stock = lazy(() => import('./pages/Stock'))
const Analytics = lazy(() => import('./pages/Analytics'))
const Login = lazy(() => import('./pages/Login'))
const ImportPage = lazy(() => import('./pages/Import'))
const StaffPage = lazy(() => import('./pages/Staff'))
const SetPassword = lazy(() => import('./pages/SetPassword'))
const MenuAdmin = lazy(() => import('./pages/MenuAdmin'))
const PromotionsPage = lazy(() => import('./pages/Promotions'))
const Display = lazy(() => import('./pages/Display'))
const Settings = lazy(() => import('./pages/Settings'))
const Members = lazy(() => import('./pages/Members'))
const Report = lazy(() => import('./pages/Report'))

function Home() {
  const { session, loading } = useSession()
  const staff = useStaff(session?.user.id)
  const role = staff.role
  const pages = role ? STAFF_PAGES.filter((p) => p.roles.includes(role)) : []

  if (loading || (session && staff.loading)) return <FullPageMessage>กำลังโหลด...</FullPageMessage>

  if (!session) {
    return (
      <div className="grid min-h-screen place-items-center px-4 py-10">
        <div className="w-full max-w-md text-center">
          <Logo className="justify-center text-2xl" />
          <h1 className="mt-6 text-3xl font-bold tracking-tight text-gray-900">ระบบบริหารร้านอาหาร</h1>
          <p className="mt-2 text-gray-500">ออเดอร์ · ครัว · บัญชี · สต็อก · AI คาดการณ์ยอดขาย</p>
          <Link className="btn btn-primary btn-lg mt-8 w-full" to="/login">
            เข้าสู่ระบบพนักงาน
          </Link>
          <p className="mt-4 text-sm text-gray-400">พนักงานหน้าร้านรับออเดอร์ แล้วส่งเข้าหน้าจอครัวทันที</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen">
      <header className="border-b bg-white">
        <div className="page flex items-center gap-3 py-3!">
          <Logo />
          {role && <span className="badge badge-brand ml-auto">{ROLE_LABEL[role]}</span>}
          <button className={`btn btn-ghost btn-sm ${role ? '' : 'ml-auto'}`} onClick={() => void supabase.auth.signOut()}>
            <Icon name="logout" className="h-4 w-4" />
            ออกจากระบบ
          </button>
        </div>
      </header>
      <div className="page">
        <div className="page-header">
          <div>
            <h1 className="page-title">สวัสดี</h1>
            <p className="page-subtitle">{session.user.email} · เลือกงานที่ต้องการ</p>
          </div>
        </div>
        {!role && <div className="alert-error">{staff.error}</div>}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {pages.map((p) => (
            <Link
              key={p.path}
              to={p.path}
              className="card group flex items-start gap-4 transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md"
            >
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 transition group-hover:bg-brand-500 group-hover:text-white">
                <Icon name={p.icon} className="h-5.5 w-5.5" />
              </span>
              <span>
                <span className="block font-semibold text-gray-900">{p.title}</span>
                <span className="mt-0.5 block text-sm text-gray-500">{p.label}</span>
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <>
      {!isConfigured && !window.location.pathname.startsWith('/display/') && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900">
          ยังไม่ได้ตั้งค่า Supabase: สร้างไฟล์ <code>.env</code> จาก <code>.env.example</code> แล้วรัน <code>npm run dev</code> ใหม่
        </div>
      )}
      <Suspense fallback={<FullPageMessage>กำลังโหลด...</FullPageMessage>}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/pos" element={<Pos />} />
          <Route path="/login" element={<Login />} />
          <Route path="/set-password" element={<SetPassword />} />
          <Route path="/kitchen" element={<Kitchen />} />
          <Route path="/serve" element={<Serve />} />
          <Route path="/counter" element={<Counter />} />
          <Route path="/accounting" element={<Accounting />} />
          <Route path="/stock" element={<Stock />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/staff" element={<StaffPage />} />
          <Route path="/menu" element={<MenuAdmin />} />
          <Route path="/promotions" element={<PromotionsPage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/members" element={<Members />} />
          <Route path="/report" element={<Report />} />
          {/* จอ iPad สาธารณะ: ไม่ต้องล็อกอิน ใช้ลิงก์ลับของร้าน */}
          <Route path="/display/:token" element={<Display />} />
          <Route
            path="*"
            element={
              <FullPageMessage>
                <div>
                  <p className="text-lg font-semibold text-gray-900">ไม่พบหน้านี้</p>
                  <Link className="link mt-2 inline-block" to="/">
                    กลับหน้าแรก
                  </Link>
                </div>
              </FullPageMessage>
            }
          />
        </Routes>
      </Suspense>
    </>
  )
}
