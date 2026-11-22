import { useEffect, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { useText } from '../lib/preferences'

// Verify the deployment contract before mounting pages that read/write new columns.
// Never pretend an old schema supports pricing snapshots or payment safeguards.
export default function DatabaseReady({ children }: { children: ReactNode }) {
  const t = useText()
  const { pathname } = useLocation()
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<'checking' | 'ready' | 'schema' | 'unavailable' | 'offline'>('checking')
  useEffect(() => {
    let active = true
    if (pathname === '/login') { setState('ready'); return }
    setState('checking')
    if (!navigator.onLine) {
      let verified = false
      try { verified = sessionStorage.getItem('plato.schema') === '0011' } catch { /* unavailable storage */ }
      setState(verified && pathname === '/pos' ? 'offline' : 'unavailable')
      return
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    void api<{ ok: boolean; schema_version: string }>('/readyz', { auth: false, signal: controller.signal }).then((result) => {
      if (!active) return
      if (result.ok !== true || result.schema_version !== '0011') { setState('schema'); return }
      try { sessionStorage.setItem('plato.schema', '0011') } catch { /* readiness remains valid online */ }
      setState('ready')
    }).catch((e: unknown) => {
      if (active) setState(e instanceof ApiError && e.code === 'schema_not_ready' ? 'schema' : 'unavailable')
    }).finally(() => clearTimeout(timeout))
    return () => { active = false; clearTimeout(timeout); controller.abort() }
  }, [attempt, pathname])
  useEffect(() => {
    const refresh = () => setAttempt(n => n + 1)
    window.addEventListener('online', refresh)
    window.addEventListener('offline', refresh)
    return () => { window.removeEventListener('online', refresh); window.removeEventListener('offline', refresh) }
  }, [])
  if (state === 'ready' || state === 'offline') return <>{children}</>
  if (state === 'checking') return <main className="readiness-skeleton min-h-dvh lg:pl-64" aria-busy="true" aria-label={t('กำลังโหลดระบบ', 'Loading application')}>
    <p role="status" className="sr-only">{t('กำลังตรวจความพร้อมและโหลดหน้าจอ', 'Checking availability and loading the application.')}</p>
    <div aria-hidden="true">
      <aside className="app-sidebar fixed inset-y-0 left-0 hidden w-64 space-y-8 p-6 lg:block">
        <div className="skeleton-block h-9 w-28" />
        {[0, 1, 2].map(group => <div key={group} className="space-y-4">
          <div className="skeleton-block h-3 w-16" />
          {[0, 1, 2].map(row => <div key={row} className="skeleton-block h-11 w-full" />)}
        </div>)}
      </aside>
      <div className="flex h-16 items-center gap-4 border-b bg-white px-4 lg:hidden">
        <div className="skeleton-block h-9 w-9" /><div className="skeleton-block h-5 w-28" />
      </div>
      <div className="page space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-3"><div className="skeleton-block h-8 w-40" /><div className="skeleton-block h-4 w-56 max-w-full" /></div>
          <div className="skeleton-block h-11 w-32" />
        </div>
        <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-6">
            <div className="card flex gap-3"><div className="skeleton-block h-11 w-28" /><div className="skeleton-block h-11 w-28" /></div>
            <div className="skeleton-block h-11 w-full" />
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {[0, 1, 2, 3, 4, 5].map(card => <div key={card} className="card space-y-3">
                <div className="skeleton-block aspect-[4/3] w-full" /><div className="skeleton-block h-4 w-3/4" /><div className="skeleton-block h-4 w-1/3" />
              </div>)}
            </div>
          </div>
          <div className="card hidden self-start space-y-5 xl:block">
            <div className="skeleton-block h-6 w-32" /><div className="skeleton-block h-28 w-full" /><div className="skeleton-block h-11 w-full" /><div className="skeleton-block h-5 w-24" /><div className="skeleton-block h-12 w-full" />
          </div>
        </div>
      </div>
    </div>
  </main>
  return <main className="grid min-h-dvh place-items-center p-4">
    <section className="card w-full max-w-lg space-y-4 p-6">
      <p className="label">Plato / {t('สถานะระบบ', 'System status')}</p>
      <h1 className="page-title">{state === 'schema' ? t('ระบบกำลังรออัปเดตฐานข้อมูล', 'Database update required') : t('ยังเชื่อมต่อระบบไม่ได้', 'Unable to connect')}</h1>
      <p role="status" className="text-gray-600">{state === 'schema'
        ? t('ฐานข้อมูลกับแอปยังเป็นคนละเวอร์ชัน กรุณาแจ้งผู้ดูแลร้านให้อัปเดตระบบก่อนเริ่มรับออเดอร์ ข้อมูลเดิมยังอยู่', 'The database and app versions do not match. Ask your administrator to update the system before taking orders. Existing data is unchanged.')
        : t('ตรวจอินเทอร์เน็ตแล้วลองอีกครั้ง หากยังไม่ได้ให้แจ้งผู้ดูแลร้าน', 'Check your connection and try again. Contact your administrator if the problem continues.')}</p>
      <button type="button" className="btn btn-primary" onClick={() => setAttempt(n => n + 1)}>{t('ตรวจอีกครั้ง', 'Try again')}</button>
    </section>
  </main>
}
