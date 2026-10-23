import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { DEFAULT_SETTINGS, DISPLAY_FONTS, PREVIEW_MESSAGE, normalizeSettings, type DisplayFont, type DisplaySettings } from '../lib/display'

// ตั้งค่าหน้าตาจอ iPad (display_settings ใน 0015) พร้อมพรีวิวสด
// พรีวิว = หน้า /display/<token>?preview=1 ใน iframe ขนาด iPad แนวนอน ส่งค่าที่ยังไม่บันทึกไปด้วย postMessage

const IPAD_W = 1180
const IPAD_H = 820
const ACCENTS = ['#f97316', '#dc2626', '#db2777', '#7c3aed', '#2563eb', '#0891b2', '#16a34a', '#ca8a04', '#111827']

export default function DisplaySettingsPanel({
  restaurantId,
  token,
  notify,
}: {
  restaurantId: string
  token: string | null
  notify: (m: { ok: boolean; text: string }) => void
}) {
  const [saved, setSaved] = useState<DisplaySettings>(DEFAULT_SETTINGS)
  const [s, setS] = useState<DisplaySettings>(DEFAULT_SETTINGS)
  const [busy, setBusy] = useState(false)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.5)
  const dirty = JSON.stringify(s) !== JSON.stringify(saved)

  const load = useCallback(async () => {
    const { data } = await supabase.from('display_settings').select('settings').eq('restaurant_id', restaurantId).maybeSingle()
    const v = normalizeSettings(data?.settings)
    setSaved(v)
    setS(v)
  }, [restaurantId])

  useEffect(() => {
    void load()
  }, [load])

  // ส่งค่าไปพรีวิวทุกครั้งที่แก้ และเมื่อพรีวิวโหลดเสร็จ
  const post = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ type: PREVIEW_MESSAGE, settings: s }, window.location.origin)
  }, [s])
  useEffect(post, [post])
  useEffect(() => {
    const onReady = (e: MessageEvent) => {
      if (e.origin === window.location.origin && e.data?.type === `${PREVIEW_MESSAGE}-ready`) post()
    }
    window.addEventListener('message', onReady)
    return () => window.removeEventListener('message', onReady)
  }, [post])

  // ย่อพรีวิวให้พอดีความกว้างกล่อง
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const ro = new ResizeObserver(() => setScale(box.clientWidth / IPAD_W))
    ro.observe(box)
    return () => ro.disconnect()
  }, [token])

  const set = (patch: Partial<DisplaySettings>) => setS((x) => ({ ...x, ...patch }))

  async function save() {
    setBusy(true)
    const { error } = await supabase
      .from('display_settings')
      .upsert({ restaurant_id: restaurantId, settings: s, updated_at: new Date().toISOString() })
    setBusy(false)
    if (error) return notify({ ok: false, text: error.message })
    setSaved(s)
    notify({ ok: true, text: 'บันทึกการตั้งค่าจอแล้ว จอที่เปิดอยู่จะเปลี่ยนภายใน 1 นาที' })
  }

  const toggle = (key: 'showCover' | 'showProgress' | 'showClock' | 'showPrice', label: string) => (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
      <input type="checkbox" className="h-4 w-4 accent-brand-500" checked={s[key]} onChange={(e) => set({ [key]: e.target.checked })} />
      {label}
    </label>
  )

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
      <div>
        {token ? (
          <div ref={boxRef} className="relative w-full overflow-hidden rounded-2xl border-8 border-gray-900 bg-black shadow-lg" style={{ height: IPAD_H * scale + 16 }}>
            <iframe
              ref={frameRef}
              src={`/display/${token}?preview=1`}
              title="พรีวิวจอ iPad"
              onLoad={post}
              className="absolute top-0 left-0 origin-top-left border-0"
              style={{ width: IPAD_W, height: IPAD_H, transform: `scale(${scale})` }}
            />
          </div>
        ) : (
          <div className="empty">สร้างลิงก์จอก่อน จึงจะเห็นพรีวิว</div>
        )}
        <p className="mt-2 text-xs text-gray-500">พรีวิวเป็นจอจริงขนาด iPad แนวนอน เปลี่ยนตามค่าที่แก้ทันที (ยังไม่บันทึกจนกว่าจะกดบันทึก)</p>
      </div>

      <div className="space-y-4">
        <div>
          <span className="label">สีหลัก</span>
          <div className="flex flex-wrap items-center gap-2">
            {ACCENTS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`สี ${c}`}
                onClick={() => set({ accent: c })}
                className={`h-8 w-8 rounded-full border-2 ${s.accent === c ? 'border-gray-900 ring-2 ring-gray-900/20' : 'border-white shadow'}`}
                style={{ background: c }}
              />
            ))}
            <input type="color" className="h-8 w-10 cursor-pointer rounded-lg border p-0.5" value={s.accent} onChange={(e) => set({ accent: e.target.value })} aria-label="เลือกสีเอง" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <span className="label">พื้นหน้านิตยสาร</span>
            <select className="input w-full" value={s.theme} onChange={(e) => set({ theme: e.target.value as DisplaySettings['theme'] })}>
              <option value="light">กระดาษครีม</option>
              <option value="dark">ดำ</option>
            </select>
          </div>
          <div>
            <span className="label">เปลี่ยนสไลด์แบบ</span>
            <select className="input w-full" value={s.transition} onChange={(e) => set({ transition: e.target.value as DisplaySettings['transition'] })}>
              <option value="fade">ค่อยๆ จาง</option>
              <option value="slide">เลื่อนเข้า</option>
              <option value="zoom">ซูมเข้า</option>
            </select>
          </div>
        </div>
        <div>
          <span className="label">ฟอนต์</span>
          <select className="input w-full" value={s.font} onChange={(e) => set({ font: e.target.value as DisplayFont })}>
            {(Object.keys(DISPLAY_FONTS) as DisplayFont[]).map((f) => (
              <option key={f} value={f}>
                {DISPLAY_FONTS[f].label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <span className="label">วินาที/สไลด์เมนู</span>
            <input className="input w-full" type="number" min={3} max={60} value={s.imageSeconds} onChange={(e) => set({ imageSeconds: Math.min(60, Math.max(3, Math.round(Number(e.target.value) || 3))) })} />
          </div>
          <div>
            <span className="label">วินาที/สไลด์โปร</span>
            <input className="input w-full" type="number" min={3} max={60} value={s.promoSeconds} onChange={(e) => set({ promoSeconds: Math.min(60, Math.max(3, Math.round(Number(e.target.value) || 3))) })} />
          </div>
        </div>
        <div>
          <span className="label">ป้ายบนสไลด์เมนู</span>
          <input className="input w-full" maxLength={20} placeholder="ว่าง = ไม่แสดงป้าย" value={s.badgeText} onChange={(e) => set({ badgeText: e.target.value })} />
        </div>
        <div>
          <span className="label">ข้อความหน้าปก</span>
          <input className="input w-full" maxLength={80} placeholder="ว่าง = บอกจำนวนเมนูแนะนำ/โปรให้อัตโนมัติ" value={s.tagline} onChange={(e) => set({ tagline: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          {toggle('showCover', 'หน้าปก')}
          {toggle('showPrice', 'ราคา')}
          {toggle('showProgress', 'แถบความคืบหน้า')}
          {toggle('showClock', 'ชื่อร้าน + นาฬิกา')}
        </div>
        <div className="flex gap-2">
          <button className="btn btn-primary flex-1" onClick={() => void save()} disabled={busy || !dirty}>
            {busy ? 'กำลังบันทึก...' : dirty ? 'บันทึกการตั้งค่า' : 'บันทึกแล้ว'}
          </button>
          <button className="btn btn-secondary" onClick={() => setS(saved)} disabled={!dirty}>
            ย้อนกลับ
          </button>
          <button className="btn btn-ghost" onClick={() => setS(DEFAULT_SETTINGS)} title="ใช้ค่าเริ่มต้น (ยังไม่บันทึก)">
            ค่าเริ่มต้น
          </button>
        </div>
      </div>
    </div>
  )
}
