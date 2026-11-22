import { translateUi } from "../lib/uiText"
import { useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { signIn } from '../lib/auth'
import { ApiError, apiMessage } from '../lib/api'
import { Logo } from '../components/RequireRole'
import { useText } from '../lib/preferences'

export default function Login() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [forgot, setForgot] = useState(false)
  const t = useText()
  const lock = useRef(false)
  const summary = useRef<HTMLDivElement>(null)
  const [touched, setTouched] = useState({ email: false, password: false })
  const emailError = !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? t('กรอกอีเมลให้ครบ เช่น name@example.com', 'Enter a complete email, such as name@example.com.') : ''
  const passwordError = !password ? t('กรอกรหัสผ่าน', 'Enter your password.') : ''

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (lock.current) return
    setTouched({ email: true, password: true })
    if (emailError || passwordError) { requestAnimationFrame(() => summary.current?.focus()); return }
    lock.current = true
    setBusy(true)
    setError(null)
    try {
      const s = await signIn(email.trim(), password)
      // รหัสชั่วคราวจากเจ้าของร้าน: ต้องตั้งรหัสใหม่ก่อนใช้งาน
      navigate(s.user.must_change_password ? '/set-password' : '/')
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'invalid_credentials' ? translateUi('อีเมลหรือรหัสผ่านไม่ถูกต้อง') : apiMessage(err))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <Logo className="mb-6 justify-center text-xl" />
        <form onSubmit={onSubmit} noValidate aria-busy={busy} className="card space-y-5 p-6">
      <h1 className="text-xl font-bold text-gray-900">{translateUi("เข้าสู่ระบบพนักงาน")}</h1>
      {(touched.email && emailError || touched.password && passwordError) && <div ref={summary} tabIndex={-1} role="alert" className="alert-error">
        <p className="font-semibold">{t('ตรวจข้อมูลก่อนเข้าสู่ระบบ', 'Check your details before signing in.')}</p>
        {touched.email && emailError && <a className="block underline" href="#login-email">{emailError}</a>}
        {touched.password && passwordError && <a className="block underline" href="#login-password">{passwordError}</a>}
      </div>}
      <div>
      <label className="label" htmlFor="login-email">{translateUi('อีเมล')}</label>
      <input
        id="login-email"
        className="input w-full py-2.5"
        type="email"
        placeholder={translateUi("อีเมล")}
        autoComplete="email"
        value={email}
        disabled={busy}
        aria-invalid={touched.email && !!emailError}
        aria-describedby={touched.email && emailError ? 'login-email-error' : undefined}
        onBlur={() => setTouched(s => ({ ...s, email: true }))}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      {touched.email && emailError && <p id="login-email-error" className="field-error">{emailError}</p>}
      </div>
      <div>
      <label className="label" htmlFor="login-password">{translateUi('รหัสผ่าน')}</label>
      <input
        id="login-password"
        className="input w-full py-2.5"
        type="password"
        placeholder={translateUi("รหัสผ่าน")}
        autoComplete="current-password"
        value={password}
        disabled={busy}
        aria-invalid={touched.password && !!passwordError}
        aria-describedby={touched.password && passwordError ? 'login-password-error' : undefined}
        onBlur={() => setTouched(s => ({ ...s, password: true }))}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {touched.password && passwordError && <p id="login-password-error" className="field-error">{passwordError}</p>}
      </div>
      {error && <p role="alert" className="alert-error mb-0">{error}</p>}
      {forgot && (
        <p className="alert-warn mb-0">{"" + translateUi("ให้เจ้าของร้านหรือผู้จัดการกด \"รีเซ็ตรหัสผ่าน\" ที่หน้าจัดการพนักงาน แล้วใช้รหัสชั่วคราวที่ได้เข้าสู่ระบบ") + " "}</p>
      )}
      <button className="btn btn-primary w-full py-3" disabled={busy}>
        {translateUi(busy ? 'กำลังดำเนินการ...' : 'เข้าสู่ระบบ')}
      </button>
      <button type="button" className="link-muted block w-full text-center" onClick={() => setForgot(true)}>{"" + translateUi("ลืมรหัสผ่าน") + " "}</button>
        </form>
      </div>
    </div>
  )
}
