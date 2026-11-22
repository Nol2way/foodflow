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
  return <main className="grid min-h-dvh place-items-center p-4">
    <section className="card w-full max-w-lg space-y-4 p-6" aria-busy={state === 'checking'}>
      <p className="label">Plato · {t('สถานะระบบ', 'System status')}</p>
      <h1 className="page-title">{state === 'checking' ? t('กำลังตรวจความพร้อม', 'Checking availability') : state === 'schema' ? t('ระบบกำลังรออัปเดตฐานข้อมูล', 'Database update required') : t('ยังเชื่อมต่อระบบไม่ได้', 'Unable to connect')}</h1>
      <p role="status" className="text-gray-600">{state === 'checking' ? t('กรุณารอสักครู่', 'Please wait a moment.') : state === 'schema'
        ? t('ฐานข้อมูลกับแอปยังเป็นคนละเวอร์ชัน กรุณาแจ้งผู้ดูแลร้านให้อัปเดตระบบก่อนเริ่มรับออเดอร์ ข้อมูลเดิมยังอยู่', 'The database and app versions do not match. Ask your administrator to update the system before taking orders. Existing data is unchanged.')
        : t('ตรวจอินเทอร์เน็ตแล้วลองอีกครั้ง หากยังไม่ได้ให้แจ้งผู้ดูแลร้าน', 'Check your connection and try again. Contact your administrator if the problem continues.')}</p>
      {state !== 'checking' && <button type="button" className="btn btn-primary" onClick={() => setAttempt(n => n + 1)}>{t('ตรวจอีกครั้ง', 'Try again')}</button>}
    </section>
  </main>
}
