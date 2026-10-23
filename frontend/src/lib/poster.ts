import { DISPLAY_FONTS, type DisplayFont } from './display'

// โปสเตอร์จากเทมเพลต: วาดลง canvas 1920×1080 แล้วบันทึกเป็นรูปขึ้นจอ iPad
// ค่าที่ใช้สร้างเก็บใน display_media.poster (0015) เพื่อเปิดมาแก้ต่อได้

export const POSTER_W = 1920
export const POSTER_H = 1080

export type PosterTemplate = 'bold' | 'magazine' | 'minimal' | 'burst'

export interface PosterSpec {
  template: PosterTemplate
  title: string
  subtitle: string
  price: string
  badge: string
  bg: string
  accent: string
  ink: string
  font: DisplayFont
  image: string | null // ลิงก์รูปพื้นหลัง (https)
}

export const POSTER_TEMPLATES: Record<PosterTemplate, { label: string; hint: string; colors: Pick<PosterSpec, 'bg' | 'accent' | 'ink'> }> = {
  bold: { label: 'ภาพเต็มจอ', hint: 'รูปอาหารเต็มพื้นหลัง ตัวหนังสือใหญ่ด้านซ้าย', colors: { bg: '#111111', accent: '#f97316', ink: '#ffffff' } },
  magazine: { label: 'หน้านิตยสาร', hint: 'ตัวหนังสือซ้าย รูปขวา พื้นกระดาษ', colors: { bg: '#fbf6ef', accent: '#ea580c', ink: '#1f2937' } },
  minimal: { label: 'มินิมอล', hint: 'พื้นสีเรียบ รูปวงกลมตรงกลาง', colors: { bg: '#ffffff', accent: '#f97316', ink: '#111827' } },
  burst: { label: 'โปรแรง', hint: 'พื้นสีสด ข้อความป้ายตัวใหญ่ เหมาะกับโปร', colors: { bg: '#f97316', accent: '#fde047', ink: '#ffffff' } },
}

export const DEFAULT_POSTER: PosterSpec = {
  template: 'bold',
  title: 'เมนูแนะนำ',
  subtitle: '',
  price: '',
  badge: 'ร้านแนะนำ',
  ...POSTER_TEMPLATES.bold.colors,
  font: 'plex',
  image: null,
}

const HEX = /^#[0-9a-f]{6}$/i
const str = (v: unknown, max: number, d: string) => (typeof v === 'string' ? v.slice(0, max) : d)
const hex = (v: unknown, d: string) => (typeof v === 'string' && HEX.test(v) ? v : d)

export function normalizePoster(raw: unknown): PosterSpec {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const template = (Object.keys(POSTER_TEMPLATES) as PosterTemplate[]).includes(r.template as PosterTemplate)
    ? (r.template as PosterTemplate)
    : DEFAULT_POSTER.template
  const c = POSTER_TEMPLATES[template].colors
  return {
    template,
    title: str(r.title, 80, DEFAULT_POSTER.title),
    subtitle: str(r.subtitle, 160, ''),
    price: str(r.price, 30, ''),
    badge: str(r.badge, 30, DEFAULT_POSTER.badge),
    bg: hex(r.bg, c.bg),
    accent: hex(r.accent, c.accent),
    ink: hex(r.ink, c.ink),
    font: r.font && typeof r.font === 'string' && r.font in DISPLAY_FONTS ? (r.font as DisplayFont) : 'plex',
    image: typeof r.image === 'string' && r.image.startsWith('https://') ? r.image.slice(0, 1000) : null,
  }
}

// โหลดรูปแบบ CORS เพื่อให้ canvas ส่งออกเป็นไฟล์ได้ (ไม่ได้ = null)
export function loadPosterImage(url: string | null): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null)
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

// ===== ตัวช่วยวาด =====
type Ctx = CanvasRenderingContext2D

const family = (spec: PosterSpec) => `${DISPLAY_FONTS[spec.font].family}, "IBM Plex Sans Thai", sans-serif`

// ภาษาไทยไม่มีเว้นวรรค: ตัดคำด้วย Intl.Segmenter (ถ้ามี) ไม่งั้นตัดทีละตัวอักษร
function segments(text: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: 'word' }) => { segment: (t: string) => Iterable<{ segment: string }> } })
    .Segmenter
  return Seg ? Array.from(new Seg('th', { granularity: 'word' }).segment(text), (s) => s.segment) : Array.from(text)
}

