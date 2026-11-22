import { useEffect, useRef, useState } from 'react'
import RequireRole from '../components/RequireRole'
import { supabase } from '../lib/supabase'
import { useText } from '../lib/preferences'

type Event = { id: number; created_at: string; actor_id: string | null; action: string; entity: string; record_id: string; details: unknown }
function Board({ restaurantId }: { restaurantId: string }) {
  const text = useText()
  const seq = useRef(0)
  const [rows, setRows] = useState<Event[]>([])
  const [busy, setBusy] = useState(false)
  const [more, setMore] = useState(true)
  const [error, setError] = useState('')
  async function load(before: number | null = null) {
    const current = ++seq.current
    setBusy(true); setError('')
    const result = await supabase.rpc('audit_events', { p_restaurant_id: restaurantId, p_before: before, p_limit: 100 })
    if (seq.current !== current) return
    setBusy(false)
    if (result.error) { setError(text('โหลดประวัติไม่สำเร็จ', 'Could not load audit history')); return }
    const events = (result.data ?? []) as Event[]
    setRows(previous => before === null ? events : [...previous, ...events]); setMore(events.length === 100)
  }
  useEffect(() => { setRows([]); void load(); return () => { seq.current++ } }, [restaurantId])
  return <div className="page"><h1 className="page-title">{text('ประวัติการเปลี่ยนแปลง', 'Audit history')}</h1>
    <p className="hint">{text('อ่านได้เฉพาะเจ้าของและผู้จัดการ ประวัติแก้ไขหรือลบผ่านแอปไม่ได้ และไม่แสดงรหัสผ่านหรือข้อมูลสมาชิก', 'Only owners and managers can view this history. The app cannot modify or delete it. Passwords and member data are not shown.')}</p>
    <button disabled={busy} className="btn btn-secondary my-3" onClick={() => void load()}>{text('โหลดใหม่', 'Refresh')}</button>
    {error && <p role="alert">{error}</p>}
    <div className="table-wrap"><table className="w-full text-left text-sm"><thead><tr><th>{text('เวลา', 'Time')}</th><th>{text('ผู้ทำ', 'Actor')}</th><th>{text('การเปลี่ยนแปลง', 'Action')}</th><th>{text('รายการ', 'Record')}</th><th>{text('ฟิลด์', 'Fields')}</th></tr></thead><tbody>{rows.map(row => <tr key={row.id} className="border-t"><td>{new Date(row.created_at).toLocaleString()}</td><td>{row.actor_id ?? 'system'}</td><td>{row.action}</td><td>{row.entity} · {row.record_id}</td><td><pre className="whitespace-pre-wrap">{JSON.stringify(row.details)}</pre></td></tr>)}</tbody></table></div>
    {more && rows.length > 0 && <button disabled={busy} className="btn btn-secondary mt-3" onClick={() => void load(rows.at(-1)!.id)}>{text('โหลดเก่ากว่านี้', 'Load older events')}</button>}
    {!busy && !rows.length && <p>{text('ยังไม่มีประวัติ', 'No events yet')}</p>}
  </div>
}
export default function Audit() { return <RequireRole roles={['owner', 'manager']}>{ctx => <Board restaurantId={ctx.restaurantId} />}</RequireRole> }
