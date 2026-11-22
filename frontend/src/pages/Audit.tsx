import { useEffect, useRef, useState } from 'react'
import RequireRole from '../components/RequireRole'
import { supabase } from '../lib/supabase'
import { useText } from '../lib/preferences'
import Pagination from '../components/Pagination'

type Event = { id: number; created_at: string; actor_id: string | null; action: string; entity: string; record_id: string; details: unknown }
function Board({ restaurantId }: { restaurantId: string }) {
  const text = useText()
  const seq = useRef(0)
  const [rows, setRows] = useState<Event[]>([])
  const [busy, setBusy] = useState(false)
  const [more, setMore] = useState(true)
  const [error, setError] = useState('')
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(10)
  const [cursors, setCursors] = useState<(number | null)[]>([null])
  async function load(before: number | null = null, targetPage = 0) {
    const current = ++seq.current
    setBusy(true); setError('')
    const result = await supabase.rpc('audit_events', { p_restaurant_id: restaurantId, p_before: before, p_limit: pageSize + 1 })
    if (seq.current !== current) return
    setBusy(false)
    if (result.error) { setError(text('โหลดประวัติไม่สำเร็จ', 'Could not load audit history')); return }
    const events = (result.data ?? []) as Event[]
    setRows(events.slice(0, pageSize)); setMore(events.length > pageSize); setPage(targetPage)
    setCursors(previous => [...previous.slice(0, targetPage), before])
  }
  useEffect(() => { setRows([]); setPage(0); setCursors([null]); void load(); return () => { seq.current++ } }, [restaurantId, pageSize])
  return <div className="page"><h1 className="page-title">{text('ประวัติการเปลี่ยนแปลง', 'Audit history')}</h1>
    <p className="hint">{text('อ่านได้เฉพาะเจ้าของและผู้จัดการ ประวัติแก้ไขหรือลบผ่านแอปไม่ได้ และไม่แสดงรหัสผ่านหรือข้อมูลสมาชิก', 'Only owners and managers can view this history. The app cannot modify or delete it. Passwords and member data are not shown.')}</p>
    <button disabled={busy} className="btn btn-secondary my-3" onClick={() => void load()}>{text('โหลดใหม่', 'Refresh')}</button>
    {error && <p role="alert">{error}</p>}
    <Pagination label={text('แบ่งหน้าประวัติ', 'Audit pagination')} page={page} pageSize={pageSize} count={rows.length} hasNext={more} loading={busy} onPageSizeChange={setPageSize}
      onPrevious={() => void load(cursors[page - 1], page - 1)} onNext={() => void load(rows.at(-1)!.id, page + 1)} />
    <div className="table-wrap history-scroll"><table className="w-full text-left text-sm"><thead><tr><th>{text('เวลา', 'Time')}</th><th>{text('ผู้ทำ', 'Actor')}</th><th>{text('การเปลี่ยนแปลง', 'Action')}</th><th>{text('รายการ', 'Record')}</th><th>{text('ฟิลด์', 'Fields')}</th></tr></thead><tbody>{rows.map(row => <tr key={row.id} className="border-t"><td className="whitespace-nowrap">{new Date(row.created_at).toLocaleString()}</td><td className="max-w-40 break-all">{row.actor_id ?? 'system'}</td><td>{row.action}</td><td className="max-w-52 break-all">{row.entity} / {row.record_id}</td><td><details><summary className="cursor-pointer">{text('รายละเอียด', 'Details')}</summary><pre className="max-w-60 whitespace-pre-wrap break-all">{JSON.stringify(row.details)}</pre></details></td></tr>)}</tbody></table></div>
    {!busy && !rows.length && <p>{text('ยังไม่มีประวัติ', 'No events yet')}</p>}
  </div>
}
export default function Audit() { return <RequireRole roles={['owner', 'manager']}>{ctx => <Board restaurantId={ctx.restaurantId} />}</RequireRole> }
