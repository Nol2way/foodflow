import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { maxRedeem, normalizePhone, pointsDiscount, pointsEarned } from '../lib/loyalty'
import { baht } from '../lib/format'
import type { Member, ShopSettings } from '../lib/types'

// สมาชิกสะสมแต้มในบิล: ค้นด้วยเบอร์โทร (ไม่พบ = สมัครใหม่ได้ทันที) แล้วเลือกแลกแต้ม

export default function MemberBox({
  restaurantId,
  settings,
  member,
  redeem,
  payable,
  onMember,
  onRedeem,
}: {
  restaurantId: string
  settings: ShopSettings
  member: Member | null
  redeem: number
  payable: number // ยอดหลังหักโปร (ก่อนแลกแต้ม)
  onMember: (m: Member | null) => void
  onRedeem: (points: number) => void
}) {
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [notFound, setNotFound] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function find(e: FormEvent) {
    e.preventDefault()
    const p = normalizePhone(phone)
    if (!p) return setError('เบอร์โทรไม่ถูกต้อง')
    setBusy(true)
    setError(null)
    const { data, error: err } = await supabase.from('members').select('id,phone,name,points,created_at').eq('restaurant_id', restaurantId).eq('phone', p).maybeSingle()
    setBusy(false)
    if (err) return setError(err.message)
    setNotFound(!data)
    if (data) onMember(data as Member)
  }

  async function register() {
    const p = normalizePhone(phone)
    if (!p) return setError('เบอร์โทรไม่ถูกต้อง')
    setBusy(true)
    const { data, error: err } = await supabase
      .from('members')
      .insert({ restaurant_id: restaurantId, phone: p, name: name.trim() || null })
      .select('id,phone,name,points,created_at')
      .single()
    setBusy(false)
    if (err) return setError(err.code === '23505' ? 'เบอร์นี้เป็นสมาชิกอยู่แล้ว' : err.message)
    setNotFound(false)
    onMember(data as Member)
  }

  if (member) {
    const max = maxRedeem(settings, member.points, payable)
    const after = Math.max(0, payable - pointsDiscount(settings, redeem))
    return (
      <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50/60 p-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold text-gray-900">
            สมาชิก {member.name ? `${member.name} · ` : ''}
            <span className="tabular-nums">{member.phone}</span>
          </span>
          <button
            type="button"
            className="link text-xs"
            onClick={() => {
              onRedeem(0)
              onMember(null)
            }}
          >
            เปลี่ยน
          </button>
        </div>
        <div className="mt-1 text-gray-600">
          แต้มสะสม <strong className="tabular-nums text-violet-700">{member.points.toLocaleString('th-TH')}</strong> แต้ม · บิลนี้จะได้เพิ่ม{' '}
          <strong className="tabular-nums">{pointsEarned(settings, after)}</strong> แต้ม
        </div>
        {max > 0 ? (
          <label className="mt-2 flex flex-wrap items-center gap-2">
            <span>แลกแต้ม</span>
            <input
              type="number"
              className="input w-24"
              min={0}
              max={max}
              step={1}
              value={redeem || ''}
              placeholder="0"
              onChange={(e) => onRedeem(Math.min(max, Math.max(0, Math.floor(Number(e.target.value) || 0))))}
            />
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onRedeem(max)}>
              ใช้สูงสุด {max}
            </button>
            {redeem > 0 && redeem < settings.loyalty_min_redeem && <span className="text-xs text-red-600">ขั้นต่ำ {settings.loyalty_min_redeem} แต้ม</span>}
            {redeem >= settings.loyalty_min_redeem && <span className="font-medium text-violet-700">ลด {baht(pointsDiscount(settings, redeem))}</span>}
          </label>
        ) : (
          <div className="mt-1 text-xs text-gray-500">แลกได้เมื่อมีอย่างน้อย {settings.loyalty_min_redeem} แต้ม</div>
        )}
      </div>
    )
  }

  return (
    <div className="mt-4 rounded-xl border border-dashed p-3 text-sm">
      <form onSubmit={(e) => void find(e)} className="flex gap-2">
        <input
          className="input flex-1"
          inputMode="tel"
          placeholder="เบอร์สมาชิก (สะสมแต้ม)"
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value)
            setNotFound(false)
          }}
        />
        <button className="btn btn-secondary btn-sm" disabled={busy || !phone.trim()}>
          ค้นหา
        </button>
      </form>
      {notFound && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-gray-600">ยังไม่เป็นสมาชิก</span>
          <input className="input w-36" placeholder="ชื่อ (ไม่บังคับ)" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void register()}>
            สมัครสมาชิก
          </button>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}
