import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { rolesFor } from '../lib/roles'
import { useShopSettings } from '../lib/shop'
import { promptPayKind } from '../lib/promptpay'
import RequireRole from '../components/RequireRole'
import PromptPayQR from '../components/PromptPayQR'
import type { ShopSettings } from '../lib/types'

// ตั้งค่าร้าน (เจ้าของเท่านั้น · shop_settings ใน 0017): พร้อมเพย์ ใบเสร็จ สะสมแต้ม ผู้รับรายงานทาง LINE

function Board({ restaurantId }: { restaurantId: string }) {
  const { settings, loaded, reload } = useShopSettings(restaurantId)
  const [f, setF] = useState<ShopSettings | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (settings) setF(settings)
  }, [settings])

  if (!settings || !f) {
    return (
      <div className="page-narrow">
        <h1 className="page-title mb-5">ตั้งค่าร้าน</h1>
        <p className="empty">{loaded ? 'ต้องรัน migration 0017 ก่อน' : 'กำลังโหลด...'}</p>
      </div>
    )
  }

  const set = (patch: Partial<ShopSettings>) => setF({ ...f, ...patch })
  const ppDigits = (f.promptpay_id ?? '').replace(/\D/g, '')
  const ppValid = ppDigits === '' || promptPayKind(ppDigits) !== null
  const lineValid = !f.line_to || /^[UCR][0-9a-f]{32}$/.test(f.line_to)

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!f || !ppValid || !lineValid) return
    setBusy(true)
    const { error } = await supabase.from('shop_settings').upsert({
      restaurant_id: restaurantId,
      promptpay_id: ppDigits || null,
      receipt_header: f.receipt_header?.trim() || null,
      receipt_footer: f.receipt_footer?.trim() || null,
      loyalty_enabled: f.loyalty_enabled,
      loyalty_baht_per_point: f.loyalty_baht_per_point,
      loyalty_point_value: f.loyalty_point_value,
      loyalty_min_redeem: f.loyalty_min_redeem,
      line_to: f.line_to?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    setBusy(false)
    setMessage(error ? { ok: false, text: error.message } : { ok: true, text: 'บันทึกการตั้งค่าแล้ว' })
    if (!error) void reload()
  }

  const num = (v: string, min: number, max: number, int = true) => {
    const n = int ? Math.round(Number(v)) : Number(v)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min
  }

  return (
    <div className="page-narrow">
      <h1 className="page-title mb-5">ตั้งค่าร้าน</h1>
      {message && <p className={message.ok ? 'alert-success' : 'alert-error'}>{message.text}</p>}

      <form onSubmit={(e) => void save(e)} className="space-y-6">
        <section className="card">
          <h2 className="section-title">รับเงินด้วยพร้อมเพย์</h2>
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <div>
              <label className="label" htmlFor="pp">
                เลขพร้อมเพย์ของร้าน
              </label>
              <input
                id="pp"
                className="input w-full"
                inputMode="numeric"
                placeholder="เบอร์มือถือ 10 หลัก หรือเลขผู้เสียภาษี 13 หลัก"
                value={f.promptpay_id ?? ''}
                onChange={(e) => set({ promptpay_id: e.target.value })}
              />
              {!ppValid && <p className="mt-1 text-xs text-red-600">ใช้เบอร์มือถือ 10 หลัก เลขบัตร/เลขผู้เสียภาษี 13 หลัก หรือ e-Wallet 15 หลัก</p>}
              <p className="mt-2 text-xs text-gray-500">
                หน้ารับชำระจะสร้าง QR ใส่ยอดของบิลให้ลูกค้าสแกน · ทดลองสแกน QR ตัวอย่าง (1 บาท) ด้วยแอปธนาคารเพื่อตรวจว่าชื่อบัญชีถูกต้อง ก่อนใช้จริง
              </p>
            </div>
            {ppValid && ppDigits && (
              <div className="w-48">
                <PromptPayQR id={ppDigits} amount={1} size={180} />
              </div>
            )}
          </div>
        </section>

        <section className="card">
          <h2 className="section-title">ใบเสร็จ</h2>
          <label className="label" htmlFor="rh">
            หัวใบเสร็จ (ที่อยู่ เบอร์โทร เลขผู้เสียภาษี)
          </label>
          <textarea id="rh" className="input w-full" rows={3} maxLength={300} value={f.receipt_header ?? ''} onChange={(e) => set({ receipt_header: e.target.value })} />
          <label className="label mt-3" htmlFor="rf">
            ท้ายใบเสร็จ
          </label>
          <input id="rf" className="input w-full" maxLength={200} placeholder="ขอบคุณที่ใช้บริการ" value={f.receipt_footer ?? ''} onChange={(e) => set({ receipt_footer: e.target.value })} />
        </section>

        <section className="card">
          <h2 className="section-title">สะสมแต้มสมาชิก</h2>
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-gray-800">
            <input type="checkbox" className="h-4 w-4 accent-brand-500" checked={f.loyalty_enabled} onChange={(e) => set({ loyalty_enabled: e.target.checked })} />
            เปิดใช้ระบบสะสมแต้ม (ปิดเมื่อไรก็ได้ แต้มเดิมยังอยู่)
          </label>
          <div className={`mt-3 grid gap-3 sm:grid-cols-3 ${f.loyalty_enabled ? '' : 'opacity-50'}`}>
            <div>
              <label className="label" htmlFor="bpp">
                จ่ายครบกี่บาท ได้ 1 แต้ม
              </label>
              <input id="bpp" className="input w-full" type="number" min={1} max={10000} value={f.loyalty_baht_per_point} onChange={(e) => set({ loyalty_baht_per_point: num(e.target.value, 1, 10000) })} />
            </div>
            <div>
              <label className="label" htmlFor="pv">
                1 แต้ม ลดได้กี่บาท
              </label>
              <input id="pv" className="input w-full" type="number" min={0.01} max={1000} step={0.01} value={f.loyalty_point_value} onChange={(e) => set({ loyalty_point_value: num(e.target.value, 0.01, 1000, false) })} />
            </div>
            <div>
              <label className="label" htmlFor="mr">
                แลกขั้นต่ำ (แต้ม)
              </label>
              <input id="mr" className="input w-full" type="number" min={1} max={100000} value={f.loyalty_min_redeem} onChange={(e) => set({ loyalty_min_redeem: num(e.target.value, 1, 100000) })} />
            </div>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            ตัวอย่าง: จ่าย 250 บาท ได้ {Math.floor(250 / f.loyalty_baht_per_point)} แต้ม · สะสม {f.loyalty_min_redeem} แต้ม แลกส่วนลดได้{' '}
            {(f.loyalty_min_redeem * f.loyalty_point_value).toLocaleString('th-TH')} บาท · แลกแต้มคิดหลังหักโปรแล้ว
          </p>
        </section>

        <section className="card">
          <h2 className="section-title">รายงานรายวันทาง LINE</h2>
          <label className="label" htmlFor="lt">
            LINE ID ผู้รับ (userId / groupId)
          </label>
          <input id="lt" className="input w-full font-mono" placeholder="Uxxxxxxxx... (33 ตัวอักษร)" value={f.line_to ?? ''} onChange={(e) => set({ line_to: e.target.value.trim() })} />
          {!lineValid && <p className="mt-1 text-xs text-red-600">รูปแบบไม่ถูกต้อง: ขึ้นต้นด้วย U, C หรือ R ตามด้วยตัวอักษร 0-9 a-f อีก 32 ตัว</p>}
          <p className="mt-2 text-xs text-gray-500">
            ระบบส่งสรุปยอดทุกวันตอน 22:00 ผ่าน LINE Official Account ของร้าน (ต้องตั้ง LINE_CHANNEL_ACCESS_TOKEN ที่ backend ก่อน ดูวิธีใน docs/SETUP.md) · ไม่ตั้งก็ยังเปิดดูและกดแชร์รายงานเข้า LINE เองได้ที่หน้ารายงานรายวัน
          </p>
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
