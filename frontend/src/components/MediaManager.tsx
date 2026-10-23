import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { MEDIA_BUCKET, MEDIA_MAX_MB, mediaSrc, mediaTypeOf } from '../lib/media'
import { parseMediaLink, youtubeId } from '../lib/display'
import type { DisplayMediaRow } from '../lib/types'

// จัดการรูป/วิดีโอบนจอแสดงผล (0014): ของเมนูหนึ่ง หรือสไลด์โฆษณาร้าน (menuItemId = null)
// อัปโหลดไฟล์ หรือวางลิงก์ (YouTube / ไฟล์ .mp4 .jpg ...) · หลายชิ้นต่อเมนู วนเปลี่ยนทุกรอบ

type Notify = (m: { ok: boolean; text: string }) => void

const KIND_LABEL = { image: 'รูป', video: 'วิดีโอ', youtube: 'YouTube' } as const

export function MediaThumb({ m, size = 'h-20 w-28' }: { m: Pick<DisplayMediaRow, 'kind' | 'storage_path' | 'url'>; size?: string }) {
  const src = mediaSrc({ path: m.storage_path, url: m.url })
  const yt = m.kind === 'youtube' && m.url ? youtubeId(m.url) : null
  return (
    <span className={`${size} relative shrink-0 overflow-hidden rounded-lg bg-gray-100`}>
      {m.kind === 'video' ? (
        <video src={src} muted playsInline preload="metadata" className="h-full w-full object-cover" />
      ) : (
        <img src={yt ? `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` : src} alt="" loading="lazy" className="h-full w-full object-cover" />
      )}
      {m.kind !== 'image' && (
        <span className={`absolute right-0.5 bottom-0.5 rounded px-1 text-[9px] leading-tight text-white ${m.kind === 'youtube' ? 'bg-red-600' : 'bg-black/60'}`}>
          {m.kind === 'youtube' ? 'YT' : 'VDO'}
        </span>
      )}
    </span>
  )
}

