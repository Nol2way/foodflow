// ไม่มี import เพื่อให้ทดสอบด้วย node ได้โดยตรง
// ลำดับสไลด์และข้อความบนจอแสดงผล iPad (ข้อมูลจาก display_content ใน 0013/0014)

export type MediaKind = 'image' | 'video' | 'youtube'

export interface DisplayMedia {
  id: string
  kind: MediaKind
  path: string | null // ไฟล์ที่อัปโหลด (Storage)
  url: string | null // หรือลิงก์ภายนอก
  title: string | null
  caption: string | null
  credit: string | null
  duration_sec: number | null
}

export interface DisplayItem {
  id: string
  name: string
  price: number
  description: string | null
  category: string | null
  media: DisplayMedia[]
}

export interface DisplayPromo {
  id: string
  name: string
  discount_type: 'percent' | 'amount'
  value: number
  min_subtotal: number
  ends_on: string | null
  start_time: string | null
  end_time: string | null
  items: { name: string; image: DisplayMedia | null }[]
}

export interface DisplayContent {
  restaurant: string
  settings?: unknown // ค่าดิบจาก display_settings: ผ่าน normalizeSettings ก่อนใช้
  items: DisplayItem[]
  promotions: DisplayPromo[]
  ads: DisplayMedia[]
}

export type Slide =
  | { kind: 'cover'; key: string }
  | { kind: 'item'; key: string; item: DisplayItem; media: DisplayMedia | null; layout: 'full' | 'split'; promo: DisplayPromo | null }
  | { kind: 'promo'; key: string; promo: DisplayPromo }
  | { kind: 'ad'; key: string; media: DisplayMedia }

const money = (n: number) => '฿' + Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 })

// ตัวเลขใหญ่บนสไลด์โปร เช่น "20%" หรือ "฿50"
export function promoHeadline(p: Pick<DisplayPromo, 'discount_type' | 'value'>): string {
  return p.discount_type === 'percent' ? `${Number(p.value)}%` : money(p.value)
}

// เงื่อนไขสั้นๆ ใต้ตัวเลข
export function promoTerms(p: DisplayPromo): string[] {
  const terms: string[] = []
  terms.push(p.items.length > 0 ? `เฉพาะ ${p.items.map((i) => i.name).join(' · ')}` : 'ทั้งบิล')
  if (Number(p.min_subtotal) > 0) terms.push(`เมื่อสั่งครบ ${money(p.min_subtotal)}`)
  if (p.end_time) terms.push(`วันนี้ถึง ${p.end_time.slice(0, 5)} น.`)
  if (p.ends_on) terms.push(`ถึงวันที่ ${Number(p.ends_on.slice(8, 10))}/${Number(p.ends_on.slice(5, 7))}`)
  return terms
}

// ===== ตั้งค่าหน้าตาจอ (display_settings ใน 0015) =====
// ชนิดข้อความที่หน้าจัดการส่งค่าตั้งค่า (ยังไม่บันทึก) ไปให้จอพรีวิวใน iframe
export const PREVIEW_MESSAGE = 'foodflow-display-preview'

export const DISPLAY_FONTS = {
  plex: { label: 'IBM Plex Sans Thai (ค่าเริ่มต้น)', family: '"IBM Plex Sans Thai"', google: null },
  kanit: { label: 'Kanit (หนา ทันสมัย)', family: 'Kanit', google: 'Kanit:wght@400;600;800' },
  prompt: { label: 'Prompt (กลม อ่านง่าย)', family: 'Prompt', google: 'Prompt:wght@400;600;800' },
  mitr: { label: 'Mitr (เป็นกันเอง)', family: 'Mitr', google: 'Mitr:wght@400;600;700' },
  chakra: { label: 'Chakra Petch (สตรีท)', family: '"Chakra Petch"', google: 'Chakra+Petch:wght@400;600;700' },
} as const
export type DisplayFont = keyof typeof DISPLAY_FONTS

