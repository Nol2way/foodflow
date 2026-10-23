import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import type { CSSProperties } from 'react'
import { supabase } from '../lib/supabase'
import { baht } from '../lib/format'
import { mediaSrc } from '../lib/media'
import { loadDisplayFont } from '../lib/fonts'
import {
  DISPLAY_FONTS,
  PREVIEW_MESSAGE,
  buildSlides,
  normalizeSettings,
  promoHeadline,
  promoTerms,
  slideDuration,
  youtubeEmbed,
  type DisplayContent,
  type DisplayItem,
  type DisplayMedia,
  type DisplayPromo,
  type DisplaySettings,
  type Slide,
} from '../lib/display'

// จอแสดงผล iPad แบบแมกกาซีน: เปิดด้วยลิงก์ลับ /display/:token ไม่ต้องล็อกอิน
// เนื้อหามาจาก display_content (0013–0015) และโหลดใหม่ทุกนาที (ราคา/เมนูหมด/โปรตามเวลา/การตั้งค่า)
// ?preview=1 = พรีวิวในหน้าจัดการเมนู: รับค่าตั้งค่าที่ยังไม่บันทึกผ่าน postMessage

const REFRESH_MS = 60000

// เปลี่ยนสีหลักทั้งจอ: แทนตัวแปรสี brand ของ Tailwind ด้วยเฉดที่ผสมจากสีที่เลือก
function themeStyle(s: DisplaySettings): CSSProperties {
  const mix = (pct: number, to: 'white' | 'black') => `color-mix(in oklab, ${s.accent} ${pct}%, ${to})`
  return {
    '--color-brand-300': mix(55, 'white'),
    '--color-brand-400': mix(80, 'white'),
    '--color-brand-500': s.accent,
    '--color-brand-600': mix(85, 'black'),
    '--color-brand-700': mix(70, 'black'),
    fontFamily: `${DISPLAY_FONTS[s.font].family}, "IBM Plex Sans Thai", system-ui, sans-serif`,
  } as CSSProperties
}


function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 15000)
    return () => clearInterval(tick)
  }, [])
  return now
}

// ไม่ให้ iPad ดับจอ (รองรับ iPadOS 16.4+) · ขอใหม่เมื่อกลับมาที่แท็บ
function useWakeLock() {
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }
    const request = () => {
      if (document.visibilityState === 'visible' && nav.wakeLock)
        nav.wakeLock
          .request('screen')
          .then((l) => (lock = l))
          .catch(() => undefined)
    }
    request()
    document.addEventListener('visibilitychange', request)
    return () => {
      document.removeEventListener('visibilitychange', request)
      void lock?.release().catch(() => undefined)
    }
  }, [])
}

// หยุดชั่วคราวแบบสตอรี่ IG: วิดีโอ/YouTube ในสไลด์อ่านค่านี้แล้วหยุดตาม
const PausedContext = createContext(false)

function Media({ m, className, onVideoLength }: { m: DisplayMedia; className: string; onVideoLength?: (s: number) => void }) {
  const paused = useContext(PausedContext)
  const videoRef = useRef<HTMLVideoElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    const v = videoRef.current
    if (v) {
      if (paused) v.pause()
      else void v.play().catch(() => undefined)
    }
    // YouTube รับคำสั่งผ่าน postMessage (enablejsapi=1)
    frameRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: 'command', func: paused ? 'pauseVideo' : 'playVideo', args: [] }),
      'https://www.youtube-nocookie.com',
    )
  }, [paused])

  if (m.kind === 'youtube') {
    const src = m.url ? youtubeEmbed(m.url) : null
    // ขยาย iframe ให้ล้นกรอบเพื่อครอปแบบ object-cover และซ่อนแถบของ YouTube
    return src ? (
      <div className={`${className} overflow-hidden`}>
        <iframe
          ref={frameRef}
          src={src}
          title={m.title ?? 'video'}
          allow="autoplay; encrypted-media; picture-in-picture"
          className="pointer-events-none absolute top-1/2 left-1/2 h-[56.25vw] min-h-[115%] w-[177.78vh] min-w-[115%] -translate-x-1/2 -translate-y-1/2 border-0"
        />
      </div>
    ) : null
  }
  if (m.kind === 'video') {
    return (
      <video
        ref={videoRef}
        src={mediaSrc(m)}
        className={className}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        onLoadedMetadata={(e) => onVideoLength?.(e.currentTarget.duration)}
      />
    )
  }
  return <img src={mediaSrc(m)} alt="" className={`${className} mag-kenburns`} />
}