export default function MediaManager({
  restaurantId,
  menuItemId,
  media,
  reload,
  notify,
  onPoster,
}: {
  restaurantId: string
  menuItemId: string | null
  media: DisplayMediaRow[]
  reload: () => void
  notify: Notify
  onPoster?: (m: DisplayMediaRow | null) => void // เปิดตัวสร้างโปสเตอร์ (null = สร้างใหม่)
}) {
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [draft, setDraft] = useState({ title: '', caption: '', credit: '', duration: '' })
  const isAd = menuItemId === null
  const nextOrder = Math.max(0, ...media.map((m) => m.sort_order)) + 1

  function done(error: { message: string } | null, okText: string) {
    notify(error ? { ok: false, text: error.message } : { ok: true, text: okText })
    reload()
    return !error
  }

  async function upload(file: File) {
    const kind = mediaTypeOf(file)
    if (!kind) return notify({ ok: false, text: 'รองรับเฉพาะไฟล์รูปหรือวิดีโอ' })
    if (file.size > MEDIA_MAX_MB * 1024 * 1024) return notify({ ok: false, text: `ไฟล์ใหญ่เกิน ${MEDIA_MAX_MB} MB` })
    const ext = (file.name.split('.').pop() ?? '').toLowerCase().replace(/[^a-z0-9]/g, '') || (kind === 'video' ? 'mp4' : 'jpg')
    const path = `${restaurantId}/${menuItemId ?? 'ad'}-${Date.now()}.${ext}`
    setBusy(true)
    const up = await supabase.storage.from(MEDIA_BUCKET).upload(path, file, { contentType: file.type, cacheControl: '31536000' })
    if (up.error) {
      setBusy(false)
      return notify({ ok: false, text: `อัปโหลดไม่สำเร็จ: ${up.error.message}` })
    }
    const { error } = await supabase
      .from('display_media')
      .insert({ restaurant_id: restaurantId, menu_item_id: menuItemId, kind, storage_path: path, sort_order: nextOrder })
    if (error) await supabase.storage.from(MEDIA_BUCKET).remove([path])
    setBusy(false)
    done(error, `อัปโหลด${KIND_LABEL[kind]}แล้ว`)
  }

  async function addLink(e: FormEvent) {
    e.preventDefault()
    const parsed = parseMediaLink(link)
    if ('error' in parsed) return notify({ ok: false, text: parsed.error })
    const { error } = await supabase
      .from('display_media')
      .insert({ restaurant_id: restaurantId, menu_item_id: menuItemId, kind: parsed.kind, url: parsed.url, sort_order: nextOrder })
    if (done(error, `เพิ่ม${KIND_LABEL[parsed.kind]}จากลิงก์แล้ว`)) setLink('')
  }

  async function remove(m: DisplayMediaRow) {
    if (!window.confirm(`ลบ${KIND_LABEL[m.kind]}นี้?`)) return
    const { error } = await supabase.from('display_media').delete().eq('id', m.id)
    if (!error && m.storage_path) await supabase.storage.from(MEDIA_BUCKET).remove([m.storage_path])
    done(error, 'ลบแล้ว')
  }

  async function toggle(m: DisplayMediaRow) {
    const { error } = await supabase.from('display_media').update({ is_active: !m.is_active }).eq('id', m.id)
    done(error, m.is_active ? 'ซ่อนจากจอแล้ว' : 'แสดงบนจอแล้ว')
  }

  // สลับลำดับกับชิ้นข้างเคียง
  async function move(i: number, dir: -1 | 1) {
    const a = media[i]
    const b = media[i + dir]
    if (!a || !b) return
    const sa = a.sort_order === b.sort_order ? b.sort_order + dir : b.sort_order
    const [r1, r2] = await Promise.all([
      supabase.from('display_media').update({ sort_order: sa }).eq('id', a.id),
      supabase.from('display_media').update({ sort_order: a.sort_order }).eq('id', b.id),
    ])
    done(r1.error ?? r2.error, 'เปลี่ยนลำดับแล้ว')
  }

  function startEdit(m: DisplayMediaRow) {
    setEditId(m.id)
    setDraft({ title: m.title ?? '', caption: m.caption ?? '', credit: m.credit ?? '', duration: m.duration_sec ? String(m.duration_sec) : '' })
  }

  async function saveEdit(e: FormEvent, m: DisplayMediaRow) {
    e.preventDefault()
    const sec = draft.duration ? Number(draft.duration) : null
    if (sec !== null && !(Number.isInteger(sec) && sec >= 5 && sec <= 120))
      return notify({ ok: false, text: 'เวลาแสดงต้องเป็น 5–120 วินาที หรือเว้นว่าง' })
    const { error } = await supabase
      .from('display_media')
      .update({ title: draft.title.trim() || null, caption: draft.caption.trim() || null, credit: draft.credit.trim() || null, duration_sec: sec })
      .eq('id', m.id)
    if (done(error, 'บันทึกแล้ว')) setEditId(null)
  }

  return (
    <div>
      {media.length > 0 && (
        <ul className="mb-3 space-y-2">
          {media.map((m, i) => (
            <li key={m.id} className={`rounded-xl border p-2 ${m.is_active ? 'bg-white' : 'bg-gray-50 opacity-70'}`}>
              <div className="flex items-center gap-3">
                <MediaThumb m={m} size="h-14 w-20" />
                <div className="min-w-0 flex-1 text-sm">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={`badge ${m.kind === 'image' ? 'badge-gray' : m.kind === 'video' ? 'badge-blue' : 'badge-red'}`}>{KIND_LABEL[m.kind]}</span>
                    <span className="text-xs text-gray-500">{m.poster ? 'โปสเตอร์' : m.storage_path ? 'อัปโหลด' : 'ลิงก์'}</span>
                    {m.duration_sec && <span className="text-xs text-gray-500">· {m.duration_sec} วิ</span>}
                    {!m.is_active && <span className="badge badge-amber">ซ่อนอยู่</span>}
                  </div>
                  {(m.title || m.caption) && <div className="truncate text-gray-800">{[m.title, m.caption].filter(Boolean).join(' — ')}</div>}
                  {m.credit && <div className="truncate text-xs text-gray-400">{m.credit}</div>}
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 text-sm">
                  <button type="button" className="link-muted disabled:opacity-30" disabled={i === 0} onClick={() => void move(i, -1)} aria-label="เลื่อนขึ้น">↑</button>
                  <button type="button" className="link-muted disabled:opacity-30" disabled={i === media.length - 1} onClick={() => void move(i, 1)} aria-label="เลื่อนลง">↓</button>
                  {Boolean(m.poster) && onPoster && (
                    <button type="button" className="link" onClick={() => onPoster(m)}>แก้โปสเตอร์</button>
                  )}
                  <button type="button" className="link" onClick={() => (editId === m.id ? setEditId(null) : startEdit(m))}>แก้ไข</button>
                  <button type="button" className="link" onClick={() => void toggle(m)}>{m.is_active ? 'ซ่อน' : 'แสดง'}</button>
                  <button type="button" className="link-danger" onClick={() => void remove(m)}>ลบ</button>
                </div>
              </div>
              {editId === m.id && (
                <form onSubmit={(e) => void saveEdit(e, m)} className="mt-2 grid gap-2 border-t pt-2 sm:grid-cols-2">
                  {isAd && (
                    <input className="input" placeholder="หัวข้อบนสไลด์" maxLength={80} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                  )}
                  <input className="input" placeholder="คำบรรยาย (ไม่บังคับ)" maxLength={200} value={draft.caption} onChange={(e) => setDraft({ ...draft, caption: e.target.value })} />
                  <input className="input" placeholder="เครดิต เช่น ภาพ: ชื่อเจ้าของ · CC BY" maxLength={120} value={draft.credit} onChange={(e) => setDraft({ ...draft, credit: e.target.value })} />
                  <input className="input" type="number" min={5} max={120} placeholder="เวลาแสดง (วินาที) ว่าง = อัตโนมัติ" value={draft.duration} onChange={(e) => setDraft({ ...draft, duration: e.target.value })} />
                  <div className="flex gap-2 sm:col-span-2">
                    <button className="btn btn-primary btn-sm">บันทึก</button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditId(null)}>ยกเลิก</button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label className={`btn btn-secondary btn-sm ${busy ? 'pointer-events-none opacity-60' : 'cursor-pointer'}`}>
          {busy ? 'กำลังอัปโหลด...' : 'อัปโหลดรูป/วิดีโอ'}
          <input
            type="file"
            accept="image/*,video/*"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void upload(f)
            }}
          />
        </label>
        {onPoster && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onPoster(null)}>
            สร้างโปสเตอร์
          </button>
        )}
        <form onSubmit={(e) => void addLink(e)} className="flex min-w-64 flex-1 gap-2">
          <input
            className="input flex-1"
            placeholder="หรือวางลิงก์ YouTube / ไฟล์ .mp4 .jpg (https://)"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
          <button className="btn btn-secondary btn-sm" disabled={!link.trim()}>เพิ่มลิงก์</button>
        </form>
      </div>
      <p className="mt-1.5 text-xs text-gray-500">
        ไฟล์ไม่เกิน {MEDIA_MAX_MB} MB · แนวนอนดูดีที่สุด · วิดีโอเล่นแบบไม่มีเสียง · {isAd ? 'สไลด์โฆษณาแทรกระหว่างเมนู' : 'มีหลายชิ้นจะเปลี่ยนชิ้นทุกรอบที่จอเล่นครบ'} · ใช้ภาพของคนอื่นให้ใส่เครดิต
      </p>
    </div>
  )
}
