import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { rolesFor } from '../lib/roles'
import RequireRole from '../components/RequireRole'
import type { Member } from '../lib/types'

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

function Board({ restaurantId }: { restaurantId: string }) {
  const [members, setMembers] = useState<Member[]>([])
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Member | null>(null)
  const [ledger, setLedger] = useState<LedgerRow[]>([])
  const [change, setChange] = useState('')
  const [note, setNote] = useState('')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    const digits = search.replace(/\D/g, '')
    let q = supabase.from('members').select('id,phone,name,points,created_at').eq('restaurant_id', restaurantId)
    if (digits) q = q.like('phone', `%${digits}%`)
    else if (search.trim()) q = q.ilike('name', `%${search.trim().replace(/[%_]/g, '')}%`)
    const { data, error } = await q.order('points', { ascending: false }).limit(200)
    if (error) return setMessage({ ok: false, text: 'โหลดสมาชิกไม่ได้ (ต้องรัน migration 0017 ก่อน)' })
    setMembers(data as Member[])
  }, [restaurantId, search])

  useEffect(() => {
    void load()
  }, [load])

  const loadLedger = useCallback(async (m: Member) => {
    const { data } = await supabase.from('point_ledger').select('id,change,reason,note,created_at').eq('member_id', m.id).order('created_at', { ascending: false }).limit(50)
    setLedger((data as LedgerRow[]) ?? [])
  }, [])

  function open(m: Member) {
    setSelected(m)
    setChange('')
    setNote('')
    void loadLedger(m)
  }

  async function adjust(e: FormEvent) {
    e.preventDefault()
    if (!selected) return
    const n = Math.round(Number(change))
    if (!n) return setMessage({ ok: false, text: 'ใส่จำนวนแต้ม (บวก = เพิ่ม, ลบ = หัก)' })
    if (!note.trim()) return setMessage({ ok: false, text: 'ต้องใส่เหตุผลทุกครั้ง' })
    const { data, error } = await supabase.rpc('member_adjust_points', { p_member_id: selected.id, p_change: n, p_note: note.trim() })
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
      <h1 className="page-title mb-5">สมาชิกสะสมแต้ม</h1>
      {message && <p className={message.ok ? 'alert-success' : 'alert-error'}>{message.text}</p>}
      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <section>
          <input className="input mb-3 w-full" placeholder="ค้นหาเบอร์โทรหรือชื่อ" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="card-flush overflow-x-auto">
            <table className="w-full text-left text-sm [&_td]:px-3 [&_td]:py-2.5 [&_th]:px-3 [&_th]:py-2.5">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th>เบอร์โทร</th>
                  <th>ชื่อ</th>
                  <th className="text-right">แต้ม</th>
                  <th>สมัครเมื่อ</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr
                    key={m.id}
                    className={`cursor-pointer border-t hover:bg-gray-50 ${selected?.id === m.id ? 'bg-brand-50' : ''}`}
                    onClick={() => open(m)}
                  >
                    <td className="tabular-nums">{m.phone}</td>
                    <td>{m.name ?? '-'}</td>
                    <td className="text-right font-semibold tabular-nums">{m.points.toLocaleString('th-TH')}</td>
                    <td className="text-gray-500">{new Date(m.created_at).toLocaleDateString('th-TH')}</td>
                  </tr>
                ))}
                {members.length === 0 && (
                  <tr>
                    <td colSpan={4} className="p-6 text-center text-gray-400">
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
            <p className="text-sm text-gray-500">เลือกสมาชิกเพื่อดูประวัติแต้ม</p>
          ) : (
            <>
              <h2 className="section-title mb-1">{selected.name ?? selected.phone}</h2>
              <p className="text-sm text-gray-500">
                {selected.phone} · คงเหลือ <strong className="text-gray-900">{selected.points.toLocaleString('th-TH')}</strong> แต้ม
              </p>
              <form onSubmit={(e) => void adjust(e)} className="mt-4 grid gap-2">
                <div className="grid grid-cols-[110px_1fr] gap-2">
                  <input className="input" type="number" step={1} placeholder="+50 / -20" value={change} onChange={(e) => setChange(e.target.value)} />
                  <input className="input" maxLength={200} placeholder="เหตุผล เช่น ชดเชยอาหารช้า" value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
                <button className="btn btn-secondary btn-sm">ปรับแต้ม</button>
              </form>
              <h3 className="mt-5 mb-2 text-sm font-semibold text-gray-900">ประวัติล่าสุด</h3>
              <ul className="divide-y text-sm">
                {ledger.map((l) => (
                  <li key={l.id} className="flex items-start justify-between gap-2 py-2">
                    <span>
                      <span className="block text-gray-800">{REASON[l.reason]}</span>
                      <span className="block text-xs text-gray-500">
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
                {ledger.length === 0 && <li className="py-2 text-gray-400">ยังไม่มีประวัติ</li>}
              </ul>
            </>
          )}
        </section>
      </div>
    </div>
  )
}

export default function Members() {
  return <RequireRole roles={rolesFor('/members')}>{(ctx) => <Board restaurantId={ctx.restaurantId} />}</RequireRole>
}
