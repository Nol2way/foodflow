import { translateUi } from "./lib/uiText"
import { lazy, Suspense } from 'react'
import { Link, Route, Routes } from 'react-router-dom'
import { isConfigured } from './lib/supabase'
import { FullPageMessage } from './components/RequireRole'
import RouteRecovery from './components/RouteRecovery'
import { pageLoaders } from './pages/loaders'
import { usePreferences } from './lib/preferences'

// โหลดโค้ดของแต่ละหน้าเมื่อเปิดหน้านั้น (iPad/มือถือไม่ต้องโหลดทั้งแอปตั้งแต่แรก)
const Home = lazy(pageLoaders['/'])
const Pos = lazy(pageLoaders['/pos'])
const TableMap = lazy(pageLoaders['/tables'])
const Bills = lazy(pageLoaders['/bills'])
const Kitchen = lazy(pageLoaders['/kitchen'])
const Counter = lazy(pageLoaders['/counter'])
const Serve = lazy(pageLoaders['/serve'])
const Accounting = lazy(pageLoaders['/accounting'])
const Stock = lazy(pageLoaders['/stock'])
const Login = lazy(pageLoaders['/login'])
const ImportPage = lazy(pageLoaders['/import'])
const StaffPage = lazy(pageLoaders['/staff'])
const SetPassword = lazy(pageLoaders['/set-password'])
const MenuAdmin = lazy(pageLoaders['/menu'])
const PromotionsPage = lazy(pageLoaders['/promotions'])
const Display = lazy(pageLoaders['/display'])
const Settings = lazy(pageLoaders['/settings'])
const Members = lazy(pageLoaders['/members'])
const Privacy = lazy(pageLoaders['/privacy'])
const Audit = lazy(pageLoaders['/audit'])
const Report = lazy(pageLoaders['/report'])
const StockHistory = lazy(pageLoaders['/stock-history'])
const StockCount = lazy(pageLoaders['/stock-count'])
const StockReceive = lazy(pageLoaders['/stock-receive'])
const StockVariance = lazy(pageLoaders['/stock-variance'])
const StockYield = lazy(pageLoaders['/stock-yield'])
const StockSetup = lazy(pageLoaders['/stock-setup'])

export default function App() {
  usePreferences()
  return (
    <>
      {!isConfigured && !window.location.pathname.startsWith('/display/') && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900">{"" + translateUi("ยังไม่ได้ตั้งค่า Supabase: สร้างไฟล์") + " "}<code>.env</code>{" " + translateUi("จาก") + " "}<code>.env.example</code>{" " + translateUi("แล้วรัน") + " "}<code>npm run dev</code>{" " + translateUi("ใหม่") + " "}</div>
      )}
      <RouteRecovery><Suspense fallback={<FullPageMessage>{translateUi("กำลังโหลด...")}</FullPageMessage>}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/pos" element={<Pos />} />
          <Route path="/tables" element={<TableMap />} />
          <Route path="/bills" element={<Bills />} />
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
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/report" element={<Report />} />
          {/* จอ iPad สาธารณะ: ไม่ต้องล็อกอิน ใช้ลิงก์ลับของร้าน */}
          <Route path="/display/:token" element={<Display />} />
          <Route
            path="*"
            element={
              <FullPageMessage>
                <div>
                  <p className="text-lg strong-text">{translateUi("ไม่พบหน้านี้")}</p>
                  <Link className="link mt-2 inline-block" to="/">{"" + translateUi("กลับหน้าแรก") + " "}</Link>
                </div>
              </FullPageMessage>
            }
          />
        </Routes>
      </Suspense></RouteRecovery>
    </>
  )
}
