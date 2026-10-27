import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { rolesFor, type Role } from '../lib/roles'
import { MODE_LABEL, alerts, normalizeDashboard, suggestMode, type AccountingMode, type Dashboard } from '../lib/accounting'
import RequireRole from '../components/RequireRole'
import AcctDashboard from '../components/accounting/AcctDashboard'
import AcctExpenses from '../components/accounting/AcctExpenses'
import AcctDayClose from '../components/accounting/AcctDayClose'
import AcctReports from '../components/accounting/AcctReports'
import AcctSettings from '../components/accounting/AcctSettings'
import { Disclaimer } from '../components/accounting/ui'

// บัญชี (0026): บัญชีคู่ลงอัตโนมัติข้างหลัง แสดงผลได้ 3 โหมดจากข้อมูลชุดเดียวกัน
// เจ้าของ: ทุกอย่าง · ผู้จัดการ: ดูได้ + ปิดวัน · พนักงานบัญชี: รายจ่าย รายงาน ส่งออก (ฐานข้อมูลบังคับซ้ำ)

type Tab = 'dashboard' | 'expenses' | 'close' | 'reports' | 'settings'
const TABS: { key: Tab; label: string }[] = [
  { key: 'dashboard', label: 'แดชบอร์ด' },
  { key: 'expenses', label: 'รายจ่าย' },
  { key: 'close', label: 'ปิดวัน' },
  { key: 'reports', label: 'รายงาน' },
  { key: 'settings', label: 'ตั้งค่าบัญชี' },
]
const MODE_KEY = 'plato.accounting.mode'

function readMode(): AccountingMode | null {
  try {
    const v = localStorage.getItem(MODE_KEY)
    return v === 'simple' || v === 'standard' || v === 'pro' ? v : null
  } catch {
    return null
  }
}

