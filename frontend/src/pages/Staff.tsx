import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { MANAGER_ASSIGNABLE, ROLE_LABEL, rolesFor, type Role } from '../lib/roles'
import { ApiError, api, apiMessage } from '../lib/api'
import { useSession } from '../lib/auth'
import RequireRole from '../components/RequireRole'

interface Member {
  user_id: string
  email: string
  role: Role
}

const ROLES = Object.keys(ROLE_LABEL) as Role[]

function Board({ restaurantId, myRole }: { restaurantId: string; myRole: Role }) {
  const { session } = useSession()
  // ผู้จัดการเลือกได้เฉพาะบทบาทต่ำกว่า และแก้เจ้าของ/ผู้จัดการคนอื่นไม่ได้
  const assignable = myRole === 'owner' ? ROLES : MANAGER_ASSIGNABLE
  const canEdit = (m: Member) => myRole === 'owner' || (MANAGER_ASSIGNABLE.includes(m.role) && m.user_id !== session?.user.id)
  const [staff, setStaff] = useState<Member[]>([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('staff')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await api<{ staff: Member[] }>(`/staff?restaurant_id=${restaurantId}`)
      setStaff(r.staff)
    } catch (e) {
      setMessage(apiMessage(e))
    }
  }, [restaurantId])

  useEffect(() => {
    void load()
  }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      const r = await api<{ invited: boolean; email: string }>('/staff', { body: { restaurant_id: restaurantId, email, role } })
      setMessage(r.invited ? `ส่งอีเมลเชิญไปที่ ${r.email} แล้ว ให้พนักงานตั้งรหัสผ่านจากลิงก์ในอีเมล` : `เพิ่ม ${r.email} แล้ว`)
      setEmail('')
      void load()
    } catch (err) {
      setMessage(err instanceof ApiError && err.code === 'duplicate' ? 'ผู้ใช้นี้เป็นพนักงานของร้านอยู่แล้ว' : apiMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function changeRole(m: Member, next: Role) {
    setMessage(null)
    try {
      await api(`/staff/${m.user_id}`, { method: 'PATCH', body: { restaurant_id: restaurantId, role: next } })
      void load()
    } catch (e) {
      setMessage(apiMessage(e))
    }
  }

  async function remove(m: Member) {
    if (!window.confirm(`นำ ${m.email} ออกจากร้าน?`)) return
    setMessage(null)
    try {
      await api(`/staff/${m.user_id}?restaurant_id=${restaurantId}`, { method: 'DELETE' })
      void load()
    } catch (e) {
      setMessage(apiMessage(e))
    }
  }

  return (
    <div className="page-narrow">
      <h1 className="page-title mb-5">จัดการพนักงาน</h1>

      <form onSubmit={add} className="mb-4 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <input className="input" type="email" placeholder="อีเมลพนักงาน" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {assignable.map((r) => (
            <option key={r} value={r}>{ROLE_LABEL[r]}</option>
          ))}
        </select>
        <button className="btn btn-primary" disabled={busy}>
          เพิ่ม / เชิญ
        </button>
      </form>
      <p className="mb-4 text-xs text-gray-500">ถ้าอีเมลยังไม่มีบัญชี ระบบจะส่งอีเมลเชิญให้ตั้งรหัสผ่าน · ร้านต้องมีเจ้าของอย่างน้อย 1 คนเสมอ{myRole === 'manager' && ' · ผู้จัดการจัดการได้เฉพาะหน้าร้าน ครัว บัญชี และสต็อก'}</p>

      {message && <p className="alert-warn">{message}</p>}

      <ul className="card-flush divide-y text-sm">
        {staff.map((m) => (
          <li key={m.user_id} className="flex flex-wrap items-center justify-between gap-2 p-3">
            <span className="break-all">
              {m.email}
              {m.user_id === session?.user.id && <span className="text-gray-400"> (คุณ)</span>}
            </span>
            {canEdit(m) ? (
              <span className="flex items-center gap-2">
                <select className="input py-1.5" value={m.role} onChange={(e) => void changeRole(m, e.target.value as Role)}>
                  {assignable.map((r) => (
                    <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                  ))}
                </select>
                <button className="link-danger" onClick={() => void remove(m)}>นำออก</button>
              </span>
            ) : (
              <span className="text-gray-500">{ROLE_LABEL[m.role] ?? m.role}</span>
            )}
          </li>
        ))}
        {staff.length === 0 && <li className="p-6 text-center text-gray-400">ยังไม่มีข้อมูล</li>}
      </ul>
    </div>
  )
}

export default function StaffPage() {
  return <RequireRole roles={rolesFor('/staff')}>{(ctx) => <Board restaurantId={ctx.restaurantId} myRole={ctx.role} />}</RequireRole>
}
