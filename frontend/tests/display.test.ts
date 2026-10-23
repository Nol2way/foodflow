// ลำดับสไลด์ ข้อความ และลิงก์สื่อบนจอแสดงผล iPad (display_content ใน 0013/0014)
import assert from 'node:assert/strict'
import {
  DEFAULT_SETTINGS,
  buildSlides,
  normalizeSettings,
  parseMediaLink,
  promoHeadline,
  promoTerms,
  slideDuration,
  unusedMediaFiles,
  youtubeId,
} from '../src/lib/display.ts'

const media = (id: string, kind: 'image' | 'video' | 'youtube' = 'image', duration_sec: number | null = null) => ({
  id,
  kind,
  path: null,
  url: `https://x/${id}`,
  title: null,
  caption: null,
  credit: null,
  duration_sec,
})
const item = (id: string, ...m: ReturnType<typeof media>[]) => ({ id, name: `เมนู ${id}`, price: 59, description: null, category: null, media: m })
const promo = (id: string, items: string[] = []) => ({
  id,
  name: `โปร ${id}`,
  discount_type: 'percent' as const,
  value: 20,
  min_subtotal: 0,
  ends_on: null,
  start_time: null,
  end_time: null,
  items: items.map((name) => ({ name, image: null })),
})
const content = (items = [] as ReturnType<typeof item>[], promotions = [] as ReturnType<typeof promo>[], ads = [] as ReturnType<typeof media>[]) => ({
  restaurant: 'ร้าน',
  items,
  promotions,
  ads,
})
let n = 0
const t = (name: string, fn: () => void) => {
  fn()
  n++
  console.log('ok -', name)
}

t('ปก → 2 เมนู → โปร/โฆษณาสลับกัน → ... ที่เหลือต่อท้าย', () =>
  assert.deepEqual(
    buildSlides(content([item('a', media('a1')), item('b'), item('c'), item('d')], [promo('x'), promo('y')], [media('ad1', 'video')])).map((s) => s.key),
    ['cover', 'item-a-a1', 'item-b-none', 'promo-x', 'item-c-none', 'item-d-none', 'ad-ad1', 'promo-y'],
  ))
t('ไม่มีเนื้อหา เหลือแค่ปก', () => assert.equal(buildSlides(content()).length, 1))
t('เมนูที่ร่วมโปรติดป้ายโปร', () => {
  const s = buildSlides(content([item('a')], [promo('x', ['เมนู a'])]))[1]
  assert.equal(s.kind === 'item' && s.promo?.id, 'x')
})
t('เมนูไม่มีสื่อใช้เลย์เอาต์แบบตัวอักษร', () => {
  const s = buildSlides(content([item('a')]))[1]
  assert.equal(s.kind === 'item' && s.layout, 'split')
})
t('หลายสื่อต่อเมนู: เปลี่ยนชิ้นทุกรอบ', () => {
  const c = content([item('a', media('a1'), media('a2', 'video'))])
  const pick = (round: number) => {
    const s = buildSlides(c, round)[1]
    return s.kind === 'item' ? s.media?.id : null
  }
  assert.deepEqual([pick(0), pick(1), pick(2)], ['a1', 'a2', 'a1'])
})
t('ตัวเลขโปร', () => {
  assert.equal(promoHeadline({ discount_type: 'percent', value: 15 }), '15%')
  assert.equal(promoHeadline({ discount_type: 'amount', value: 50 }), '฿50')
})
t('เงื่อนไขโปร', () =>
  assert.deepEqual(promoTerms({ ...promo('x', ['ชาเย็น']), min_subtotal: 300, end_time: '14:00:00', ends_on: '2026-11-05' }), [
    'เฉพาะ ชาเย็น',
    'เมื่อสั่งครบ ฿300',
    'วันนี้ถึง 14:00 น.',
    'ถึงวันที่ 5/11',
  ]))