function Onboarding({ restaurantId, onDone }: { restaurantId: string; onDone: () => void }) {
  const [company, setCompany] = useState<boolean | null>(null)
  const [vat, setVat] = useState<boolean | null>(null)
  const [simple, setSimple] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mode = company === null || vat === null ? null : suggestMode(company ? 'company' : 'individual', vat, simple)

  async function save() {
    if (company === null || vat === null || !mode) return
    const { error: err } = await supabase.from('shop_settings').upsert({
      restaurant_id: restaurantId,
      business_type: company ? 'company' : 'individual',
      vat_registered: vat,
      accounting_mode: mode,
      accounting_onboarded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    if (err) return setError(err.message)
    onDone()
  }

  const yesNo = (value: boolean | null, set: (v: boolean) => void, name: string) => (
    <div className="flex gap-2" role="radiogroup" aria-label={name}>
      {[true, false].map((v) => (
        <button
          key={String(v)}
          type="button"
          role="radio"
          aria-checked={value === v}
          className={`btn btn-sm ${value === v ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => set(v)}
        >
          {v ? 'ใช่' : 'ไม่ใช่'}
        </button>
      ))}
    </div>
  )

  return (
    <div className="card mb-5 border-brand-200 bg-brand-50/40">
      <h2 className="section-title">เริ่มใช้บัญชี: ตอบ 2 ข้อ แล้วระบบเลือกโหมดให้</h2>
      {error && <p className="alert-error">{error}</p>}
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <p className="mb-1">1. จดทะเบียนเป็นบริษัท/ห้างหุ้นส่วนไหม?</p>
          {yesNo(company, setCompany, 'จดบริษัท')}
        </div>
        <div>
          <p className="mb-1">2. จดทะเบียนภาษีมูลค่าเพิ่ม (VAT) ไหม?</p>
          {yesNo(vat, setVat, 'จด VAT')}
        </div>
      </div>
      {company === false && vat === false && (
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={simple} onChange={(e) => setSimple(e.target.checked)} />
          อยากเห็นแค่เงินเข้า-เงินออกแบบง่ายที่สุด
        </label>
      )}
      {mode && (
        <p className="mt-3 text-sm">
          แนะนำโหมด <b>{MODE_LABEL[mode]}</b>
          {mode === 'pro' ? ' (สมุดรายวัน งบการเงิน ภาษีขาย/ซื้อ)' : mode === 'standard' ? ' (กำไร Food Cost Prime Cost)' : ' (เงินเข้า เงินออก คงเหลือ)'} · เปลี่ยนได้ตลอด
        </p>
      )}
      <button className="btn btn-primary mt-3" disabled={!mode} onClick={() => void save()}>
        เริ่มใช้งาน
      </button>
    </div>
  )
}

function Board({ restaurantId, myRoles }: { restaurantId: string; myRoles: Role[] }) {
  const isOwner = myRoles.includes('owner')
  const canWrite = isOwner || myRoles.includes('accountant')
  const canClose = isOwner || myRoles.includes('manager')
  const [params, setParams] = useSearchParams()
  const tab = (TABS.find((t) => t.key === params.get('tab'))?.key ?? 'dashboard') as Tab
  const [dash, setDash] = useState<Dashboard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setModeState] = useState<AccountingMode | null>(readMode)

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('acct_dashboard', { p_restaurant_id: restaurantId })
    if (err) return setError('โหลดข้อมูลบัญชีไม่สำเร็จ (ต้องเป็นเจ้าของ ผู้จัดการ หรือพนักงานบัญชี และรัน migration 0026 แล้ว)')
    setError(null)
    setDash(normalizeDashboard(data as Record<string, unknown>))
  }, [restaurantId])

  useEffect(() => {
    void load()
  }, [load])

  // เปลี่ยนโหมดได้ตลอด: จำในเครื่องนี้ (ค่าเริ่มต้นของร้านตั้งที่แท็บตั้งค่าบัญชี)
  function setMode(m: AccountingMode) {
    setModeState(m)
    try {
      localStorage.setItem(MODE_KEY, m)
    } catch {
      // storage ถูกปิด: ใช้ได้เฉพาะหน้านี้
    }
  }

  const current = mode ?? dash?.settings.accounting_mode ?? 'standard'
  const list = dash ? alerts(dash) : []

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">บัญชี</h1>
          <p className="page-subtitle">ลงบัญชีอัตโนมัติจากบิล สต็อก และรายจ่าย</p>
        </div>
        <div className="flex rounded-xl border border-gray-300 bg-white p-0.5" role="radiogroup" aria-label="โหมดแสดงผล">
          {(Object.keys(MODE_LABEL) as AccountingMode[]).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={current === m}
              onClick={() => setMode(m)}
              className={`rounded-lg px-3 py-1.5 text-sm transition ${current === m ? 'bg-gray-900 font-medium text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="alert-error">{error}</p>}
      {dash && isOwner && !dash.settings.onboarded && <Onboarding restaurantId={restaurantId} onDone={() => { setModeState(null); void load() }} />}
      {list.map((a) => (
        <p key={a.code} className={a.level === 'danger' ? 'alert-error' : a.level === 'warn' ? 'alert-warn' : 'alert-success'}>
          {a.text}
        </p>
      ))}

      <div className="mb-5 flex gap-1 overflow-x-auto border-b" role="tablist" aria-label="ส่วนของบัญชี">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setParams(t.key === 'dashboard' ? {} : { tab: t.key }, { replace: true })}
            className={`-mb-px shrink-0 border-b-2 px-4 py-2 text-sm ${tab === t.key ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-gray-500 hover:text-gray-800'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {dash && tab === 'dashboard' && <AcctDashboard restaurantId={restaurantId} dash={dash} mode={current} />}
      {dash && tab === 'expenses' && (
        <AcctExpenses restaurantId={restaurantId} today={dash.today} canWrite={canWrite} vatRegistered={dash.settings.vat_registered} onChanged={() => void load()} />
      )}
      {dash && tab === 'close' && <AcctDayClose restaurantId={restaurantId} today={dash.today} canClose={canClose} isOwner={isOwner} onChanged={() => void load()} />}
      {dash && tab === 'reports' && <AcctReports restaurantId={restaurantId} today={dash.today} mode={current} />}
      {dash && tab === 'settings' && <AcctSettings restaurantId={restaurantId} settings={dash.settings} isOwner={isOwner} canWrite={canWrite} onSaved={() => void load()} />}
      {!dash && !error && <p className="empty">กำลังโหลด...</p>}

      <Disclaimer />
    </div>
  )
}

export default function Accounting() {
  return <RequireRole roles={rolesFor('/accounting')}>{(ctx) => <Board restaurantId={ctx.restaurantId} myRoles={ctx.roles} />}</RequireRole>
}
