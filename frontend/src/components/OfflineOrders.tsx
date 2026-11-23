import { confirmAction } from '../lib/alerts'
import { translateUi } from "../lib/uiText"
import { useEffect, useState } from 'react'
import { onQueueChange, queuedOrders, removeQueuedOrder, sendQueuedOrder, type QueuedOrder } from '../lib/orderQueue'

export default function OfflineOrders({ userId, restaurantId }: { userId: string; restaurantId: string }) {
  const [rows, setRows] = useState<QueuedOrder[]>([])
  const [online, setOnline] = useState(navigator.onLine)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    const load = () => { void queuedOrders(userId, restaurantId).then(value => { if (active) setRows(value) }).catch(() => { if (active) setError('เปิดคิวออฟไลน์ไม่สำเร็จ') }) }
    const connection = () => setOnline(navigator.onLine)
    load()
    const stop = onQueueChange(load)
    window.addEventListener('online', connection)
    window.addEventListener('offline', connection)
    return () => { active = false; stop(); window.removeEventListener('online', connection); window.removeEventListener('offline', connection) }
  }, [userId, restaurantId])
  async function retry() {
    if (busy) return
    setBusy(true); setError('')
    try { for (const row of rows) await sendQueuedOrder(row) }
    catch { setError('ส่งไม่สำเร็จ รายการยังอยู่ในคิว กรุณาตรวจสิทธิ์ ราคา และเมนูก่อนลองใหม่') }
    finally { setBusy(false) }
  }
  if (!rows.length && online && !error) return null
  return <section className="m-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" aria-label={translateUi("คิวออฟไลน์")}>
    <p role="status">{online ? 'เชื่อมต่อแล้ว' : 'ออฟไลน์'}{" " + translateUi("/ ออเดอร์รอส่ง") + " "}{rows.length}{" " + translateUi("รายการ") + ""}</p>
    <p>{translateUi("รายการในคิวยังไม่เข้าครัว ระบบจะตรวจราคาและเมนูอีกครั้งเมื่อส่ง")}</p>
    {error && <p role="alert">{error}</p>}
    {rows.length > 0 && <button className="btn btn-secondary mt-2" disabled={!online || busy} onClick={() => void retry()}>{busy ? 'กำลังส่ง...' : 'ส่งรายการที่ค้าง'}</button>}
    {rows.map(row => <div key={row.id} className="mt-2 flex flex-wrap items-center gap-2">
      <span>{new Date(row.createdAt).toLocaleString('th-TH')} / {row.id.slice(0, 8)}{row.error ? ' / ต้องลองใหม่' : ''}</span>
      <button className="btn btn-ghost" disabled={busy} onClick={async () => { if (await confirmAction('ลบรายการรอส่งนี้? หากเคยส่งแล้วให้ตรวจประวัติบิลก่อนเพื่อไม่สั่งซ้ำ')) void removeQueuedOrder(row.id).catch(() => setError('ลบคิวไม่สำเร็จ')) }}>{translateUi("ลบจากเครื่อง")}</button>
    </div>)}
  </section>
}
