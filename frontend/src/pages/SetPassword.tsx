import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { Logo } from '../components/RequireRole'
import { useSession } from '../lib/auth'
import { api, apiMessage } from '../lib/api'
import { updateUser } from '../lib/session'

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

  if (!session) return <Navigate to="/login" replace />
  const forced = session.user.must_change_password

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (password.length < MIN_PASSWORD) return setError(`รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD} ตัวอักษร`)
    if (password !== confirm) return setError('รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน')
    setBusy(true)
    setError(null)
    try {
      await api('/auth/password', { body: { current_password: current, new_password: password } })
      updateUser({ must_change_password: false })
      navigate('/')
    } catch (err) {
      setError(apiMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <Logo className="mb-6 justify-center text-xl" />
        <form onSubmit={onSubmit} className="card space-y-4 p-6">
      <h1 className="text-xl font-bold text-gray-900">{forced ? 'ตั้งรหัสผ่านใหม่' : 'เปลี่ยนรหัสผ่าน'}</h1>
      <p className="text-sm text-gray-500">
        {session.user.email}
        {forced && <span className="mt-1 block">คุณเข้าสู่ระบบด้วยรหัสชั่วคราว กรุณาตั้งรหัสผ่านของตัวเองก่อนใช้งาน</span>}
      </p>
      <input
        className="input w-full py-2.5"
        type="password"
        placeholder={forced ? 'รหัสชั่วคราว' : 'รหัสผ่านปัจจุบัน'}
        autoComplete="current-password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        required
      />
      <input
        className="input w-full py-2.5"
        type="password"
        placeholder={`รหัสผ่านใหม่ (อย่างน้อย ${MIN_PASSWORD} ตัว)`}
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <input
        className="input w-full py-2.5"
        type="password"
        placeholder="ยืนยันรหัสผ่านใหม่"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        required
      />
      {error && <p className="alert-error mb-0">{error}</p>}
      <button className="btn btn-primary w-full py-3" disabled={busy}>
        {busy ? 'กำลังบันทึก...' : 'บันทึกรหัสผ่าน'}
      </button>
      {!forced && (
        <button type="button" className="link-muted block w-full text-center" onClick={() => navigate(-1)}>
          ยกเลิก
        </button>
      )}
        </form>
      </div>
    </div>
  )
}
