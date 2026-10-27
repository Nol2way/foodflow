import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { api } from '../lib/api'
import { rolesFor, type Role } from '../lib/roles'
import { baht } from '../lib/format'
import { changePct, reportText, thaiDate, type DailyReport } from '../lib/report'
import RequireRole from '../components/RequireRole'
import Icon from '../components/Icon'

// รายงานสรุปรายวัน (daily_report ใน 0018) · แชร์เข้า LINE เอง หรือให้ backend ส่งเข้า LINE ร้าน

const today = () => new Date().toLocaleDateString('sv-SE')

function Board({ restaurantId, myRoles }: { restaurantId: string; myRoles: Role[] }) {
  const [date, setDate] = useState(today)
  const [report, setReport] = useState<DailyReport | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [sending, setSending] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('daily_report', { p_restaurant_id: restaurantId, p_date: date })
    if (error) return setMessage({ ok: false, text: 'โหลดรายงานไม่ได้ (ต้องรัน migration 0018 ก่อน)' })
    setReport(data as DailyReport)
  }, [restaurantId, date])

  useEffect(() => {
    void load()
  }, [load])

  const text = report ? reportText(report) : ''

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setMessage({ ok: true, text: 'คัดลอกข้อความแล้ว' })
    } catch {
      setMessage({ ok: false, text: 'คัดลอกไม่ได้' })
    }
  }

  async function send() {
    setSending(true)
    try {
      await api('/reports/daily/send', { body: { restaurant_id: restaurantId, date } })
      setMessage({ ok: true, text: 'ส่งรายงานเข้า LINE แล้ว' })
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : 'ส่งไม่สำเร็จ' })
    }
    setSending(false)
  }

  const r = report
  const ch = r ? changePct(Number(r.revenue), Number(r.revenue_last_week)) : null
  const wasteTotal = r ? r.waste.reduce((s, w) => s + Number(w.cost), 0) : 0

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">รายงานรายวัน</h1>
          {r && <p className="page-subtitle">{thaiDate(r.date)}</p>}
        </div>
        <input type="date" className="input" value={date} max={today()} onChange={(e) => setDate(e.target.value || today())} />
      </div>
      {message && <p className={message.ok ? 'alert-success' : 'alert-error'}>{message.text}</p>}

      {r && (
        <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="stat">
                <div className="stat-label">ยอดขาย</div>
                <div className="stat-value">{baht(Number(r.revenue))}</div>
                {ch !== null && <div className={`text-xs font-medium ${ch >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{ch >= 0 ? '+' : ''}{ch}% จากสัปดาห์ก่อน</div>}
              </div>
              <div className="stat">
                <div className="stat-label">จำนวนบิล</div>
                <div className="stat-value">{r.orders.toLocaleString('th-TH')}</div>
                {r.cancelled > 0 && <div className="text-xs text-red-600">ยกเลิก {r.cancelled}</div>}
              </div>
              <div className="stat">
                <div className="stat-label">เฉลี่ยต่อบิล</div>
                <div className="stat-value">{r.orders ? baht(Math.round(Number(r.revenue) / r.orders)) : '-'}</div>
              </div>
              <div className="stat">
                <div className="stat-label">ส่วนลดรวม</div>
                <div className="stat-value">{baht(Number(r.discount))}</div>
              </div>
            </div>

            <section className="card">
              <h2 className="section-title">เมนูขายดี</h2>
              {r.top_items.length === 0 ? (
                <p className="text-sm text-gray-400">ยังไม่มี</p>
              ) : (
                <ol className="space-y-1 text-sm">
                  {r.top_items.map((t, i) => (
                    <li key={t.name} className="flex justify-between gap-2">
                      <span>
                        {i + 1}. {t.name}
                      </span>
                      <span className="tabular-nums text-gray-600">
                        {t.quantity} ที่ · {baht(Number(t.amount))}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <div className="grid gap-5 sm:grid-cols-2">
              <section className="card">
                <h2 className="section-title">วิธีชำระ</h2>
                {Object.keys(r.payments).length === 0 ? (
                  <p className="text-sm text-gray-400">ยังไม่มี</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {Object.entries(r.payments).map(([k, v]) => (
                      <li key={k} className="flex justify-between">
                        <span>{{ cash: 'เงินสด', promptpay: 'พร้อมเพย์', card: 'บัตร', other: 'อื่นๆ' }[k] ?? 'ไม่ระบุ'}</span>
                        <span className="tabular-nums">{baht(Number(v))}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {r.peak_hour !== null && <p className="mt-3 text-sm text-gray-600">ช่วงคนเยอะสุด {String(r.peak_hour).padStart(2, '0')}:00</p>}
              </section>
              <section className="card">
                <h2 className="section-title">ของเสีย {wasteTotal > 0 && <span className="text-red-600">{baht(wasteTotal)}</span>}</h2>
                {r.waste.length === 0 ? (
                  <p className="text-sm text-gray-400">ไม่มีบันทึกของเสีย</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {r.waste.map((w) => (
                      <li key={w.name} className="flex justify-between gap-2">
                        <span>
                          {w.name} {Number(w.quantity).toLocaleString('th-TH')} {w.unit}
                        </span>
                        <span className="tabular-nums">{baht(Number(w.cost))}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-3 text-sm text-gray-600">
                  รายจ่ายที่บันทึกวันนี้ {baht(Number(r.expenses))} · สมาชิกใหม่ {r.new_members} คน
                </p>
              </section>
            </div>
          </div>

          <section className="card h-fit">
            <h2 className="section-title">ข้อความสำหรับ LINE</h2>
            <pre className="max-h-96 overflow-auto rounded-xl bg-gray-50 p-3 font-sans text-sm whitespace-pre-wrap text-gray-800">{text}</pre>
            <div className="mt-3 grid gap-2">
              <a className="btn btn-success" href={`https://line.me/R/share?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">
                แชร์เข้า LINE
              </a>
              <button className="btn btn-secondary" onClick={() => void copy()}>
                คัดลอกข้อความ
              </button>
              {(myRoles.includes('owner') || myRoles.includes('manager')) && (
                <button className="btn btn-ghost" disabled={sending} onClick={() => void send()} title="ส่งผ่าน LINE Official Account ของร้าน (ตั้งค่าที่หน้าตั้งค่าร้าน)">
                  <Icon name="report" className="h-4 w-4" />
                  {sending ? 'กำลังส่ง...' : 'ส่งเข้า LINE ร้านตอนนี้'}
                </button>
              )}
            </div>
            <p className="mt-2 text-xs text-gray-500">ร้านที่ตั้ง LINE ไว้ ระบบส่งให้อัตโนมัติทุกวันตอน 22:00</p>
          </section>
        </div>
      )}
    </div>
  )
}

export default function Report() {
  return <RequireRole roles={rolesFor('/report')}>{(ctx) => <Board restaurantId={ctx.restaurantId} myRoles={ctx.roles} />}</RequireRole>
}
