import { translateUi } from "../lib/uiText"
import { useRef, useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { Logo } from '../components/RequireRole'
import { useSession } from '../lib/auth'
import { api, apiMessage } from '../lib/api'
import { getToken, setSession, type Session } from '../lib/session'
import { useText } from '../lib/preferences'

// เปลี่ยนรหัสผ่าน: ใช้ทั้งตอนล็อกอินด้วยรหัสชั่วคราวครั้งแรก (บังคับ) และเปลี่ยนเองจากเมนู
export const MIN_PASSWORD = 8

export default function SetPassword() {
  const navigate = useNavigate()
  const { session } = useSession()
  const [current, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const t = useText()
  const [touched, setTouched] = useState({ current: false, password: false, confirm: false })
  const currentError = !current ? t('กรอกรหัสผ่านปัจจุบันหรือรหัสชั่วคราว', 'Enter your current or temporary password.') : ''
  const passwordError = password.length < MIN_PASSWORD ? t('ใช้รหัสผ่านอย่างน้อย 8 ตัวอักษร', 'Use at least 8 characters.') : new TextEncoder().encode(password).length > 72 ? t('รหัสผ่านยาวเกิน 72 ไบต์ กรุณาลดความยาว', 'Password exceeds 72 bytes. Use a shorter password.') : ''
  const confirmError = !confirm || password !== confirm ? t('กรอกรหัสผ่านใหม่ทั้งสองช่องให้ตรงกัน', 'Enter the same new password in both fields.') : ''

  if (!session) return <Navigate to="/login" replace />
  const forced = session.user.must_change_password

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (lock.current) return
    setTouched({ current: true, password: true, confirm: true })
    if (currentError || passwordError || confirmError) {
      document.getElementById(currentError ? 'password-current' : passwordError ? 'password-new' : 'password-confirm')?.focus()
      return
    }
    lock.current = true
    const previousToken = getToken()
    setBusy(true)
    setError(null)
    try {
      const renewed = await api<Session>('/auth/password', { body: { current_password: current, new_password: password } })
      if (getToken() !== previousToken) return
      setSession({ access_token: renewed.access_token, expires_at: renewed.expires_at, user: renewed.user })
      navigate('/')
    } catch (err) {
      setError(apiMessage(err))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <Logo className="mb-6 justify-center text-xl" />
        <form onSubmit={onSubmit} noValidate aria-busy={busy} className="card space-y-4 p-6">
      <h1 className="text-xl font-bold text-gray-900">{forced ? 'ตั้งรหัสผ่านใหม่' : 'เปลี่ยนรหัสผ่าน'}</h1>
      <p className="text-sm text-gray-500">
        {session.user.email}
        {forced && <span className="mt-1 block">{translateUi("คุณเข้าสู่ระบบด้วยรหัสชั่วคราว กรุณาตั้งรหัสผ่านของตัวเองก่อนใช้งาน")}</span>}
      </p>
      <label className="label" htmlFor="password-current">{forced ? t('รหัสชั่วคราว', 'Temporary password') : t('รหัสผ่านปัจจุบัน', 'Current password')}</label>
      <input id="password-current" disabled={busy}
        aria-invalid={touched.current && !!currentError} aria-describedby={touched.current && currentError ? 'password-current-error' : undefined}
        onBlur={() => setTouched(s => ({ ...s, current: true }))}
        className="input w-full py-2.5"
        type="password"
        placeholder={forced ? 'รหัสชั่วคราว' : 'รหัสผ่านปัจจุบัน'}
        autoComplete="current-password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        required
      />
      {touched.current && currentError && <p id="password-current-error" className="field-error">{currentError}</p>}
      <label className="label" htmlFor="password-new">{t('รหัสผ่านใหม่', 'New password')}</label>
      <input id="password-new" disabled={busy}
        aria-invalid={touched.password && !!passwordError} aria-describedby={touched.password && passwordError ? 'password-new-error' : undefined}
        onBlur={() => setTouched(s => ({ ...s, password: true }))}
        className="input w-full py-2.5"
        type="password"
        placeholder={`รหัสผ่านใหม่ (อย่างน้อย ${MIN_PASSWORD} ตัว)`}
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {touched.password && passwordError && <p id="password-new-error" className="field-error">{passwordError}</p>}
      <label className="label" htmlFor="password-confirm">{t('ยืนยันรหัสผ่านใหม่', 'Confirm new password')}</label>
      <input id="password-confirm" disabled={busy}
        aria-invalid={touched.confirm && !!confirmError} aria-describedby={touched.confirm && confirmError ? 'password-confirm-error' : undefined}
        onBlur={() => setTouched(s => ({ ...s, confirm: true }))}
        className="input w-full py-2.5"
        type="password"
        placeholder={translateUi("ยืนยันรหัสผ่านใหม่")}
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        required
      />
      {touched.confirm && confirmError && <p id="password-confirm-error" className="field-error">{confirmError}</p>}
      {error && <p role="alert" className="alert-error mb-0">{error}</p>}
      <button className="btn btn-primary w-full py-3" disabled={busy}>
        {busy ? 'กำลังบันทึก...' : 'บันทึกรหัสผ่าน'}
      </button>
      {!forced && (
        <button type="button" className="link-muted block w-full text-center" onClick={() => navigate(-1)}>{"" + translateUi("ยกเลิก") + " "}</button>
      )}
        </form>
      </div>
    </div>
  )
}
