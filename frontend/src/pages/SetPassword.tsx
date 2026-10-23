import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { FullPageMessage, Logo } from '../components/RequireRole'
import { useSession } from '../lib/auth'

// ตั้งรหัสผ่าน: ใช้ทั้งพนักงานที่ถูกเชิญทางอีเมล และคนที่กด "ลืมรหัสผ่าน"
// ลิงก์ในอีเมลของ Supabase พามาที่หน้านี้พร้อม session ชั่วคราว (supabase-js อ่านจาก URL ให้อัตโนมัติ)
export const MIN_PASSWORD = 8

export default function SetPassword() {
  const navigate = useNavigate()
  const { session, loading } = useSession()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (password.length < MIN_PASSWORD) return setError(`รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD} ตัวอักษร`)
    if (password !== confirm) return setError('รหัสผ่านทั้งสองช่องไม่ตรงกัน')
    setBusy(true)
    setError(null)
    const { error: err } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (err) setError('ตั้งรหัสผ่านไม่สำเร็จ ลิงก์อาจหมดอายุ ขอลิงก์ใหม่ที่หน้าเข้าสู่ระบบ')
    else navigate('/')
  }

  if (loading) return <FullPageMessage>กำลังโหลด...</FullPageMessage>
  if (!session) {
    return (
      <FullPageMessage>
        <div className="card max-w-sm">
        <p className="text-red-600">ลิงก์ไม่ถูกต้องหรือหมดอายุแล้ว</p>
        <a className="link mt-3 inline-block" href="/login">
          กลับไปหน้าเข้าสู่ระบบ เพื่อขอลิงก์ใหม่
        </a>
        </div>
      </FullPageMessage>
    )
  }

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <Logo className="mb-6 justify-center text-xl" />
        <form onSubmit={onSubmit} className="card space-y-4 p-6">
      <h1 className="text-xl font-bold text-gray-900">ตั้งรหัสผ่าน</h1>
      <p className="text-sm text-gray-500">{session.user.email}</p>
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
        placeholder="ยืนยันรหัสผ่าน"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        required
      />
      {error && <p className="alert-error mb-0">{error}</p>}
      <button className="btn btn-primary w-full py-3" disabled={busy}>
        {busy ? 'กำลังบันทึก...' : 'บันทึกรหัสผ่าน'}
      </button>
        </form>
      </div>
    </div>
  )
}
