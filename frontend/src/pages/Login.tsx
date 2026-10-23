import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Logo } from '../components/RequireRole'

export default function Login() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error: err } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (err) setError('อีเมลหรือรหัสผ่านไม่ถูกต้อง')
    else navigate('/') // หน้าแรกจะแสดงเมนูตามบทบาทของผู้ใช้
  }

  // ส่งลิงก์ตั้งรหัสผ่านใหม่ทางอีเมล (ไม่บอกว่าอีเมลนี้มีบัญชีหรือไม่ กันการสุ่มหาอีเมลพนักงาน)
  async function forgot() {
    if (!email) return setError('กรอกอีเมลก่อน แล้วกด "ลืมรหัสผ่าน"')
    setBusy(true)
    setError(null)
    await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/set-password` })
    setBusy(false)
    setInfo('ถ้าอีเมลนี้มีบัญชี ระบบส่งลิงก์ตั้งรหัสผ่านใหม่ให้แล้ว กรุณาตรวจกล่องอีเมล')
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
      {info && <p className="alert-success mb-0">{info}</p>}
      <button className="btn btn-primary w-full py-3" disabled={busy}>
        {busy ? 'กำลังดำเนินการ...' : 'เข้าสู่ระบบ'}
      </button>
      <button type="button" className="link-muted block w-full text-center" onClick={() => void forgot()} disabled={busy}>
        ลืมรหัสผ่าน
      </button>
        </form>
      </div>
    </div>
  )
}
