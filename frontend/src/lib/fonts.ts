import { DISPLAY_FONTS, type DisplayFont } from './display'

// โหลดฟอนต์ที่เลือกจาก Google Fonts (ครั้งเดียวต่อฟอนต์) แล้วรอจนพร้อมวาด
export async function loadDisplayFont(font: DisplayFont, weight = 800): Promise<void> {
  const f = DISPLAY_FONTS[font]
  if (f.google && !document.getElementById(`font-${font}`)) {
    const link = document.createElement('link')
    link.id = `font-${font}`
    link.rel = 'stylesheet'
    link.href = `https://fonts.googleapis.com/css2?family=${f.google}&display=swap`
    document.head.appendChild(link)
    await new Promise((resolve) => {
      link.onload = resolve
      link.onerror = resolve
    })
  }
  try {
    await document.fonts.load(`${weight} 64px ${f.family}`, 'กขabc')
  } catch {
    // ฟอนต์โหลดไม่ได้: ใช้ฟอนต์สำรองของเครื่อง
  }
}