function wrap(ctx: Ctx, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = []
  let cur = ''
  for (const seg of segments(text)) {
    const next = cur + seg
    if (ctx.measureText(next).width > maxWidth && cur.trim()) {
      lines.push(cur.trimEnd())
      cur = seg.trimStart()
    } else cur = next
  }
  if (cur.trim()) lines.push(cur.trimEnd())
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines)
    let last = kept[maxLines - 1]
    while (last && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1)
    kept[maxLines - 1] = last + '…'
    return kept
  }
  return lines
}

// ลดขนาดตัวอักษรจนพอดีจำนวนบรรทัด
function fit(ctx: Ctx, spec: PosterSpec, text: string, weight: number, max: number, min: number, width: number, lines: number) {
  for (let size = max; size >= min; size -= 4) {
    ctx.font = `${weight} ${size}px ${family(spec)}`
    const out = wrap(ctx, text, width, 99)
    if (out.length <= lines) return { size, lines: out }
  }
  ctx.font = `${weight} ${min}px ${family(spec)}`
  return { size: min, lines: wrap(ctx, text, width, lines) }
}

function textBlock(ctx: Ctx, lines: string[], x: number, y: number, size: number, lineHeight = 1.12): number {
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * size * lineHeight))
  return y + lines.length * size * lineHeight
}

function cover(ctx: Ctx, img: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const s = Math.max(w / img.width, h / img.height)
  const sw = w / s
  const sh = h / s
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h)
}

function pill(ctx: Ctx, spec: PosterSpec, text: string, x: number, y: number, size: number, fill: string, color: string, align: 'left' | 'center' = 'left') {
  ctx.font = `700 ${size}px ${family(spec)}`
  const w = ctx.measureText(text).width + size * 1.4
  const h = size * 1.7
  const left = align === 'center' ? x - w / 2 : x
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.roundRect(left, y, w, h, h / 2)
  ctx.fill()
  ctx.fillStyle = color
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.fillText(text, left + w / 2, y + h / 2 + size * 0.05)
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  return h
}

