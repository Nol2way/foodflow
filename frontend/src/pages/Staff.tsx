import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { MANAGER_ASSIGNABLE, ROLE_LABEL, roleLabels, rolesFor, type Role } from '../lib/roles'
import { ApiError, api, apiMessage } from '../lib/api'
import { useSession } from '../lib/auth'
import RequireRole from '../components/RequireRole'

interface Member {
  user_id: string
  email: string
  display_name: string | null
  roles: Role[]
}

// รหัสชั่วคราวแสดงครั้งเดียว ให้ผู้เพิ่มส่งต่อพนักงานเอง (ระบบไม่ส่งอีเมล)
interface Temp {
  email: string
  password: string
}

const ROLES = Object.keys(ROLE_LABEL) as Role[]

// ปุ่มเลือกบทบาท กดได้หลายอัน (พนักงาน 1 คนมีได้หลายบทบาท)
function RolePicker({ options, value, onToggle, disabled }: { options: Role[]; value: Role[]; onToggle: (r: Role) => void; disabled?: boolean }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {options.map((r) => {
        const on = value.includes(r)
        return (
          <button
            key={r}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => onToggle(r)}
            className={`rounded-full border px-3 py-1 text-xs transition disabled:opacity-50 ${on ? 'border-gray-900 bg-gray-900 text-white' : 'bg-white text-gray-600 hover:border-gray-300'}`}
          >
            {ROLE_LABEL[r]}
          </button>
        )
      })}
    </span>
  )
}

function Board({ restaurantId, myRoles }: { restaurantId: string; myRoles: Role[] }) {
  const { session } = useSession()
  const isOwner = myRoles.includes('owner')
  // ผู้จัดการเลือกได้เฉพาะบทบาทต่ำกว่า และแก้คนที่มีบทบาทเจ้าของ/ผู้จัดการ หรือตัวเองไม่ได้
  const assignable = isOwner ? ROLES : MANAGER_ASSIGNABLE
  const canEdit = (m: Member) => isOwner || (m.roles.every((r) => MANAGER_ASSIGNABLE.includes(r)) && m.user_id !== session?.user.id)
  const [staff, setStaff] = useState<Member[]>([])
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [temp, setTemp] = useState<Temp | null>(null)
  const [roles, setRoles] = useState<Role[]>(['staff'])
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)

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

  const toggle = (list: Role[], r: Role) => (list.includes(r) ? list.filter((x) => x !== r) : [...list, r])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (roles.length === 0) return setMessage('เลือกบทบาทอย่างน้อย 1 บทบาท')
    setBusy(true)
    setMessage(null)
    setTemp(null)
    try {
      const r = await api<{ created: boolean; email: string; temp_password?: string }>('/staff', {
        body: { restaurant_id: restaurantId, email, roles, display_name: name },
      })
      if (r.temp_password) setTemp({ email: r.email, password: r.temp_password })
      else setMessage(`เพิ่ม ${r.email} แล้ว (ใช้บัญชีเดิมของผู้ใช้นี้)`)
      setEmail('')
      setName('')
      setRoles(['staff'])
      void load()
    } catch (err) {
      setMessage(err instanceof ApiError && err.code === 'duplicate' ? 'ผู้ใช้นี้เป็นพนักงานของร้านอยู่แล้ว เพิ่มบทบาทได้ที่รายชื่อด้านล่าง' : apiMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function toggleRole(m: Member, r: Role) {
    const next = toggle(m.roles, r)
    if (next.length === 0) return setMessage('ต้องมีอย่างน้อย 1 บทบาท ถ้าจะเอาออกจากร้านให้กด "นำออก"')
    setMessage(null)
    setSaving(m.user_id)
    try {
      await api(`/staff/${m.user_id}`, { method: 'PATCH', body: { restaurant_id: restaurantId, roles: next } })
      await load()
    } catch (e) {
      setMessage(apiMessage(e))
    } finally {
      setSaving(null)
    }
  }

  async function resetPassword(m: Member) {
    if (!window.confirm(`รีเซ็ตรหัสผ่านของ ${m.email}? รหัสเดิมจะใช้ไม่ได้ทันที`)) return
    setMessage(null)
    try {
      const r = await api<{ temp_password: string }>(`/staff/${m.user_id}/reset-password`, { body: { restaurant_id: restaurantId } })
      setTemp({ email: m.email, password: r.temp_password })
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

      <form onSubmit={add} className="card mb-4 space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input className="input flex-1" type="email" placeholder="อีเมลพนักงาน" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input className="input sm:w-40" placeholder="ชื่อ (ไม่บังคับ)" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn btn-primary" disabled={busy}>
            เพิ่ม / เชิญ
          </button>
        </div>
        <div>
          <div className="label">บทบาท (เลือกได้หลายอัน)</div>
          <RolePicker options={assignable} value={roles} onToggle={(r) => setRoles((prev) => toggle(prev, r))} />
        </div>
      </form>
      <p className="mb-4 text-xs text-gray-500">
        ถ้าอีเมลยังไม่มีบัญชี ระบบจะสร้างบัญชีพร้อมรหัสชั่วคราวให้ส่งต่อพนักงาน (พนักงานต้องตั้งรหัสใหม่ตอนเข้าครั้งแรก) · พนักงาน 1 คนมีได้หลายบทบาท เห็นหน้าของทุกบทบาทรวมกัน · ร้านต้องมีเจ้าของอย่างน้อย 1 คนเสมอ
        {!isOwner && ' · ผู้จัดการจัดการได้เฉพาะหน้าร้าน ครัว บัญชี และสต็อก'}
      </p>

      {temp && (
        <div className="alert-success">
          <p>รหัสชั่วคราวของ <strong>{temp.email}</strong> (แสดงครั้งเดียว ส่งให้พนักงานเอง)</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="rounded-lg bg-white px-3 py-1.5 text-base font-semibold tracking-wider text-gray-900 select-all">{temp.password}</code>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void navigator.clipboard?.writeText(temp.password)}>
              คัดลอก
            </button>
            <button type="button" className="link-muted ml-auto" onClick={() => setTemp(null)}>ปิด</button>
          </div>
        </div>
      )}
      {message && <p className="alert-warn">{message}</p>}

      <ul className="card-flush divide-y text-sm">
        {staff.map((m) => (
          <li key={m.user_id} className="space-y-2 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="break-all font-medium text-gray-900">
                {m.display_name && <span>{m.display_name} · </span>}
                {m.email}
                {m.user_id === session?.user.id && <span className="font-normal text-gray-400"> (คุณ)</span>}
              </span>
              {canEdit(m) && (
                <span className="flex shrink-0 items-center gap-3">
                  {m.user_id !== session?.user.id && (
                    <button className="link-muted" onClick={() => void resetPassword(m)}>รีเซ็ตรหัสผ่าน</button>
                  )}
                  <button className="link-danger" onClick={() => void remove(m)}>นำออก</button>
                </span>
              )}
            </div>
            {canEdit(m) ? (
              <RolePicker options={assignable} value={m.roles} disabled={saving === m.user_id} onToggle={(r) => void toggleRole(m, r)} />
            ) : (
              <div className="text-gray-500">{roleLabels(m.roles)}</div>
            )}
          </li>
        ))}
        {staff.length === 0 && <li className="p-6 text-center text-gray-400">ยังไม่มีข้อมูล</li>}
      </ul>
    </div>
  )
}

export default function StaffPage() {
  return <RequireRole roles={rolesFor('/staff')}>{(ctx) => <Board restaurantId={ctx.restaurantId} myRoles={ctx.roles} />}</RequireRole>
}
