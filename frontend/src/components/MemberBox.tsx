import { translateUi } from "../lib/uiText"
import { useEffect, useRef, useState, type FormEvent } from 'react'
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
  const version = useRef(0)
  const running = useRef(false)
  useEffect(() => () => { version.current++ }, [restaurantId])
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [notFound, setNotFound] = useState(false)
  const [matches, setMatches] = useState<Member[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function find(e: FormEvent) {
    e.preventDefault()
    const p = /^\d{4}$/.test(phone.trim()) ? phone.trim() : normalizePhone(phone)
    if (!p) return setError('เบอร์โทรไม่ถูกต้อง')
    if (running.current) return
    running.current = true
    const v = version.current
    setBusy(true)
    setError(null)
    const { data, error: err } = await supabase.rpc('member_find', { p_restaurant_id: restaurantId, p_phone: p })
    running.current = false
    setBusy(false)
    if (v !== version.current) return
    if (err) return setError(err.message)
    const found = (data ?? []) as Member[]
    setMatches(found.length > 1 ? found : [])
    setNotFound(found.length === 0 && p.length !== 4)
    if (!found.length && p.length === 4) setError('ไม่พบสมาชิก กรุณากรอกเบอร์เต็มเพื่อลองใหม่หรือสมัคร')
    if (found.length === 1) onMember(found[0])
  }

  async function register() {
    const p = normalizePhone(phone)
    if (!p) return setError('เบอร์โทรไม่ถูกต้อง')
    if (running.current) return
    running.current = true
    const v = version.current
    setBusy(true)
    const { data, error: err } = await supabase
      .from('members')
      .insert({ restaurant_id: restaurantId, phone: p, name: name.trim() || null })
      .select('id,phone,name,points,created_at')
      .single()
    running.current = false
    setBusy(false)
    if (v !== version.current) return
    if (err) return setError(err.code === '23505' ? 'เบอร์นี้เป็นสมาชิกอยู่แล้ว' : err.message)
    setNotFound(false)
    onMember(data as Member)
  }

  if (member) {
    const max = maxRedeem(settings, member.points, payable)
    const after = Math.max(0, payable - pointsDiscount(settings, redeem))
    return (
      <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50/60 p-3 text-sm">
        <div className="row-between">
          <span className="strong-text">{"" + translateUi("สมาชิก") + " "}{member.name ? `${member.name} · ` : ''}
            <span className="tabular-nums">{member.phone}</span>
          </span>
          <button
            type="button"
            className="link text-xs"
            onClick={() => {
              onRedeem(0)
              onMember(null)
            }}
          >{"" + translateUi("เปลี่ยน") + " "}</button>
        </div>
        <div className="mt-1 text-gray-600">{"" + translateUi("แต้มสะสม") + " "}<strong className="tabular-nums text-violet-700">{member.points.toLocaleString('th-TH')}</strong>{" " + translateUi("แต้ม · บิลนี้จะได้เพิ่ม") + ""}{' '}
          <strong className="tabular-nums">{pointsEarned(settings, after)}</strong>{" " + translateUi("แต้ม") + " "}</div>
        {max > 0 ? (
          <label className="mt-2 toolbar">
            <span>{translateUi("แลกแต้ม")}</span>
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
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onRedeem(max)}>{"" + translateUi("ใช้สูงสุด") + " "}{max}
            </button>
            {redeem > 0 && redeem < settings.loyalty_min_redeem && <span className="field-error">{"" + translateUi("ขั้นต่ำ") + " "}{settings.loyalty_min_redeem}{" " + translateUi("แต้ม") + ""}</span>}
            {redeem >= settings.loyalty_min_redeem && <span className="font-medium text-violet-700">{"" + translateUi("ลด") + " "}{baht(pointsDiscount(settings, redeem))}</span>}
          </label>
        ) : (
          <div className="mt-1 hint">{"" + translateUi("แลกได้เมื่อมีอย่างน้อย") + " "}{settings.loyalty_min_redeem}{" " + translateUi("แต้ม") + ""}</div>
        )}
      </div>
    )
  }

  return (
    <div className="mt-4 rounded-xl border border-dashed p-3 text-sm">
      <form onSubmit={(e) => void find(e)} className="flex gap-2">
        <input
          className="input flex-1"
          aria-label={translateUi("เบอร์สมาชิก")}
          inputMode="tel"
          placeholder={translateUi("เบอร์สมาชิก หรือเลขท้าย 4 ตัว")}
          value={phone}
          onChange={(e) => {
            version.current++
            onMember(null)
            onRedeem(0)
            setError(null)
            setPhone(e.target.value)
            setNotFound(false)
            setMatches([])
          }}
        />
        <button className="btn btn-secondary btn-sm" disabled={busy || !phone.trim()}>{"" + translateUi("ค้นหา") + " "}</button>
      </form>
      {matches.length > 1 && <fieldset className="mt-3 space-y-2"><legend>{translateUi("พบหลายคน โปรดยืนยันสมาชิกก่อนเลือก")}</legend>{matches.map(candidate => <button key={candidate.id} type="button" className="btn btn-secondary block w-full" onClick={() => { onMember(candidate); setMatches([]); onRedeem(0) }}>{candidate.name ?? 'สมาชิก'} · {candidate.phone}</button>)}</fieldset>}
      {notFound && (
        <div className="mt-2 toolbar">
          <span className="text-gray-600">{translateUi("ยังไม่เป็นสมาชิก")}</span>
          <input className="input w-36" placeholder={translateUi("ชื่อ (ไม่บังคับ)")} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void register()}>{"" + translateUi("สมัครสมาชิก") + " "}</button>
        </div>
      )}
      {error && <p className="mt-1 field-error">{error}</p>}
    </div>
  )
}
