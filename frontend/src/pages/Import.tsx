import { confirmAction } from '../lib/alerts'
import { translateUi } from "../lib/uiText"
import { useRef, useState, type ChangeEvent } from 'react'
import { rolesFor } from '../lib/roles'
import { ApiError, api, apiMessage } from '../lib/api'
import RequireRole from '../components/RequireRole'

interface ImportResult {
  preview_token?: string
  batch_id: string | null
  dry_run: boolean
  blocked: boolean
  orders: number
  lines: number
  skipped_lines: number
  unknown_items: string[]
}
interface RowError {
  line: number
  message: string
}

const MAX_BYTES = 3_000_000

function Board({ restaurantId }: { restaurantId: string }) {
  const version = useRef(0)
  const previewVersion = useRef(-1)
  const running = useRef(false)
  const [fileName, setFileName] = useState('')
  const [csv, setCsv] = useState('')
  const [format, setFormat] = useState<'csv' | 'xlsx'>('csv')
  const [skipUnknown, setSkipUnknown] = useState(false)
  const [preview, setPreview] = useState<ImportResult | null>(null)
  const [done, setDone] = useState<ImportResult | null>(null)
  const [rowErrors, setRowErrors] = useState<RowError[]>([])
  const [errorCount, setErrorCount] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [committing, setCommitting] = useState(false)

  function reset() {
    setPreview(null)
    setDone(null)
    setRowErrors([])
    setErrorCount(0)
    setMessage(null)
  }

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const v = ++version.current
    reset()
    setCsv('')
    setFileName('')
    const f = e.target.files?.[0]
    if (!f) return
    if (!/\.(csv|xlsx)$/i.test(f.name)) { setMessage('รองรับไฟล์ .csv และ .xlsx เท่านั้น'); return }
    if (f.size > MAX_BYTES) {
      setMessage('ไฟล์ใหญ่เกิน 3 MB กรุณาแบ่งไฟล์')
      return
    }
    try {
      const kind = /\.xlsx$/i.test(f.name) ? 'xlsx' : 'csv'
      let text: string
      if (kind === 'xlsx') {
        const bytes = new Uint8Array(await f.arrayBuffer())
        let binary = ''
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
        text = btoa(binary)
      } else text = await f.text()
      if (v !== version.current) return
      setFormat(kind)
      setFileName(f.name)
      setCsv(text)
    } catch { if (v === version.current) setMessage('อ่านไฟล์ไม่ได้ กรุณาเลือกใหม่') }
  }

  async function run(dryRun: boolean) {
    if (running.current || !csv || (!dryRun && previewVersion.current !== version.current)) return
    running.current = true
    setCommitting(!dryRun)
    const v = version.current
    setBusy(true)
    setMessage(null)
    setRowErrors([])
    try {
      const res = await api<ImportResult>('/import/sales', {
        body: { restaurant_id: restaurantId, ...(format === 'xlsx' ? { xlsx_base64: csv } : { csv }), dry_run: dryRun, skip_unknown: skipUnknown, preview_token: dryRun ? undefined : preview?.preview_token },
      })
      if (v !== version.current) return
      if (dryRun) { previewVersion.current = v; setPreview(res) }
      else {
        setDone(res)
        setPreview(null)
      }
    } catch (e) {
      if (v !== version.current) return
      if (e instanceof ApiError && e.code === 'invalid_rows') {
        setRowErrors((e.data.errors as RowError[]) ?? [])
        setErrorCount(Number(e.data.error_count ?? 0))
        setMessage('ไฟล์มีแถวที่ไม่ถูกต้อง แก้ไขแล้วเลือกไฟล์ใหม่ (ยังไม่ได้นำเข้าข้อมูลใดๆ)')
      } else setMessage(apiMessage(e))
    } finally {
      running.current = false
      setCommitting(false)
      setBusy(false)
    }
  }

  async function undo() {
    if (!done?.batch_id || running.current) return
    if (!await confirmAction(`ลบออเดอร์ที่นำเข้ารอบนี้ทั้งหมด ${done.orders} ออเดอร์?`)) return
    running.current = true
    setBusy(true)
    try {
      const r = await api<{ deleted_orders: number }>(`/import/${done.batch_id}?restaurant_id=${restaurantId}`, { method: 'DELETE' })
      setMessage(`ลบแล้ว ${r.deleted_orders} ออเดอร์`)
      setDone(null)
    } catch (e) {
      setMessage(apiMessage(e))
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  const canImport = previewVersion.current === version.current && preview && preview.orders > 0 && !preview.blocked

  return (
    <div className="page-narrow">
      <h1 className="page-title">{translateUi("นำเข้ายอดขายย้อนหลัง (CSV / Excel)")}</h1>
      <p className="mb-4 text-sm text-gray-600">{"" + translateUi("ใช้ข้อมูลจาก POS เดิมหรือสมุดจด เพื่อให้หน้าวิเคราะห์มีข้อมูลตั้งแต่วันแรก ออเดอร์ที่นำเข้าจะเป็นสถานะ \"ชำระแล้ว\" และ") + " "}<b>{translateUi("ไม่ตัดสต็อก")}</b> / <a className="link" href="/sample-sales.csv" download>{translateUi("ดาวน์โหลดไฟล์ตัวอย่าง")}</a>
      </p>

      <div className="card text-sm">
        <p className="mb-2 font-medium">{translateUi("รูปแบบไฟล์")}</p>
        <ul className="list-disc space-y-1 pl-5 text-gray-600">
          <li>{"" + translateUi("คอลัมน์ที่ต้องมี:") + " "}<code>datetime</code>{" " + translateUi("(หรือ") + " "}<code>date</code> + <code>time</code>), <code>item</code>, <code>qty</code></li>
          <li>{"" + translateUi("ไม่บังคับ:") + " "}<code>ref</code>{" " + translateUi("(เลขที่บิล แถวที่เลขบิลเดียวกันในวันเดียวกันรวมเป็น 1 ออเดอร์),") + " "}<code>price</code>{" " + translateUi("(ไม่ใส่ = ราคาเมนูปัจจุบัน)") + ""}</li>
          <li>{"" + translateUi("วันที่") + " "}<code>2026-09-01</code>{" " + translateUi("หรือ") + " "}<code>01/09/2569</code>{" " + translateUi("/ เวลาเป็นเวลาท้องถิ่นของร้าน") + ""}</li>
          <li>{translateUi("ชื่อเมนูต้องตรงกับในระบบ (ไม่สนตัวพิมพ์เล็ก/ใหญ่)")}</li>
          <li>{translateUi("Excel .xlsx ต้องมีแผ่นงานเดียว ใช้หัวคอลัมน์เดียวกับ CSV และตรวจตัวอย่างก่อนนำเข้า")}</li>
        </ul>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input aria-label={translateUi("ไฟล์ CSV หรือ Excel")} disabled={committing || (busy && Boolean(done))} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={pick} className="text-sm" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" disabled={committing} checked={skipUnknown} onChange={(e) => { version.current++; setSkipUnknown(e.target.checked); setPreview(null) }} />{"" + translateUi("ข้ามแถวที่ชื่อเมนูไม่ตรงกับในระบบ") + " "}</label>
      </div>

      <div className="mt-4 flex gap-2">
        <button className="btn btn-secondary disabled:opacity-50" disabled={!csv || busy} onClick={() => void run(true)}>{"" + translateUi("ตรวจไฟล์ก่อนนำเข้า") + " "}</button>
        <button className="btn btn-primary" disabled={!canImport || busy} onClick={() => void run(false)}>{"" + translateUi("นำเข้า") + " "}</button>
      </div>

      {message && <p className="alert-warn mt-4 mb-0">{message}</p>}

      {rowErrors.length > 0 && (
        <div className="mt-3 overflow-hidden rounded-xl border border-red-200">
          <p className="bg-red-50 p-2 text-sm text-red-700">{"" + translateUi("พบ") + " "}{errorCount}{" " + translateUi("แถวที่ผิด") + ""}{errorCount > rowErrors.length ? ` (แสดง ${rowErrors.length} แถวแรก)` : ''}</p>
          <ul className="max-h-64 divide-y overflow-y-auto text-sm">
            {rowErrors.map((r) => (
              <li key={r.line} className="p-2">{"" + translateUi("บรรทัด") + " "}{r.line}: {r.message}</li>
            ))}
          </ul>
        </div>
      )}

      {preview && (
        <div className="card mt-4 text-sm">
          <p className="font-medium">{"" + translateUi("ผลตรวจ") + " "}{fileName}</p>
          <p>{"" + translateUi("จะนำเข้า") + " "}{preview.orders}{" " + translateUi("ออเดอร์ /") + " "}{preview.lines}{" " + translateUi("รายการ") + ""}{preview.skipped_lines > 0 && ` / ข้าม ${preview.skipped_lines} แถว`}</p>
          {preview.unknown_items.length > 0 && (
            <p className={`mt-2 ${preview.blocked ? 'text-red-600' : 'text-gray-600'}`}>{"" + translateUi("ชื่อเมนูที่ไม่พบในระบบ:") + " "}{preview.unknown_items.join(', ')}
              {preview.blocked && ' - แก้ชื่อในไฟล์ให้ตรง หรือติ๊ก "ข้ามแถว..." แล้วตรวจใหม่'}
            </p>
          )}
        </div>
      )}

      {done && (
        <div className="alert-success mt-4 mb-0">
          <p className="font-semibold text-emerald-800">{"" + translateUi("นำเข้าแล้ว") + " "}{done.orders}{" " + translateUi("ออเดอร์ /") + " "}{done.lines}{" " + translateUi("รายการ") + ""}</p>
          <p className="mt-1 text-gray-600">{"" + translateUi("รหัสรอบนำเข้า:") + " "}<code>{done.batch_id}</code></p>
          <button className="link-danger mt-2" disabled={busy} onClick={() => void undo()}>{"" + translateUi("ย้อนการนำเข้ารอบนี้") + " "}</button>
        </div>
      )}
    </div>
  )
}

export default function ImportPage() {
  return <RequireRole roles={rolesFor('/import')}>{(ctx) => <Board restaurantId={ctx.restaurantId} />}</RequireRole>
}
