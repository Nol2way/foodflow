import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { baht } from '../lib/format'
import { MEDIA_BUCKET, MEDIA_MAX_MB, mediaSrc, mediaUrl } from '../lib/media'
import { loadDisplayFont } from '../lib/fonts'
import { DISPLAY_FONTS, type DisplayFont } from '../lib/display'
import {
  DEFAULT_POSTER,
  POSTER_H,
  POSTER_TEMPLATES,
  POSTER_W,
  drawPoster,
  loadPosterImage,
  normalizePoster,
  type PosterSpec,
  type PosterTemplate,
} from '../lib/poster'
import type { DisplayMediaRow, MenuItem } from '../lib/types'

// สร้าง/แก้โปสเตอร์จากเทมเพลต → บันทึกเป็นรูปใน display_media (เก็บค่าไว้ใน poster เพื่อแก้ต่อได้)

export interface PosterTarget {
  media: DisplayMediaRow | null // null = สร้างใหม่
  menuItemId: string | null // null = สไลด์โฆษณาร้าน
}

function specFromItem(item: MenuItem | undefined, base: PosterSpec): PosterSpec {
  if (!item) return base
  return { ...base, title: item.name, price: baht(item.price), subtitle: item.description ?? base.subtitle }
}

export default function PosterEditor({
  restaurantId,
  items,
  media,
  target,
  onClose,
  onSaved,
}: {
  restaurantId: string
  items: MenuItem[]
  media: DisplayMediaRow[]
  target: PosterTarget
  onClose: () => void
  onSaved: (text: string) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [menuItemId, setMenuItemId] = useState<string | null>(target.media?.menu_item_id ?? target.menuItemId)
  const [spec, setSpec] = useState<PosterSpec>(() => {
    if (target.media?.poster) return normalizePoster(target.media.poster)
    const item = items.find((i) => i.id === target.menuItemId)
    const firstImage = media.find((m) => m.menu_item_id === target.menuItemId && m.kind === 'image' && !m.poster)
    return { ...specFromItem(item, DEFAULT_POSTER), image: firstImage ? mediaSrc({ path: firstImage.storage_path, url: firstImage.url }) : null }
  })
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [imgError, setImgError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // รูปที่เลือกเป็นพื้นหลังได้: รูปทั้งหมดของร้าน (ไม่รวมโปสเตอร์)
  const pictures = media.filter((m) => m.kind === 'image' && !m.poster).map((m) => ({ id: m.id, src: mediaSrc({ path: m.storage_path, url: m.url }) }))

  useEffect(() => {
    let alive = true
    setImgError(false)
    void loadPosterImage(spec.image).then((i) => {
      if (!alive) return
      setImg(i)
      setImgError(Boolean(spec.image) && !i)
    })
    return () => {
      alive = false
    }
  }, [spec.image])

  useEffect(() => {
    let alive = true
    void loadDisplayFont(spec.font).then(() => {
      const ctx = canvasRef.current?.getContext('2d')
      if (alive && ctx) drawPoster(ctx, spec, img)
    })
    return () => {
      alive = false
    }
  }, [spec, img])

  const set = (patch: Partial<PosterSpec>) => setSpec((s) => ({ ...s, ...patch }))

  function chooseTemplate(t: PosterTemplate) {
    set({ template: t, ...POSTER_TEMPLATES[t].colors })
  }

  function chooseTarget(id: string) {
    const next = id || null
    setMenuItemId(next)
    if (next) setSpec((s) => specFromItem(items.find((i) => i.id === next), s))
  }

  async function uploadBackground(file: File) {
    if (!file.type.startsWith('image/')) return setError('พื้นหลังต้องเป็นไฟล์รูป')
    if (file.size > MEDIA_MAX_MB * 1024 * 1024) return setError(`ไฟล์ใหญ่เกิน ${MEDIA_MAX_MB} MB`)
    const ext = (file.name.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
    const path = `${restaurantId}/poster-bg-${Date.now()}.${ext}`
    setBusy(true)
    const up = await supabase.storage.from(MEDIA_BUCKET).upload(path, file, { contentType: file.type, cacheControl: '31536000' })
    setBusy(false)
    if (up.error) return setError(`อัปโหลดไม่สำเร็จ: ${up.error.message}`)
    setError(null)
    set({ image: mediaUrl(path) })
  }

  async function save() {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!spec.title.trim()) return setError('ใส่หัวข้อโปสเตอร์ก่อน')
    setBusy(true)
    setError(null)
    await loadDisplayFont(spec.font)
    drawPoster(canvas.getContext('2d')!, spec, img)
    let blob: Blob | null = null
    try {
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
    } catch {
      blob = null // รูปพื้นหลังจากเว็บอื่นที่ไม่อนุญาต ทำให้ส่งออกไม่ได้
    }
    if (!blob) {
      setBusy(false)
      return setError('บันทึกไม่ได้: รูปพื้นหลังจากลิงก์นี้ไม่อนุญาตให้นำมาสร้างโปสเตอร์ ให้อัปโหลดรูปเองแทน')
    }
    const path = `${restaurantId}/poster-${Date.now()}.jpg`
    const up = await supabase.storage.from(MEDIA_BUCKET).upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000' })
    if (up.error) {
      setBusy(false)
      return setError(`อัปโหลดไม่สำเร็จ: ${up.error.message}`)
    }
    const row = { menu_item_id: menuItemId, storage_path: path, poster: spec, kind: 'image' as const }
    const old = target.media
    const res = old
      ? await supabase.from('display_media').update(row).eq('id', old.id)
      : await supabase
          .from('display_media')
          .insert({ ...row, restaurant_id: restaurantId, sort_order: Math.max(0, ...media.map((m) => m.sort_order)) + 1 })
    if (res.error) {
      await supabase.storage.from(MEDIA_BUCKET).remove([path])
      setBusy(false)
      return setError(res.error.message)
    }
    if (old?.storage_path) await supabase.storage.from(MEDIA_BUCKET).remove([old.storage_path])
    setBusy(false)
    onSaved(old ? 'แก้โปสเตอร์แล้ว' : 'สร้างโปสเตอร์แล้ว ขึ้นจอรอบถัดไป')
  }

  const color = (key: 'bg' | 'accent' | 'ink', label: string) => (
    <label className="flex items-center gap-2 text-sm text-gray-700">
      <input type="color" className="h-9 w-12 cursor-pointer rounded-lg border p-0.5" value={spec[key]} onChange={(e) => set({ [key]: e.target.value })} />
      {label}
    </label>
  )

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/50 p-3 sm:p-6" role="dialog" aria-modal="true" aria-label="สร้างโปสเตอร์">
      <div className="mx-auto max-w-6xl rounded-2xl bg-white p-4 shadow-2xl sm:p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-gray-900">{target.media ? 'แก้โปสเตอร์' : 'สร้างโปสเตอร์จากเทมเพลต'}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            ปิด
          </button>
        </div>
        <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
          <div>
            <canvas
              ref={canvasRef}
              width={POSTER_W}
              height={POSTER_H}
              className="aspect-video w-full rounded-xl border bg-gray-100 shadow-sm"
              aria-label="ตัวอย่างโปสเตอร์"
            />
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(Object.keys(POSTER_TEMPLATES) as PosterTemplate[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => chooseTemplate(t)}
                  className={`rounded-xl border p-2 text-left transition ${spec.template === t ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-500/20' : 'hover:bg-gray-50'}`}
                >
                  <span className="block text-sm font-semibold text-gray-900">{POSTER_TEMPLATES[t].label}</span>
                  <span className="block text-xs text-gray-500">{POSTER_TEMPLATES[t].hint}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <span className="label">ขึ้นจอที่</span>
              <select className="input w-full" value={menuItemId ?? ''} onChange={(e) => chooseTarget(e.target.value)}>
                <option value="">สไลด์โฆษณาร้าน</option>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>
                    เมนู: {i.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <span className="label">หัวข้อ</span>
              <input className="input w-full" maxLength={80} value={spec.title} onChange={(e) => set({ title: e.target.value })} />
            </div>
            <div>
              <span className="label">คำโปรย</span>
              <textarea className="input w-full" rows={2} maxLength={160} value={spec.subtitle} onChange={(e) => set({ subtitle: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className="label">ป้าย</span>
                <input className="input w-full" maxLength={30} placeholder="เช่น ลด 20%" value={spec.badge} onChange={(e) => set({ badge: e.target.value })} />
              </div>
              <div>
                <span className="label">ราคา</span>
                <input className="input w-full" maxLength={30} placeholder="เช่น ฿59" value={spec.price} onChange={(e) => set({ price: e.target.value })} />
              </div>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {color('bg', 'พื้น')}
              {color('accent', 'สีเน้น')}
              {color('ink', 'ตัวหนังสือ')}
            </div>
            <div>
              <span className="label">ฟอนต์</span>
              <select className="input w-full" value={spec.font} onChange={(e) => set({ font: e.target.value as DisplayFont })}>
                {(Object.keys(DISPLAY_FONTS) as DisplayFont[]).map((f) => (
                  <option key={f} value={f}>
                    {DISPLAY_FONTS[f].label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <span className="label">รูปพื้นหลัง</span>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => set({ image: null })}
                  className={`grid h-12 w-16 place-items-center rounded-lg border text-xs text-gray-500 ${spec.image === null ? 'ring-2 ring-brand-500' : ''}`}
                >
                  ไม่มีรูป
                </button>
                {pictures.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => set({ image: p.src })}
                    className={`h-12 w-16 overflow-hidden rounded-lg border ${spec.image === p.src ? 'ring-2 ring-brand-500' : ''}`}
                  >
                    <img src={p.src} alt="" loading="lazy" className="h-full w-full object-cover" />
                  </button>
                ))}
                <label className={`grid h-12 w-16 place-items-center rounded-lg border border-dashed text-xs text-gray-500 ${busy ? 'opacity-50' : 'cursor-pointer hover:bg-gray-50'}`}>
                  + อัปโหลด
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    disabled={busy}
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      e.target.value = ''
                      if (f) void uploadBackground(f)
                    }}
                  />
                </label>
              </div>
              {imgError && <p className="mt-1 text-xs text-red-600">โหลดรูปนี้มาวาดไม่ได้ (เว็บต้นทางไม่อนุญาต) ให้อัปโหลดรูปเองแทน</p>}
            </div>
            {error && <p className="alert-error">{error}</p>}
            <div className="flex gap-2 pt-1">
              <button className="btn btn-primary flex-1" onClick={() => void save()} disabled={busy}>
                {busy ? 'กำลังบันทึก...' : target.media ? 'บันทึกการแก้ไข' : 'บันทึกขึ้นจอ'}
              </button>
              <button className="btn btn-secondary" onClick={onClose} disabled={busy}>
                ยกเลิก
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
