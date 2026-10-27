import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { signIn } from '../lib/auth'
import { ApiError, apiMessage } from '../lib/api'
import { Logo } from '../components/RequireRole'

export default function Login() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [forgot, setForgot] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const s = await signIn(email, password)
      // รหัสชั่วคราวจากเจ้าของร้าน: ต้องตั้งรหัสใหม่ก่อนใช้งาน
      navigate(s.user.must_change_password ? '/set-password' : '/')
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'invalid_credentials' ? 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' : apiMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <Logo className="mb-6 justify-center text-xl" />
        <form onSubmit={onSubmit} className="card space-y-4 p-6">
      <h1 className="text-xl font-bold text-gray-900">เข้าสู่ระบบพนักงาน</h1>
      <input
        className="input w-full py-2.5"
        type="email"
        placeholder="อีเมล"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <input
        className="input w-full py-2.5"
        type="password"
        placeholder="รหัสผ่าน"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {error && <p className="alert-error mb-0">{error}</p>}
      {forgot && (
        <p className="alert-warn mb-0">
          ให้เจ้าของร้านหรือผู้จัดการกด "รีเซ็ตรหัสผ่าน" ที่หน้าจัดการพนักงาน แล้วใช้รหัสชั่วคราวที่ได้เข้าสู่ระบบ
        </p>
      )}
      <button className="btn btn-primary w-full py-3" disabled={busy}>
        {busy ? 'กำลังดำเนินการ...' : 'เข้าสู่ระบบ'}
      </button>
      <button type="button" className="link-muted block w-full text-center" onClick={() => setForgot(true)}>
        ลืมรหัสผ่าน
      </button>
        </form>
      </div>
    </div>
  )
}
