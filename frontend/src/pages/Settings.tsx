import { translateUi } from "../lib/uiText"
import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { rolesFor } from '../lib/roles'
import { useShopSettings } from '../lib/shop'
import { promptPayKind } from '../lib/promptpay'
import RequireRole from '../components/RequireRole'
import PromptPayQR from '../components/PromptPayQR'
import type { ShopSettings } from '../lib/types'
import AppearanceSettings from '../components/AppearanceSettings'

// ตั้งค่าร้าน (เจ้าของเท่านั้น · shop_settings ใน 0017): พร้อมเพย์ ใบเสร็จ สะสมแต้ม ผู้รับรายงานทาง LINE

function Board({ restaurantId }: { restaurantId: string }) {
  const { settings, loaded, reload, error: loadError } = useShopSettings(restaurantId)
  const [numbers, setNumbers] = useState({ loyalty_baht_per_point: '', loyalty_point_value: '', loyalty_min_redeem: '' })
  const [f, setF] = useState<ShopSettings | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (settings) {
      setF(settings)
      setNumbers({ loyalty_baht_per_point: String(settings.loyalty_baht_per_point), loyalty_point_value: String(settings.loyalty_point_value), loyalty_min_redeem: String(settings.loyalty_min_redeem) })
    }
  }, [settings])

  if (!settings || !f) {
    return (
      <div className="page-narrow">
        <h1 className="page-title mb-5">{translateUi("ตั้งค่าร้าน")}</h1>
        <button className="btn btn-secondary" onClick={() => void reload()}>{translateUi("ลองใหม่")}</button><p className="empty">{loaded ? (loadError ?? 'โหลดการตั้งค่าไม่ได้ กรุณาลองใหม่') : 'กำลังโหลด...'}</p>
      </div>
    )
  }

  const set = (patch: Partial<ShopSettings>) => setF({ ...f, ...patch })
  const ppDigits = (f.promptpay_id ?? '').replace(/\D/g, '')
  const ppValid = ppDigits === '' || promptPayKind(ppDigits) !== null
  const lineValid = !f.line_to || /^[UCR][0-9a-f]{32}$/.test(f.line_to)

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!f || !ppValid || !lineValid || busy) return
    const values = Object.fromEntries(Object.entries(numbers).map(([k, v]) => [k, Number(v)]))
    if (Object.values(numbers).some((v) => !v.trim()) || !Number.isInteger(values.loyalty_baht_per_point) || values.loyalty_baht_per_point < 1 || values.loyalty_baht_per_point > 10000 || !Number.isFinite(values.loyalty_point_value) || values.loyalty_point_value < 0.01 || values.loyalty_point_value > 1000 || !Number.isInteger(values.loyalty_min_redeem) || values.loyalty_min_redeem < 1 || values.loyalty_min_redeem > 100000) return setMessage({ ok: false, text: 'กรอกค่าการสะสมแต้มให้ครบและอยู่ในช่วงที่กำหนด' })
    setBusy(true)
    const { error } = await supabase.from('shop_settings').upsert({
      restaurant_id: restaurantId,
      promptpay_id: ppDigits || null,
      receipt_header: f.receipt_header?.trim() || null,
      receipt_footer: f.receipt_footer?.trim() || null,
      loyalty_enabled: f.loyalty_enabled,
      loyalty_baht_per_point: values.loyalty_baht_per_point,
      loyalty_point_value: values.loyalty_point_value,
      loyalty_min_redeem: values.loyalty_min_redeem,
      line_to: f.line_to?.trim() || null,
      morning_report_enabled: f.morning_report_enabled ?? false,
      morning_report_hour: f.morning_report_hour ?? 8,
      updated_at: new Date().toISOString(),
    })
    setBusy(false)
    setMessage(error ? { ok: false, text: error.message } : { ok: true, text: 'บันทึกการตั้งค่าแล้ว' })
    if (!error) void reload()
  }

  return (
    <div className="page-narrow">
      <h1 className="page-title mb-5">{translateUi("ตั้งค่าร้าน")}</h1>
      <AppearanceSettings />
      {message && <p className={message.ok ? 'alert-success' : 'alert-error'}>{message.text}</p>}

      <form onSubmit={(e) => void save(e)} className="space-y-6">
        <section className="card">
          <h2 className="section-title">{translateUi("รับเงินด้วยพร้อมเพย์")}</h2>
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <div>
              <label className="label" htmlFor="pp">{"" + translateUi("เลขพร้อมเพย์ของร้าน") + " "}</label>
              <input
                id="pp"
                className="input w-full"
                inputMode="numeric"
                placeholder={translateUi("เบอร์มือถือ 10 หลัก หรือเลขผู้เสียภาษี 13 หลัก")}
                value={f.promptpay_id ?? ''}
                onChange={(e) => set({ promptpay_id: e.target.value })}
              />
              {!ppValid && <p className="mt-1 field-error">{translateUi("ใช้เบอร์มือถือ 10 หลัก เลขบัตร/เลขผู้เสียภาษี 13 หลัก หรือ e-Wallet 15 หลัก")}</p>}
              <p className="mt-2 hint">{"" + translateUi("หน้ารับชำระจะสร้าง QR ใส่ยอดของบิลให้ลูกค้าสแกน · ทดลองสแกน QR ตัวอย่าง (1 บาท) ด้วยแอปธนาคารเพื่อตรวจว่าชื่อบัญชีถูกต้อง ก่อนใช้จริง") + " "}</p>
            </div>
            {ppValid && ppDigits && (
              <div className="w-48">
                <PromptPayQR id={ppDigits} amount={1} size={180} />
              </div>
            )}
          </div>
        </section>

        <section className="card">
          <h2 className="section-title">{translateUi("ใบเสร็จ")}</h2>
          <label className="label" htmlFor="rh">{"" + translateUi("หัวใบเสร็จ (ที่อยู่ เบอร์โทร เลขผู้เสียภาษี)") + " "}</label>
          <textarea id="rh" className="input w-full" rows={3} maxLength={300} value={f.receipt_header ?? ''} onChange={(e) => set({ receipt_header: e.target.value })} />
          <label className="label mt-3" htmlFor="rf">{"" + translateUi("ท้ายใบเสร็จ") + " "}</label>
          <input id="rf" className="input w-full" maxLength={200} placeholder={translateUi("ขอบคุณที่ใช้บริการ")} value={f.receipt_footer ?? ''} onChange={(e) => set({ receipt_footer: e.target.value })} />
        </section>

        <section className="card">
          <h2 className="section-title">{translateUi("สะสมแต้มสมาชิก")}</h2>
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-gray-800">
            <input type="checkbox" className="h-4 w-4 accent-brand-500" checked={f.loyalty_enabled} onChange={(e) => set({ loyalty_enabled: e.target.checked })} />{"" + translateUi("เปิดใช้ระบบสะสมแต้ม (ปิดเมื่อไรก็ได้ แต้มเดิมยังอยู่)") + " "}</label>
          <div className={`mt-3 grid gap-3 sm:grid-cols-3 ${f.loyalty_enabled ? '' : 'opacity-50'}`}>
            <div>
              <label className="label" htmlFor="bpp">{"" + translateUi("จ่ายครบกี่บาท ได้ 1 แต้ม") + " "}</label>
              <input id="bpp" className="input w-full" type="number" min={1} max={10000} value={numbers.loyalty_baht_per_point} onChange={(e) => setNumbers({ ...numbers, loyalty_baht_per_point: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="pv">{"" + translateUi("1 แต้ม ลดได้กี่บาท") + " "}</label>
              <input id="pv" className="input w-full" type="number" min={0.01} max={1000} step={0.01} value={numbers.loyalty_point_value} onChange={(e) => setNumbers({ ...numbers, loyalty_point_value: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="mr">{"" + translateUi("แลกขั้นต่ำ (แต้ม)") + " "}</label>
              <input id="mr" className="input w-full" type="number" min={1} max={100000} value={numbers.loyalty_min_redeem} onChange={(e) => setNumbers({ ...numbers, loyalty_min_redeem: e.target.value })} />
            </div>
          </div>
          <p className="mt-2 hint">{"" + translateUi("ตัวอย่าง: จ่าย 250 บาท ได้") + " "}{Math.floor(250 / f.loyalty_baht_per_point)}{" " + translateUi("แต้ม · สะสม") + " "}{f.loyalty_min_redeem}{" " + translateUi("แต้ม แลกส่วนลดได้") + ""}{' '}
            {(f.loyalty_min_redeem * f.loyalty_point_value).toLocaleString('th-TH')}{" " + translateUi("บาท · แลกแต้มคิดหลังหักโปรแล้ว") + " "}</p>
        </section>

        <section className="card">
          <h2 className="section-title">{translateUi("รายงานรายวันทาง LINE")}</h2>
          <label className="mb-3 flex items-center gap-2"><input type="checkbox" checked={f.morning_report_enabled ?? false} onChange={e => set({ morning_report_enabled: e.target.checked })} />{translateUi("ส่งสรุปตอนเช้า: ยอดเมื่อวาน เมนูขายดี สต็อกต่ำ และล็อตใกล้หมดอายุ")}</label>
          <label className="label" htmlFor="morning-hour">{translateUi("เวลาสรุปตอนเช้า (ชั่วโมงตามเขตเวลาร้าน)")}</label>
          <select id="morning-hour" className="input mb-3" value={f.morning_report_hour ?? 8} onChange={e => set({ morning_report_hour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, '0')}:00</option>)}</select>
          <label className="label" htmlFor="lt">{"" + translateUi("LINE ID ผู้รับ (userId / groupId)") + " "}</label>
          <input id="lt" className="input w-full font-mono" placeholder={translateUi("Uxxxxxxxx... (33 ตัวอักษร)")} value={f.line_to ?? ''} onChange={(e) => set({ line_to: e.target.value.trim() })} />
          {!lineValid && <p className="mt-1 field-error">{translateUi("รูปแบบไม่ถูกต้อง: ขึ้นต้นด้วย U, C หรือ R ตามด้วยตัวอักษร 0-9 a-f อีก 32 ตัว")}</p>}
          <p className="mt-2 hint">{"" + translateUi("ระบบส่งสรุปยอดทุกวันตอน 22:00 ผ่าน LINE Official Account ของร้าน (ต้องตั้ง LINE_CHANNEL_ACCESS_TOKEN ที่ backend ก่อน ดูวิธีใน docs/SETUP.md) · ไม่ตั้งก็ยังเปิดดูและกดแชร์รายงานเข้า LINE เองได้ที่หน้ารายงานรายวัน") + " "}</p>
        </section>

        <button className="btn btn-primary btn-lg w-full" disabled={busy || !ppValid || !lineValid}>
          {busy ? 'กำลังบันทึก...' : 'บันทึกการตั้งค่า'}
        </button>
      </form>
    </div>
  )
}

export default function Settings() {
  return <RequireRole roles={rolesFor('/settings')}>{(ctx) => <Board restaurantId={ctx.restaurantId} />}</RequireRole>
}