t('เวลาแสดง: วิดีโอ 8–30 วิ · YouTube 30 วิ · ตั้งเองได้', () => {
  const s = buildSlides(content([item('v', media('v1', 'video'))]))[1]
  assert.equal(slideDuration(s, 3), 8000)
  assert.equal(slideDuration(s, 12.5), 12500)
  assert.equal(slideDuration(s, 120), 30000)
  const yt = buildSlides(content([], [], [media('y', 'youtube')]))[1]
  assert.equal(slideDuration(yt), 30000)
  const fixed = buildSlides(content([], [], [media('f', 'video', 15)]))[1]
  assert.equal(slideDuration(fixed, 100), 15000)
})
t('ลิงก์ YouTube หลายรูปแบบ', () => {
  for (const l of [
    'https://www.youtube.com/watch?v=SGCANs-B8js',
    'https://youtu.be/SGCANs-B8js?si=abc',
    'youtube.com/shorts/SGCANs-B8js',
    'https://m.youtube.com/watch?feature=share&v=SGCANs-B8js',
  ])
    assert.equal(youtubeId(l), 'SGCANs-B8js', l)
  assert.deepEqual(parseMediaLink('https://youtu.be/SGCANs-B8js'), { kind: 'youtube', url: 'https://www.youtube.com/watch?v=SGCANs-B8js' })
})
t('ลิงก์ไฟล์: วิดีโอ/รูป ต้องเป็น https', () => {
  assert.equal((parseMediaLink('https://cdn.example.com/clip.MP4') as { kind: string }).kind, 'video')
  assert.equal((parseMediaLink('https://cdn.example.com/a.webp?x=1') as { kind: string }).kind, 'image')
  assert.ok('error' in parseMediaLink('http://cdn.example.com/a.jpg'))
  assert.ok('error' in parseMediaLink('javascript:alert(1)'))
  assert.ok('error' in parseMediaLink('https://example.com/page'))
})
t('ตั้งค่าจอ: ค่าว่าง/เสีย ใช้ค่าเริ่มต้น', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings([1, 2]), DEFAULT_SETTINGS)
  const bad = normalizeSettings({ accent: 'red;background:url(x)', font: 'comic', theme: 'pink', imageSeconds: 999, showCover: 'yes', badgeText: 5 })
  assert.deepEqual(bad, DEFAULT_SETTINGS)
})
t('ตั้งค่าจอ: ค่าที่ถูกต้องใช้ได้', () => {
  const v = normalizeSettings({ accent: '#16A34A', theme: 'dark', font: 'kanit', transition: 'zoom', imageSeconds: 5, showClock: false, badgeText: 'x'.repeat(50) })
  assert.equal(v.accent, '#16a34a')
  assert.equal(v.theme, 'dark')
  assert.equal(v.font, 'kanit')
  assert.equal(v.transition, 'zoom')
  assert.equal(v.showClock, false)
  assert.equal(v.badgeText.length, 20)
})
t('ตั้งค่าจอ: เวลาต่อสไลด์ และปิดหน้าปก', () => {
  const settings = normalizeSettings({ imageSeconds: 5, promoSeconds: 12 })
  const slides = buildSlides(content([item('a')], [promo('x')]), 0, false)
  assert.deepEqual(
    slides.map((s) => s.key),
    ['item-a-none', 'promo-x'],
  )
  assert.equal(slideDuration(slides[0], undefined, settings), 5000)
  assert.equal(slideDuration(slides[1], undefined, settings), 12000)
  assert.equal(buildSlides(content(), 0, false).length, 1) // ไม่มีอะไรเลย ยังเหลือปก
})
t('ล้างไฟล์: เก็บไฟล์ที่ใช้อยู่ รูปพื้นหลังโปสเตอร์ และไฟล์ใหม่', () => {
  const pre = 'https://x.supabase.co/storage/v1/object/public/menu-media/'
  const now = Date.parse('2026-10-23T12:00:00Z')
  const old = '2026-10-20T00:00:00Z'
  const files = [
    { name: 'used.jpg', created_at: old, id: '1' },
    { name: 'poster-bg-1.jpg', created_at: old, id: '2' },
    { name: 'orphan.mp4', created_at: old, id: '3' },
    { name: 'new.jpg', created_at: '2026-10-23T11:00:00Z', id: '4' },
    { name: 'sub', created_at: null, id: null },
  ]
  const refs = [{ storage_path: 'r1/used.jpg' }, { storage_path: 'r1/poster-9.jpg', poster: { image: pre + 'r1/poster-bg-1.jpg' } }]
  assert.deepEqual(unusedMediaFiles('r1', files, refs, pre, now), ['r1/orphan.mp4'])
})
console.log(`\nผ่าน ${n} ชุดทดสอบ`)
