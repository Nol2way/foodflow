import { useState, type ChangeEvent } from 'react'
import { rolesFor } from '../lib/roles'
import { ApiError, api, apiMessage } from '../lib/api'
import RequireRole from '../components/RequireRole'

interface ImportResult {
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
  const [fileName, setFileName] = useState('')
  const [csv, setCsv] = useState('')
  const [skipUnknown, setSkipUnknown] = useState(false)
  const [preview, setPreview] = useState<ImportResult | null>(null)
  const [done, setDone] = useState<ImportResult | null>(null)
  const [rowErrors, setRowErrors] = useState<RowError[]>([])
  const [errorCount, setErrorCount] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function reset() {
    setPreview(null)
    setDone(null)
    setRowErrors([])
    setErrorCount(0)
    setMessage(null)
  }

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    reset()
    const f = e.target.files?.[0]
    if (!f) return
    if (f.size > MAX_BYTES) {
      setMessage('ไฟล์ใหญ่เกิน 3 MB กรุณาแบ่งไฟล์')
      return
    }
    setFileName(f.name)
    setCsv(await f.text())
  }

  async function run(dryRun: boolean) {
    setBusy(true)
    setMessage(null)
    setRowErrors([])
    try {
      const res = await api<ImportResult>('/import/sales', {
        body: { restaurant_id: restaurantId, csv, dry_run: dryRun, skip_unknown: skipUnknown },
      })
      if (dryRun) setPreview(res)
      else {
        setDone(res)
        setPreview(null)
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_rows') {
        setRowErrors((e.data.errors as RowError[]) ?? [])
        setErrorCount(Number(e.data.error_count ?? 0))
        setMessage('ไฟล์มีแถวที่ไม่ถูกต้อง แก้ไขแล้วเลือกไฟล์ใหม่ (ยังไม่ได้นำเข้าข้อมูลใดๆ)')
      } else setMessage(apiMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function undo() {
    if (!done?.batch_id) return
    if (!window.confirm(`ลบออเดอร์ที่นำเข้ารอบนี้ทั้งหมด ${done.orders} ออเดอร์?`)) return
    setBusy(true)
    try {
      const r = await api<{ deleted_orders: number }>(`/import/${done.batch_id}?restaurant_id=${restaurantId}`, { method: 'DELETE' })
      setMessage(`ลบแล้ว ${r.deleted_orders} ออเดอร์`)
      setDone(null)
    } catch (e) {
      setMessage(apiMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const canImport = preview && preview.orders > 0 && !preview.blocked

  return (
    <div className="page-narrow">
      <h1 className="page-title">นำเข้ายอดขายย้อนหลัง (CSV)</h1>
      <p className="mb-4 text-sm text-gray-600">
        ใช้ข้อมูลจาก POS เดิมหรือสมุดจด เพื่อให้หน้าวิเคราะห์มีข้อมูลตั้งแต่วันแรก ออเดอร์ที่นำเข้าจะเป็นสถานะ "ชำระแล้ว" และ
        <b>ไม่ตัดสต็อก</b> · <a className="link" href="/sample-sales.csv" download>ดาวน์โหลดไฟล์ตัวอย่าง</a>
      </p>

      <div className="card text-sm">
        <p className="mb-2 font-medium">รูปแบบไฟล์</p>
        <ul className="list-disc space-y-1 pl-5 text-gray-600">
          <li>คอลัมน์ที่ต้องมี: <code>datetime</code> (หรือ <code>date</code> + <code>time</code>), <code>item</code>, <code>qty</code></li>
          <li>ไม่บังคับ: <code>ref</code> (เลขที่บิล แถวที่เลขบิลเดียวกันในวันเดียวกันรวมเป็น 1 ออเดอร์), <code>price</code> (ไม่ใส่ = ราคาเมนูปัจจุบัน)</li>
          <li>วันที่ <code>2026-09-01</code> หรือ <code>01/09/2569</code> · เวลาเป็นเวลาท้องถิ่นของร้าน</li>
          <li>ชื่อเมนูต้องตรงกับในระบบ (ไม่สนตัวพิมพ์เล็ก/ใหญ่)</li>
        </ul>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input type="file" accept=".csv,text/csv" onChange={pick} className="text-sm" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={skipUnknown} onChange={(e) => { setSkipUnknown(e.target.checked); setPreview(null) }} />
          ข้ามแถวที่ชื่อเมนูไม่ตรงกับในระบบ
        </label>
      </div>

      <div className="mt-4 flex gap-2">
        <button className="btn btn-secondary disabled:opacity-50" disabled={!csv || busy} onClick={() => void run(true)}>
          ตรวจไฟล์ก่อนนำเข้า
        </button>
        <button className="btn btn-primary" disabled={!canImport || busy} onClick={() => void run(false)}>
          นำเข้า
        </button>
      </div>

      {message && <p className="alert-warn mt-4 mb-0">{message}</p>}

      {rowErrors.length > 0 && (
        <div className="mt-3 overflow-hidden rounded-xl border border-red-200">
          <p className="bg-red-50 p-2 text-sm text-red-700">พบ {errorCount} แถวที่ผิด{errorCount > rowErrors.length ? ` (แสดง ${rowErrors.length} แถวแรก)` : ''}</p>
          <ul className="max-h-64 divide-y overflow-y-auto text-sm">
            {rowErrors.map((r) => (
              <li key={r.line} className="p-2">บรรทัด {r.line}: {r.message}</li>
            ))}
          </ul>
        </div>
      )}

      {preview && (
        <div className="card mt-4 text-sm">
          <p className="font-medium">ผลตรวจ {fileName}</p>
          <p>จะนำเข้า {preview.orders} ออเดอร์ / {preview.lines} รายการ{preview.skipped_lines > 0 && ` · ข้าม ${preview.skipped_lines} แถว`}</p>
          {preview.unknown_items.length > 0 && (
            <p className={`mt-2 ${preview.blocked ? 'text-red-600' : 'text-gray-600'}`}>
              ชื่อเมนูที่ไม่พบในระบบ: {preview.unknown_items.join(', ')}
              {preview.blocked && ' — แก้ชื่อในไฟล์ให้ตรง หรือติ๊ก "ข้ามแถว..." แล้วตรวจใหม่'}
            </p>
          )}
        </div>
      )}

      {done && (
        <div className="alert-success mt-4 mb-0">
          <p className="font-semibold text-emerald-800">นำเข้าแล้ว {done.orders} ออเดอร์ / {done.lines} รายการ</p>
          <p className="mt-1 text-gray-600">รหัสรอบนำเข้า: <code>{done.batch_id}</code></p>
          <button className="link-danger mt-2" disabled={busy} onClick={() => void undo()}>
            ย้อนการนำเข้ารอบนี้
          </button>
        </div>
      )}
    </div>
  )
}

export default function ImportPage() {
  return <RequireRole roles={rolesFor('/import')}>{(ctx) => <Board restaurantId={ctx.restaurantId} />}</RequireRole>
}