function Credit({ m, dark = true }: { m: DisplayMedia | null; dark?: boolean }) {
  if (!m?.credit) return null
  return (
    <div className={`absolute right-4 bottom-3 z-10 max-w-[60%] truncate text-[11px] ${dark ? 'text-white/60' : 'text-gray-400'}`}>
      {m.credit}
    </div>
  )
}

function PromoSticker({ promo }: { promo: DisplayPromo }) {
  return (
    <div
      className="mag-pop absolute top-24 right-8 grid h-32 w-32 rotate-12 place-items-center rounded-full bg-brand-500 text-center text-white shadow-2xl ring-4 ring-white/80 md:h-40 md:w-40"
      style={{ animationDelay: '900ms' }}
    >
      <div>
        <div className="text-sm font-semibold tracking-wide md:text-base">ลด</div>
        <div className="text-3xl leading-none font-extrabold md:text-4xl">{promoHeadline(promo)}</div>
        <div className="mt-1 px-3 text-[11px] leading-tight opacity-90">{promo.name}</div>
      </div>
    </div>
  )
}

function ItemSlide({
  item,
  media,
  layout,
  promo,
  index,
  settings,
  onVideoLength,
}: {
  item: DisplayItem
  media: DisplayMedia | null
  layout: 'full' | 'split'
  promo: DisplayPromo | null
  index: number
  settings: DisplaySettings
  onVideoLength: (s: number) => void
}) {
  const kicker = (
    <div className="mag-rise flex items-center gap-3" style={{ animationDelay: '150ms' }}>
      {settings.badgeText && (
        <span className="rounded-full bg-brand-500 px-3 py-1 text-xs font-bold tracking-widest text-white uppercase md:text-sm">
          {settings.badgeText}
        </span>
      )}
      {item.category && <span className="text-sm font-medium tracking-[0.2em] uppercase opacity-80 md:text-base">{item.category}</span>}
    </div>
  )
  const price = settings.showPrice && (
    <div
      className="mag-rise mt-6 inline-flex items-baseline gap-2 rounded-2xl bg-white px-5 py-2 text-gray-900 shadow-xl"
      style={{ animationDelay: '650ms' }}
    >
      <span className="text-sm font-medium text-gray-500">ราคา</span>
      <span className="text-4xl font-extrabold tracking-tight tabular-nums md:text-5xl">{baht(item.price)}</span>
    </div>
  )

  if (layout === 'full' && media) {
    return (
      <div className="absolute inset-0 overflow-hidden bg-black">
        <Media m={media} className="absolute inset-0 h-full w-full object-cover" onVideoLength={onVideoLength} />
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-black/30" />
        {promo && <PromoSticker promo={promo} />}
        <div className="absolute inset-x-0 bottom-0 p-8 pb-14 text-white md:p-14 md:pb-20">
          {kicker}
          <h2
            className="mag-rise mt-4 max-w-4xl text-5xl leading-[1.05] font-extrabold tracking-tight drop-shadow-lg md:text-7xl lg:text-8xl"
            style={{ animationDelay: '300ms' }}
          >
            {item.name}
          </h2>
          {(media?.caption ?? item.description) && (
            <p className="mag-rise mt-4 max-w-2xl text-lg leading-relaxed text-white/90 md:text-2xl" style={{ animationDelay: '480ms' }}>
              {media?.caption ?? item.description}
            </p>
          )}
          {price}
        </div>
        <Credit m={media} />
      </div>
    )
  }

  // แบบหน้านิตยสาร: ภาพครึ่งหนึ่ง ตัวอักษรอีกครึ่ง (หรือโปสเตอร์ตัวอักษรล้วนถ้าไม่มีสื่อ)
  const flip = index % 2 === 1
  const dark = settings.theme === 'dark'
  return (
    <div
      className={`absolute inset-0 flex flex-col md:flex-row ${dark ? 'bg-gray-950 text-white' : 'bg-[#fbf6ef] text-gray-900'} ${flip ? 'md:flex-row-reverse' : ''}`}
    >
      <div className="relative h-1/2 overflow-hidden md:h-full md:w-[55%]">
        {media ? (
          <Media m={media} className="absolute inset-0 h-full w-full object-cover" onVideoLength={onVideoLength} />
        ) : (
          <div className="mag-poster absolute inset-0 grid place-items-center bg-gradient-to-br from-brand-400 via-brand-500 to-brand-700">
            <span className="mag-drift text-[42vh] leading-none font-extrabold text-white/15 select-none">{item.name.slice(0, 1)}</span>
          </div>
        )}
        {promo && <PromoSticker promo={promo} />}
        <Credit m={media} />
      </div>
      <div className="flex flex-1 flex-col justify-center p-8 pb-14 md:p-14">
        <div className={dark ? 'text-brand-400' : 'text-brand-600'}>{kicker}</div>
        <h2
          className="mag-rise mt-5 text-5xl leading-[1.05] font-extrabold tracking-tight md:text-6xl lg:text-7xl"
          style={{ animationDelay: '300ms' }}
        >
          {item.name}
        </h2>
        <div className="mag-line mt-6 h-1.5 w-24 rounded-full bg-brand-500" style={{ animationDelay: '450ms' }} />
        {(media?.caption ?? item.description) && (
          <p
            className={`mag-rise mt-6 max-w-xl text-lg leading-relaxed md:text-2xl ${dark ? 'text-white/70' : 'text-gray-600'}`}
            style={{ animationDelay: '520ms' }}
          >
            {media?.caption ?? item.description}
          </p>
        )}
        <div>{price}</div>
      </div>
    </div>
  )
}