export interface DisplaySettings {
  accent: string // สีหลัก #rrggbb
  theme: 'light' | 'dark' // พื้นหน้านิตยสาร: กระดาษครีม หรือ ดำ
  font: DisplayFont
  transition: 'fade' | 'slide' | 'zoom'
  imageSeconds: number // สไลด์รูป/เมนูไม่มีสื่อ
  promoSeconds: number
  showCover: boolean
  showProgress: boolean
  showClock: boolean
  showPrice: boolean
  badgeText: string // ป้ายบนสไลด์เมนู
  tagline: string // ข้อความหน้าปก (ว่าง = นับเมนู/โปรให้อัตโนมัติ)
}

export const DEFAULT_SETTINGS: DisplaySettings = {
  accent: '#f97316',
  theme: 'light',
  font: 'plex',
  transition: 'fade',
  imageSeconds: 9,
  promoSeconds: 8,
  showCover: true,
  showProgress: true,
  showClock: true,
  showPrice: true,
  badgeText: 'ร้านแนะนำ',
  tagline: '',
}

const HEX = /^#[0-9a-f]{6}$/i
const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  options.includes(v as T) ? (v as T) : fallback
const sec = (v: unknown, fallback: number) => (Number.isInteger(v) && (v as number) >= 3 && (v as number) <= 60 ? (v as number) : fallback)
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
const text = (v: unknown, max: number, fallback: string) => (typeof v === 'string' ? v.slice(0, max) : fallback)

// ค่าที่ไม่ถูกต้อง/ไม่รู้จักใช้ค่าเริ่มต้นแทน (จอไม่พังแม้ข้อมูลเสีย)
export function normalizeSettings(raw: unknown): DisplaySettings {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const d = DEFAULT_SETTINGS
  return {
    accent: typeof r.accent === 'string' && HEX.test(r.accent) ? r.accent.toLowerCase() : d.accent,
    theme: pick(r.theme, ['light', 'dark'] as const, d.theme),
    font: pick(r.font, Object.keys(DISPLAY_FONTS) as DisplayFont[], d.font),
    transition: pick(r.transition, ['fade', 'slide', 'zoom'] as const, d.transition),
    imageSeconds: sec(r.imageSeconds, d.imageSeconds),
    promoSeconds: sec(r.promoSeconds, d.promoSeconds),
    showCover: bool(r.showCover, d.showCover),
    showProgress: bool(r.showProgress, d.showProgress),
    showClock: bool(r.showClock, d.showClock),
    showPrice: bool(r.showPrice, d.showPrice),
    badgeText: text(r.badgeText, 20, d.badgeText),
    tagline: text(r.tagline, 80, d.tagline),
  }
}

// ปก → เมนูแนะนำ 2 เมนู → โปรหรือสไลด์โฆษณา (สลับกัน) → ... (ที่เหลือต่อท้าย)
// round = รอบที่เล่น: เมนูที่มีหลายสื่อจะเปลี่ยนสื่อทุกรอบ
export function buildSlides(c: DisplayContent, round = 0, showCover = true): Slide[] {
  const slides: Slide[] = [{ kind: 'cover', key: 'cover' }]
  const promoOf = (name: string) => c.promotions.find((p) => p.items.some((i) => i.name === name)) ?? null

  const extras: Slide[] = []
  for (let i = 0; i < Math.max(c.promotions.length, c.ads.length); i++) {
    const promo = c.promotions[i]
    const ad = c.ads[i]
    if (promo) extras.push({ kind: 'promo', key: `promo-${promo.id}`, promo })
    if (ad) extras.push({ kind: 'ad', key: `ad-${ad.id}`, media: ad })
  }

  c.items.forEach((item, i) => {
    const media = item.media.length > 0 ? item.media[round % item.media.length] : null
    slides.push({
      kind: 'item',
      key: `item-${item.id}-${media?.id ?? 'none'}`,
      item,
      media,
      layout: media && i % 3 !== 2 ? 'full' : 'split',
      promo: promoOf(item.name),
    })
    if (i % 2 === 1 && extras.length > 0) slides.push(extras.shift()!)
  })
  const all = [...slides, ...extras]
  // ปิดหน้าปกได้ ถ้ายังมีสไลด์อื่น (ไม่มีเลยก็ยังแสดงปกให้จอไม่ว่าง)
  return !showCover && all.length > 1 ? all.slice(1) : all
}

