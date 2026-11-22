import { translateUi } from "../lib/uiText"
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { rolesFor } from '../lib/roles'
import RequireRole from '../components/RequireRole'
import type { Member } from '../lib/types'
import MemberPrivacyActions from '../components/MemberPrivacyActions'


// สมาชิกสะสมแต้ม (เจ้าของ ผู้จัดการ · 0017): ค้นหา ดูประวัติแต้ม ปรับแต้มพร้อมเหตุผล
// สมัครสมาชิกทำที่หน้ารับชำระ (ใส่เบอร์ตอนจ่ายเงิน)

interface LedgerRow {
  id: string
  change: number
  reason: 'earn' | 'redeem' | 'reverse' | 'adjust'
  note: string | null
  created_at: string
}

const REASON: Record<LedgerRow['reason'], string> = { earn: 'ได้จากการซื้อ', redeem: 'แลกส่วนลด', reverse: 'ยกเลิกบิล', adjust: 'ปรับโดยร้าน' }

function Board({ restaurantId, owner }: { restaurantId: string; owner: boolean }) {
  const [members, setMembers] = useState<Member[]>([])
  const searchSeq = useRef(0)
  const ledgerSeq = useRef(0)
  const selectedId = useRef<string | null>(null)
  const adjusting = useRef(false)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Member | null>(null)
  const [ledger, setLedger] = useState<LedgerRow[]>([])
  const [change, setChange] = useState('')
  const [note, setNote] = useState('')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    const seq = ++searchSeq.current
    const digits = search.replace(/\D/g, '')
    let q = supabase.from('members').select('id,phone,name,points,created_at').eq('restaurant_id', restaurantId)
    if (/^[+\d\s()-]+$/.test(search) && digits) q = q.like('phone', `%${digits}%`)
    else if (search.trim()) q = q.ilike('name', `%${search.trim().replace(/[%_]/g, '')}%`)
    const { data, error } = await q.order('points', { ascending: false }).limit(200)
    if (seq !== searchSeq.current) return
    if (error) { setMembers([]); return setMessage({ ok: false, text: 'โหลดสมาชิกไม่ได้: ' + error.message }) }
    setMembers(data as Member[])
  }, [restaurantId, search])

  useEffect(() => {
    void load()
    return () => { searchSeq.current++ }
  }, [load])

  const loadLedger = useCallback(async (m: Member) => {
    const seq = ++ledgerSeq.current
    setLedger([])
    const { data, error } = await supabase.from('point_ledger').select('id,change,reason,note,created_at').eq('member_id', m.id).order('created_at', { ascending: false }).limit(50)
    if (seq !== ledgerSeq.current || selectedId.current !== m.id) return
    if (error) return setMessage({ ok: false, text: error.message })
    setLedger((data as LedgerRow[]) ?? [])
  }, [])

  function open(m: Member) {
    selectedId.current = m.id
    setSelected(m)
    setChange('')
    setNote('')
    void loadLedger(m)
  }

  async function adjust(e: FormEvent) {
    e.preventDefault()
    if (!selected || adjusting.current) return
    const n = Math.round(Number(change))
    if (!n) return setMessage({ ok: false, text: 'ใส่จำนวนแต้ม (บวก = เพิ่ม, ลบ = หัก)' })
    if (!note.trim()) return setMessage({ ok: false, text: 'ต้องใส่เหตุผลทุกครั้ง' })
    adjusting.current = true
    setBusy(true)
    const id = selected.id
    const { data, error } = await supabase.rpc('member_adjust_points', { p_member_id: selected.id, p_change: n, p_note: note.trim() })
    adjusting.current = false
    setBusy(false)
    if (selectedId.current !== id) { void load(); return }
    if (error) return setMessage({ ok: false, text: error.message.includes('points_check') ? 'หักเกินแต้มที่มีไม่ได้' : error.message })
    setMessage({ ok: true, text: `ปรับแต้มแล้ว คงเหลือ ${data} แต้ม` })
    const updated = { ...selected, points: data as number }
    setSelected(updated)
    setChange('')
    setNote('')
    void load()
    void loadLedger(updated)
  }

  return (
    <div className="page">
      <h1 className="page-title mb-5">{translateUi("สมาชิกสะสมแต้ม")}</h1>
      {message && <p className={message.ok ? 'alert-success' : 'alert-error'}>{message.text}</p>}
      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <section>
          <input className="input mb-3 w-full" placeholder={translateUi("ค้นหาเบอร์โทรหรือชื่อ")} value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="table-wrap">
            <table className="w-full text-left text-sm [&_td]:px-3 [&_td]:py-2.5 [&_th]:px-3 [&_th]:py-2.5">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th>{translateUi("เบอร์โทร")}</th>
                  <th>{translateUi("ชื่อ")}</th>
                  <th className="text-right">{translateUi("แต้ม")}</th>
                  <th>{translateUi("สมัครเมื่อ")}</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr
                    key={m.id}
                    className={`cursor-pointer border-t hover:bg-gray-50 ${selected?.id === m.id ? 'bg-brand-50' : ''}`}
                    onClick={() => open(m)}
                  >
                    <td className="tabular-nums"><button type="button" onClick={(e) => { e.stopPropagation(); open(m) }}>{m.phone}</button></td>
                    <td>{m.name ?? '-'}</td>
                    <td className="num font-semibold">{m.points.toLocaleString('th-TH')}</td>
                    <td className="text-gray-500">{new Date(m.created_at).toLocaleDateString('th-TH')}</td>
                  </tr>
                ))}
                {members.length === 0 && (
                  <tr>
                    <td colSpan={4} className="empty-cell">
                      {search ? 'ไม่พบสมาชิก' : 'ยังไม่มีสมาชิก · สมัครได้ที่หน้ารับชำระ'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card h-fit">
          {!selected ? (
            <p className="text-sm text-gray-500">{translateUi("เลือกสมาชิกเพื่อดูประวัติแต้ม")}</p>
          ) : (
            <>
              <h2 className="section-title mb-1">{selected.name ?? selected.phone}</h2>
              <p className="text-sm text-gray-500">
                {selected.phone}{" " + translateUi("· คงเหลือ") + " "}<strong className="text-gray-900">{selected.points.toLocaleString('th-TH')}</strong>{" " + translateUi("แต้ม") + " "}</p>
              <form onSubmit={(e) => void adjust(e)} className="mt-4 grid gap-2">
                <div className="grid grid-cols-[110px_1fr] gap-2">
                  <input className="input" type="number" step={1} placeholder="+50 / -20" value={change} onChange={(e) => setChange(e.target.value)} />
                  <input className="input" maxLength={200} placeholder={translateUi("เหตุผล เช่น ชดเชยอาหารช้า")} value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
                <button disabled={busy} className="btn btn-secondary btn-sm">{translateUi("ปรับแต้ม")}</button>
              </form>
              {owner && <MemberPrivacyActions key={selected.id} restaurantId={restaurantId} memberId={selected.id} onDeleted={() => { selectedId.current = null; ledgerSeq.current++; setSelected(null); setLedger([]); void load() }} />}
              <h3 className="mt-5 mb-2 text-sm strong-text">{translateUi("ประวัติล่าสุด")}</h3>
              <ul className="divide-y text-sm">
                {ledger.map((l) => (
                  <li key={l.id} className="flex items-start justify-between gap-2 py-2">
                    <span>
                      <span className="block text-gray-800">{translateUi(REASON[l.reason])}</span>
                      <span className="block hint">
                        {new Date(l.created_at).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' })}
                        {l.note ? ` · ${l.note}` : ''}
                      </span>
                    </span>
                    <span className={`font-semibold tabular-nums ${l.change > 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                      {l.change > 0 ? '+' : ''}
                      {l.change}
                    </span>
                  </li>
                ))}
                {ledger.length === 0 && <li className="py-2 text-gray-400">{translateUi("ยังไม่มีประวัติ")}</li>}
              </ul>
            </>
          )}
        </section>
      </div>
    </div>
  )
}

export default function Members() {
  return <RequireRole roles={rolesFor('/members')}>{(ctx) => <Board restaurantId={ctx.restaurantId} owner={ctx.roles.includes('owner')} />}</RequireRole>
}