function PromoSlide({ promo }: { promo: DisplayPromo }) {
  const pic = promo.items.find((i) => i.image)?.image
  return (
    <div className="absolute inset-0 overflow-hidden bg-brand-600 text-white">
      {pic && (
        <img
          src={mediaSrc(pic)}
          alt=""
          className="mag-kenburns absolute inset-0 h-full w-full object-cover opacity-25 mix-blend-multiply"
        />
      )}
      <div className="mag-spin absolute -top-1/4 -right-1/4 h-[80vmax] w-[80vmax] rounded-full border-[3vmax] border-white/10" />
      <div className="relative flex h-full flex-col items-center justify-center p-8 text-center">
        <div className="mag-rise rounded-full bg-white px-5 py-1.5 text-sm font-bold tracking-[0.25em] text-brand-700 uppercase md:text-base">
          โปรโมชันวันนี้
        </div>
        <div className="mag-pop mt-6 text-2xl font-bold md:text-4xl" style={{ animationDelay: '200ms' }}>
          ลด
        </div>
        <div
          className="mag-zoom text-[24vw] leading-[0.9] font-extrabold tracking-tighter tabular-nums drop-shadow-xl md:text-[18vw]"
          style={{ animationDelay: '300ms' }}
        >
          {promoHeadline(promo)}
        </div>
        <h2 className="mag-rise mt-4 text-3xl font-bold md:text-5xl" style={{ animationDelay: '600ms' }}>
          {promo.name}
        </h2>
        <ul className="mt-5 flex max-w-3xl flex-wrap justify-center gap-2">
          {promoTerms(promo).map((t, i) => (
            <li
              key={t}
              className="mag-rise rounded-full bg-black/20 px-4 py-1.5 text-base md:text-xl"
              style={{ animationDelay: `${750 + i * 120}ms` }}
            >
              {t}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function AdSlide({ m, onVideoLength }: { m: DisplayMedia; onVideoLength: (s: number) => void }) {
  return (
    <div className="absolute inset-0 overflow-hidden bg-black">
      <Media m={m} className="absolute inset-0 h-full w-full object-cover" onVideoLength={onVideoLength} />
      {(m.title || m.caption) && (
        <>
          <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-transparent" />
          <div className="absolute inset-x-0 bottom-0 p-8 pb-14 text-white md:p-14 md:pb-20">
            {m.title && (
              <h2
                className="mag-rise max-w-4xl text-5xl leading-[1.05] font-extrabold tracking-tight drop-shadow-lg md:text-7xl"
                style={{ animationDelay: '300ms' }}
              >
                {m.title}
              </h2>
            )}
            {m.caption && (
              <p className="mag-rise mt-4 max-w-2xl text-lg text-white/90 md:text-2xl" style={{ animationDelay: '500ms' }}>
                {m.caption}
              </p>
            )}
          </div>
        </>
      )}
      <Credit m={m} />
    </div>
  )
}

function CoverSlide({ content, now, tagline }: { content: DisplayContent; now: Date; tagline: string }) {
  const pics = content.items
    .map((i) => i.media.find((m) => m.kind === 'image'))
    .filter((m): m is DisplayMedia => Boolean(m))
    .slice(0, 3)
  return (
    <div className="absolute inset-0 overflow-hidden bg-gray-950 text-white">
      <div className="absolute inset-0 grid grid-cols-3 opacity-45">
        {pics.map((p, i) => (
          <img
            key={p.id}
            src={mediaSrc(p)}
            alt=""
            className="mag-kenburns h-full w-full object-cover"
            style={{ animationDelay: `${i * 300}ms` }}
          />
        ))}
      </div>
      <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/30 to-black/80" />
      <div className="relative flex h-full flex-col justify-end p-8 pb-16 md:p-16 md:pb-24">
        <div className="mag-rise text-sm font-semibold tracking-[0.35em] text-brand-300 uppercase md:text-lg">
          ฉบับวันที่ {now.toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' })}
        </div>
        <h1
          className="mag-rise mt-3 text-6xl leading-none font-extrabold tracking-tight md:text-8xl lg:text-9xl"
          style={{ animationDelay: '200ms' }}
        >
          {content.restaurant}
        </h1>
        <div className="mag-line mt-6 h-2 w-40 rounded-full bg-brand-500" style={{ animationDelay: '450ms' }} />
        <p className="mag-rise mt-6 text-xl text-white/85 md:text-3xl" style={{ animationDelay: '550ms' }}>
          {tagline ||
            (content.items.length > 0
              ? `เมนูแนะนำ ${content.items.length} รายการ${content.promotions.length ? ` · โปรวันนี้ ${content.promotions.length} รายการ` : ''}`
              : content.promotions.length
                ? `โปรวันนี้ ${content.promotions.length} รายการ`
                : 'ยังไม่มีเมนูแนะนำ (ตั้งได้ที่หน้าจัดการเมนู)')}
        </p>
      </div>
    </div>
  )
}

function Screen({ text }: { text: string }) {
  return <div className="grid min-h-screen place-items-center bg-gray-950 p-8 text-center text-xl text-white/80">{text}</div>
}

export default function Display() {
  const { token = '' } = useParams()
  const preview = useSearchParams()[0].get('preview') === '1'
  const [draft, setDraft] = useState<unknown>(undefined)
  const [content, setContent] = useState<DisplayContent | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'invalid' | 'error'>('loading')
  const [index, setIndex] = useState(0)
  const [round, setRound] = useState(0) // เล่นครบรอบแล้วเปลี่ยนสื่อของเมนูที่มีหลายชิ้น
  const [videoSeconds, setVideoSeconds] = useState<number | undefined>()
  // หยุดแบบสตอรี่ IG: กดค้าง = หยุดจนกว่าจะปล่อย · ปุ่ม ❚❚ = หยุดค้างไว้จนกดเล่นต่อ
  const [holding, setHolding] = useState(false)
  const [stopped, setStopped] = useState(false)
  const paused = holding || stopped
  const now = useClock()
  const rootRef = useRef<HTMLDivElement>(null)
  useWakeLock()

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('display_content', { p_token: token })
    if (error) return setState((s) => (s === 'ok' ? s : 'error')) // เน็ตหลุด: แสดงของเดิมต่อ
    if (!data) {
      setContent(null)
      return setState('invalid')
    }
    setContent(data as DisplayContent)
    setState('ok')
  }, [token])

  useEffect(() => {
    void load()
    const tick = setInterval(() => void load(), REFRESH_MS)
    return () => clearInterval(tick)
  }, [load])

  // พรีวิว: รับค่าตั้งค่าจากหน้าจัดการ (ต้นทางเดียวกันเท่านั้น)
  useEffect(() => {
    if (!preview) return
    const onMessage = (e: MessageEvent) => {
      if (e.origin === window.location.origin && e.data?.type === PREVIEW_MESSAGE) setDraft(e.data.settings)
    }
    window.addEventListener('message', onMessage)
    window.parent.postMessage({ type: `${PREVIEW_MESSAGE}-ready` }, window.location.origin)
    return () => window.removeEventListener('message', onMessage)
  }, [preview])

  const settings = useMemo(() => normalizeSettings(draft !== undefined ? draft : content?.settings), [draft, content])
  useEffect(() => void loadDisplayFont(settings.font), [settings.font])

  const slides = useMemo(() => (content ? buildSlides(content, round, settings.showCover) : []), [content, round, settings.showCover])
  const currentKey = slides[index]?.key
  const slide: Slide | undefined = slides[index] ?? slides[0]

  // เนื้อหาเปลี่ยน (เมนูหมด/โปรหมดเวลา): อยู่สไลด์เดิมถ้ายังมี ไม่งั้นเริ่มใหม่
  // (ขึ้นรอบใหม่ไม่ต้องหา เพราะเริ่มที่สไลด์แรกอยู่แล้ว)
  const keyRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const at = slides.findIndex((s) => s.key === keyRef.current)
    setIndex(at >= 0 ? at : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, settings.showCover])

  // เวลาที่เล่นไปแล้วของสไลด์นี้ (ไม่นับช่วงที่หยุด) · เปลี่ยนสไลด์ = เริ่มนับใหม่
  const elapsedRef = useRef(0)
  useEffect(() => {
    keyRef.current = currentKey
    elapsedRef.current = 0
    setVideoSeconds(undefined)
  }, [currentKey])

  const go = useCallback(
    (dir: 1 | -1) => {
      if (slides.length === 0) return
      if (dir === 1 && index + 1 >= slides.length) {
        setIndex(0)
        setRound((r) => r + 1)
      } else setIndex((index + dir + slides.length) % slides.length)
    },
    [index, slides.length],
  )

  const duration = slide ? slideDuration(slide, videoSeconds, settings) : 0
  useEffect(() => {
    if (slides.length <= 1 || paused) return
    const startedAt = Date.now()
    const timer = setTimeout(() => go(1), Math.max(0, duration - elapsedRef.current))
    return () => {
      clearTimeout(timer)
      elapsedRef.current += Date.now() - startedAt
    }
  }, [go, duration, slides.length, paused])

  // โหลดรูปของสไลด์ถัดไปไว้ก่อน
  useEffect(() => {
    const next = slides[(index + 1) % Math.max(1, slides.length)]
    const m = next?.kind === 'item' || next?.kind === 'ad' ? next.media : null
    if (m?.kind === 'image') new Image().src = mediaSrc(m)
  }, [index, slides])

  // คีย์บอร์ด: เว้นวรรค = หยุด/เล่น · ลูกศร = ก่อนหน้า/ถัดไป
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        e.preventDefault()
        setStopped((x) => !x)
      } else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go])

  // แตะแบบสตอรี่ IG: แตะซ้าย 1/3 = ย้อน · แตะขวา = ถัดไป · กดค้าง = หยุดจนปล่อย
  const press = useRef<{ timer: number; held: boolean } | null>(null)
  function onPointerDown(e: ReactPointerEvent) {
    if (e.button !== 0) return
    const timer = window.setTimeout(() => {
      if (press.current) press.current.held = true
      setHolding(true)
    }, 220)
    press.current = { timer, held: false }
  }
  function onPointerUp(e: ReactPointerEvent) {
    const p = press.current
    press.current = null
    if (!p) return
    clearTimeout(p.timer)
    if (p.held) return setHolding(false)
    const rect = e.currentTarget.getBoundingClientRect()
    go(e.clientX - rect.left < rect.width / 3 ? -1 : 1)
  }
  function onPointerCancel() {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
    setHolding(false)
  }

  function toggleFullscreen() {
    const el = rootRef.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null
    const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void }
    if (document.fullscreenElement || doc.webkitFullscreenElement) {
      if (document.exitFullscreen) void document.exitFullscreen().catch(() => undefined)
      else doc.webkitExitFullscreen?.()
    } else if (el?.requestFullscreen) void el.requestFullscreen().catch(() => undefined)
    else el?.webkitRequestFullscreen?.()
  }

  if (state === 'loading') return <Screen text="กำลังโหลด..." />
  if (state === 'invalid') return <Screen text="ลิงก์จอแสดงผลนี้ใช้ไม่ได้แล้ว ขอลิงก์ใหม่จากเจ้าของร้านหรือผู้จัดการ" />
  if (state === 'error' || !content || !slide) return <Screen text="เชื่อมต่อไม่ได้ กำลังลองใหม่..." />

  // ปุ่มบนแถบด้านบน: ไม่ให้การแตะปุ่มไปนับเป็นแตะเปลี่ยนสไลด์
  const stop = (e: ReactPointerEvent) => e.stopPropagation()
  const iconBtn = 'pointer-events-auto grid h-10 w-10 place-items-center rounded-full bg-black/30 text-white backdrop-blur transition hover:bg-black/50'

  return (
    <div
      ref={rootRef}
      className={`fixed inset-0 touch-none overflow-hidden bg-black select-none ${paused ? 'mag-paused' : ''}`}
      style={{ ...themeStyle(settings), WebkitTouchCallout: 'none' }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerCancel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <PausedContext.Provider value={paused}>
        <div key={slide.key + index} className={`mag-enter-${settings.transition} absolute inset-0`}>
          {slide.kind === 'cover' && <CoverSlide content={content} now={now} tagline={settings.tagline} />}
          {slide.kind === 'item' && (
            <ItemSlide
              item={slide.item}
              media={slide.media}
              layout={slide.layout}
              promo={slide.promo}
              index={index}
              settings={settings}
              onVideoLength={setVideoSeconds}
            />
          )}
          {slide.kind === 'ad' && <AdSlide m={slide.media} onVideoLength={setVideoSeconds} />}
          {slide.kind === 'promo' && <PromoSlide promo={slide.promo} />}
        </div>
      </PausedContext.Provider>

      {/* แถบด้านบนแบบสตอรี่ IG (ซ่อนตอนกดค้างให้เห็นภาพเต็ม) */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/55 to-transparent px-4 pt-3 pb-10 text-white transition-opacity duration-300 md:px-8 ${holding ? 'opacity-0' : ''}`}
      >
        {settings.showProgress && (
          <div className="flex gap-1">
            {slides.map((s, i) => (
              <div key={s.key} className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/35">
                {i < index && <div className="h-full w-full bg-white" />}
                {i === index && (
                  <div key={slide.key + index} className="mag-progress h-full bg-white" style={{ animationDuration: `${duration}ms` }} />
                )}
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 flex items-center gap-3">
          {settings.showClock && (
            <>
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-tr from-amber-400 via-brand-500 to-pink-600 p-[2px]">
                <span className="grid h-full w-full place-items-center rounded-full bg-gray-900 text-sm font-bold">{content.restaurant.slice(0, 1)}</span>
              </span>
              <span className="min-w-0 truncate text-sm font-semibold md:text-base">{content.restaurant}</span>
              <span className="text-sm text-white/70 tabular-nums">{now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}</span>
            </>
          )}
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              className={iconBtn}
              onPointerDown={stop}
              onPointerUp={stop}
              onClick={() => setStopped((x) => !x)}
              aria-label={stopped ? 'เล่นต่อ' : 'หยุดชั่วคราว'}
            >
              {stopped ? (
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
                  <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
                  <rect x="6" y="5" width="4" height="14" rx="1" />
                  <rect x="14" y="5" width="4" height="14" rx="1" />
                </svg>
              )}
            </button>
            {!preview && (
              <button type="button" className={iconBtn} onPointerDown={stop} onPointerUp={stop} onClick={toggleFullscreen} aria-label="เต็มจอ">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
                </svg>
              </button>
            )}
          </span>
        </div>
      </div>

      {/* หยุดค้างไว้: บอกให้รู้ว่ายังไม่เล่นต่อ */}
      {stopped && !holding && (
        <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
          <span className="rounded-full bg-black/60 px-4 py-2 text-sm text-white backdrop-blur">
            หยุดชั่วคราว · แตะ ▶ เพื่อเล่นต่อ · แตะซ้าย/ขวาเพื่อเลื่อน
          </span>
        </div>
      )}
    </div>
  )
}