// เวลาแสดงแต่ละสไลด์ (มิลลิวินาที)
// ตั้งเวลาเองได้ต่อสื่อ · วิดีโอเล่นจนจบแต่ไม่ต่ำกว่า 8 และไม่เกิน 30 วินาที · YouTube รู้ความยาวไม่ได้ ใช้ 30 วินาที
export function slideDuration(s: Slide, videoSeconds?: number, settings: DisplaySettings = DEFAULT_SETTINGS): number {
  if (s.kind === 'cover') return 6000
  if (s.kind === 'promo') return settings.promoSeconds * 1000
  const media = s.media
  if (media?.duration_sec) return media.duration_sec * 1000
  if (media?.kind === 'youtube') return 30000
  if (media?.kind === 'video' && videoSeconds && Number.isFinite(videoSeconds))
    return Math.min(30, Math.max(8, videoSeconds)) * 1000
  return settings.imageSeconds * 1000
}

// ===== ลิงก์สื่อภายนอก =====
export function youtubeId(link: string): string | null {
  const m = link
    .trim()
    .match(/^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?:[?&#/].*)?$/)
  return m ? m[1] : null
}

// แปลงลิงก์ที่วางมาเป็นสื่อ: YouTube / ไฟล์วิดีโอ / ไฟล์รูป (ต้องเป็น https)
export function parseMediaLink(link: string): { kind: MediaKind; url: string } | { error: string } {
  const text = link.trim()
  const yt = youtubeId(text)
  if (yt) return { kind: 'youtube', url: `https://www.youtube.com/watch?v=${yt}` }
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return { error: 'ลิงก์ไม่ถูกต้อง' }
  }
  if (u.protocol !== 'https:') return { error: 'ลิงก์ต้องขึ้นต้นด้วย https://' }
  if (/\.(mp4|webm|mov|m4v)$/i.test(u.pathname)) return { kind: 'video', url: u.href }
  if (/\.(jpe?g|png|webp|gif|avif)$/i.test(u.pathname)) return { kind: 'image', url: u.href }
  return { error: 'ใช้ได้กับลิงก์ YouTube หรือลิงก์ไฟล์ที่ลงท้ายด้วย .mp4 .webm .mov .jpg .png .webp' }
}

export function youtubeEmbed(url: string): string | null {
  const id = youtubeId(url)
  return id
    ? `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&loop=1&playlist=${id}&controls=0&playsinline=1&modestbranding=1&rel=0&enablejsapi=1`
    : null
}

// ===== ล้างไฟล์ที่ไม่ได้ใช้ใน Storage =====
// ไฟล์ในโฟลเดอร์ร้านที่ไม่มีสื่อไหนอ้างถึง (รวมรูปพื้นหลังโปสเตอร์) และเก่ากว่า minAgeMs
// (เว้นไฟล์ใหม่ไว้ เผื่อกำลังอัปโหลด/สร้างโปสเตอร์อยู่)
export function unusedMediaFiles(
  folder: string,
  files: { name: string; created_at: string | null; id: string | null }[],
  refs: { storage_path: string | null; poster?: unknown }[],
  publicPrefix: string,
  now: number,
  minAgeMs = 24 * 60 * 60 * 1000,
): string[] {
  const used = new Set<string>()
  for (const r of refs) {
    if (r.storage_path) used.add(r.storage_path)
    const img = (r.poster as { image?: unknown } | null | undefined)?.image
    if (typeof img === 'string' && img.startsWith(publicPrefix)) used.add(decodeURIComponent(img.slice(publicPrefix.length)))
  }
  return files
    .filter((f) => f.id !== null) // id ว่าง = โฟลเดอร์ย่อย
    .map((f) => ({ path: `${folder}/${f.name}`, at: f.created_at ? Date.parse(f.created_at) : 0 }))
    .filter((f) => !used.has(f.path) && now - f.at >= minAgeMs)
    .map((f) => f.path)
}