function withAlpha(hexColor: string, alpha: number) {
  const n = parseInt(hexColor.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

// ===== เทมเพลต =====
export function drawPoster(ctx: Ctx, spec: PosterSpec, img: HTMLImageElement | null) {
  const W = POSTER_W
  const H = POSTER_H
  ctx.save()
  ctx.clearRect(0, 0, W, H)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  if (spec.template === 'bold') {
    ctx.fillStyle = spec.bg
    ctx.fillRect(0, 0, W, H)
    if (img) cover(ctx, img, 0, 0, W, H)
    const g = ctx.createLinearGradient(0, 0, W * 0.75, 0)
    g.addColorStop(0, withAlpha(spec.bg, 0.92))
    g.addColorStop(0.55, withAlpha(spec.bg, 0.55))
    g.addColorStop(1, withAlpha(spec.bg, 0))
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
    let y = 150
    if (spec.badge) y += pill(ctx, spec, spec.badge, 120, y, 40, spec.accent, '#ffffff') + 50
    ctx.fillStyle = spec.ink
    const t = fit(ctx, spec, spec.title, 800, 170, 80, 1050, 3)
    y = textBlock(ctx, t.lines, 120, y + t.size * 0.85, t.size)
    if (spec.subtitle) {
      ctx.font = `400 46px ${family(spec)}`
      ctx.fillStyle = withAlpha(spec.ink, 0.88)
      y = textBlock(ctx, wrap(ctx, spec.subtitle, 950, 3), 120, y + 40, 46, 1.4)
    }
    if (spec.price) pill(ctx, spec, spec.price, 120, Math.min(y + 50, H - 200), 72, spec.accent, '#ffffff')
  }

  if (spec.template === 'magazine') {
    ctx.fillStyle = spec.bg
    ctx.fillRect(0, 0, W, H)
    if (img) cover(ctx, img, 880, 0, W - 880, H)
    else {
      ctx.fillStyle = spec.accent
      ctx.fillRect(880, 0, W - 880, H)
    }
    ctx.fillStyle = spec.accent
    let y = 190
    if (spec.badge) {
      ctx.font = `700 40px ${family(spec)}`
      ctx.fillText(spec.badge.toUpperCase(), 120, y)
      y += 50
    }
    ctx.fillStyle = spec.ink
    const t = fit(ctx, spec, spec.title, 800, 150, 64, 660, 4)
    y = textBlock(ctx, t.lines, 120, y + t.size, t.size, 1.08)
    ctx.fillStyle = spec.accent
    ctx.beginPath()
    ctx.roundRect(120, y + 30, 140, 12, 6)
    ctx.fill()
    y += 90
    if (spec.subtitle) {
      ctx.font = `400 42px ${family(spec)}`
      ctx.fillStyle = withAlpha(spec.ink, 0.72)
      y = textBlock(ctx, wrap(ctx, spec.subtitle, 660, 4), 120, y + 30, 42, 1.4)
    }
    if (spec.price) {
      ctx.font = `800 96px ${family(spec)}`
      ctx.fillStyle = spec.ink
      ctx.fillText(spec.price, 120, Math.min(y + 130, H - 110))
    }
  }

  if (spec.template === 'minimal') {
    ctx.fillStyle = spec.bg
    ctx.fillRect(0, 0, W, H)
    ctx.textAlign = 'center'
    let y = 140
    if (img) {
      ctx.save()
      ctx.beginPath()
      ctx.arc(W / 2, 330, 210, 0, Math.PI * 2)
      ctx.clip()
      cover(ctx, img, W / 2 - 210, 120, 420, 420)
      ctx.restore()
      ctx.strokeStyle = spec.accent
      ctx.lineWidth = 10
      ctx.beginPath()
      ctx.arc(W / 2, 330, 222, 0, Math.PI * 2)
      ctx.stroke()
      y = 600
    } else if (spec.badge) {
      y = 260
    }
    if (spec.badge) {
      ctx.font = `600 36px ${family(spec)}`
      ctx.fillStyle = spec.accent
      ctx.textAlign = 'center'
      ctx.fillText(spec.badge, W / 2, y + 30)
      y += 50
    }
    ctx.fillStyle = spec.ink
    ctx.textAlign = 'center'
    const t = fit(ctx, spec, spec.title, 800, img ? 120 : 170, 60, 1500, 2)
    y = textBlock(ctx, t.lines, W / 2, y + t.size, t.size)
    if (spec.subtitle) {
      ctx.font = `400 40px ${family(spec)}`
      ctx.fillStyle = withAlpha(spec.ink, 0.65)
      ctx.textAlign = 'center'
      y = textBlock(ctx, wrap(ctx, spec.subtitle, 1300, 2), W / 2, y + 30, 40, 1.4)
    }
    if (spec.price) {
      ctx.font = `800 84px ${family(spec)}`
      ctx.fillStyle = spec.accent
      ctx.textAlign = 'center'
      ctx.fillText(spec.price, W / 2, Math.min(y + 110, H - 70))
    }
  }

  if (spec.template === 'burst') {
    ctx.fillStyle = spec.bg
    ctx.fillRect(0, 0, W, H)
    if (img) {
      ctx.globalAlpha = 0.18
      cover(ctx, img, 0, 0, W, H)
      ctx.globalAlpha = 1
    }
    // แสงพุ่งจากกลางภาพ
    ctx.fillStyle = withAlpha('#ffffff', 0.09)
    for (let i = 0; i < 24; i += 2) {
      const a1 = (i / 24) * Math.PI * 2
      const a2 = ((i + 1) / 24) * Math.PI * 2
      ctx.beginPath()
      ctx.moveTo(W / 2, H / 2)
      ctx.lineTo(W / 2 + Math.cos(a1) * W, H / 2 + Math.sin(a1) * W)
      ctx.lineTo(W / 2 + Math.cos(a2) * W, H / 2 + Math.sin(a2) * W)
      ctx.closePath()
      ctx.fill()
    }
    ctx.textAlign = 'center'
    let y = 120
    if (spec.badge) {
      ctx.fillStyle = spec.accent
      const b = fit(ctx, spec, spec.badge, 800, 300, 120, 1700, 1)
      ctx.textAlign = 'center'
      ctx.shadowColor = 'rgba(0,0,0,0.25)'
      ctx.shadowBlur = 30
      y = textBlock(ctx, b.lines, W / 2, y + b.size * 0.95, b.size, 1)
      ctx.shadowBlur = 0
    }
    ctx.fillStyle = spec.ink
    const t = fit(ctx, spec, spec.title, 800, 110, 56, 1600, 2)
    ctx.textAlign = 'center'
    y = textBlock(ctx, t.lines, W / 2, y + t.size + 20, t.size)
    if (spec.subtitle) {
      ctx.font = `500 42px ${family(spec)}`
      ctx.fillStyle = withAlpha(spec.ink, 0.9)
      ctx.textAlign = 'center'
      y = textBlock(ctx, wrap(ctx, spec.subtitle, 1400, 2), W / 2, y + 20, 42, 1.4)
    }
    if (spec.price) pill(ctx, spec, spec.price, W / 2, Math.min(y + 40, H - 170), 64, spec.ink, spec.bg, 'center')
  }
  ctx.restore()
}
