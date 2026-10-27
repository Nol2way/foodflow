import { lazy, Suspense } from 'react'
import { Link, Route, Routes } from 'react-router-dom'
import { isConfigured } from './lib/supabase'
import { FullPageMessage } from './components/RequireRole'

// โหลดโค้ดของแต่ละหน้าเมื่อเปิดหน้านั้น (iPad/มือถือไม่ต้องโหลดทั้งแอปตั้งแต่แรก)
const Home = lazy(() => import('./pages/Home'))
const Pos = lazy(() => import('./pages/Pos'))
const Kitchen = lazy(() => import('./pages/Kitchen'))
const Counter = lazy(() => import('./pages/Counter'))
const Serve = lazy(() => import('./pages/Serve'))
const Accounting = lazy(() => import('./pages/Accounting'))
const Stock = lazy(() => import('./pages/Stock'))
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
const StockHistory = lazy(() => import('./pages/StockHistory'))
const StockCount = lazy(() => import('./pages/StockCount'))
const StockReceive = lazy(() => import('./pages/StockReceive'))
const StockVariance = lazy(() => import('./pages/StockVariance'))
const StockYield = lazy(() => import('./pages/StockYield'))
const StockSetup = lazy(() => import('./pages/StockSetup'))

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
          <Route path="/stock-history" element={<StockHistory />} />
          <Route path="/stock-count" element={<StockCount />} />
          <Route path="/stock-receive" element={<StockReceive />} />
          <Route path="/stock-variance" element={<StockVariance />} />
          <Route path="/stock-yield" element={<StockYield />} />
          <Route path="/stock-setup" element={<StockSetup />} />
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
