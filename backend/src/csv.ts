// อ่าน CSV ยอดขายย้อนหลัง แล้วตรวจทีละแถว
// แถวไหนผิดจะรายงานเลขบรรทัด + เหตุผล และไม่นำเข้าเลยทั้งไฟล์ (ไม่นำเข้าแบบเงียบๆ)

export const MAX_ROWS = 20000

export interface SaleRow {
  line: number // เลขบรรทัดในไฟล์ (หัวตาราง = 1)
  ref: string
  at: string // 'YYYY-MM-DD HH:MM:SS' เวลาท้องถิ่นของร้าน
  item: string
  qty: number
  price: string // '' = ใช้ราคาเมนูปัจจุบัน
}

export interface RowError {
  line: number
  message: string
}

// แยก CSV ตามมาตรฐาน RFC 4180 (รองรับ "..." , "" ภายในเครื่องหมายคำพูด, CRLF)
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const s = text.replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

// ชื่อคอลัมน์ที่รับได้ (ไม่สนตัวพิมพ์/ช่องว่าง)
const ALIASES: Record<string, string[]> = {
  datetime: ['datetime', 'date_time', 'วันเวลา'],
  date: ['date', 'วันที่'],
  time: ['time', 'เวลา'],
  ref: ['ref', 'bill', 'bill_no', 'order', 'order_id', 'receipt', 'เลขที่บิล', 'บิล'],
  item: ['item', 'menu', 'name', 'menu_name', 'เมนู', 'รายการ'],
  qty: ['qty', 'quantity', 'จำนวน'],
  price: ['price', 'unit_price', 'ราคา', 'ราคาต่อหน่วย'],
}

function headerIndex(header: string[]): Record<string, number> {
  const norm = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'))
  const idx: Record<string, number> = {}
  for (const [key, names] of Object.entries(ALIASES)) {
    const i = norm.findIndex((h) => names.includes(h))
    if (i >= 0) idx[key] = i
  }
  return idx
}

const pad = (n: number) => String(n).padStart(2, '0')

// วันที่: YYYY-MM-DD หรือ DD/MM/YYYY (ปี พ.ศ. > 2400 แปลงเป็น ค.ศ. อัตโนมัติ)
export function parseDate(v: string): string | null {
  const t = v.trim()
  let y: number, m: number, d: number
  let mt = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t)
  if (mt) [y, m, d] = [+mt[1], +mt[2], +mt[3]]
  else if ((mt = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) [d, m, y] = [+mt[1], +mt[2], +mt[3]]
  else return null
  if (y > 2400) y -= 543
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return `${y}-${pad(m)}-${pad(d)}`
}

export function parseTime(v: string): string | null {
  const mt = /^(\d{1,2})[:.](\d{2})(?::(\d{2}))?$/.exec(v.trim())
  if (!mt) return null
  const [h, mi, se] = [+mt[1], +mt[2], mt[3] ? +mt[3] : 0]
  if (h > 23 || mi > 59 || se > 59) return null
  return `${pad(h)}:${pad(mi)}:${pad(se)}`
}

export function parseSales(text: string): { rows: SaleRow[]; errors: RowError[] } {
  const table = parseCsv(text)
  const errors: RowError[] = []
  if (table.length < 2) return { rows: [], errors: [{ line: 1, message: 'ไฟล์ไม่มีข้อมูล (ต้องมีหัวตารางและอย่างน้อย 1 แถว)' }] }

  const idx = headerIndex(table[0])
  const missing: string[] = []
  if (idx.datetime === undefined && (idx.date === undefined || idx.time === undefined)) missing.push('datetime (หรือ date + time)')
  if (idx.item === undefined) missing.push('item')
  if (idx.qty === undefined) missing.push('qty')
  if (missing.length) return { rows: [], errors: [{ line: 1, message: `ไม่พบคอลัมน์: ${missing.join(', ')}` }] }

  const rows: SaleRow[] = []
  for (let i = 1; i < table.length; i++) {
    const r = table[i]
    const line = i + 1
    if (r.every((c) => c.trim() === '')) continue // ข้ามบรรทัดว่าง
    const cell = (k: string) => (idx[k] === undefined ? '' : (r[idx[k]] ?? '').trim())

    let date: string | null
    let time: string | null
    if (idx.datetime !== undefined) {
      const [dPart = '', tPart = ''] = cell('datetime').replace('T', ' ').split(/\s+/)
      date = parseDate(dPart)
      time = parseTime(tPart)
    } else {
      date = parseDate(cell('date'))
      time = parseTime(cell('time'))
    }
    const item = cell('item')
    const qtyText = cell('qty')
    const qty = Number(qtyText)
    const price = cell('price').replace(/,/g, '')

    const problems: string[] = []
    if (!date) problems.push('วันที่ไม่ถูกต้อง (ใช้ YYYY-MM-DD หรือ DD/MM/YYYY)')
    if (!time) problems.push('เวลาไม่ถูกต้อง (ใช้ HH:MM)')
    if (!item) problems.push('ไม่มีชื่อเมนู')
    if (item.length > 200) problems.push('ชื่อเมนูยาวเกิน 200 ตัวอักษร')
    if (!/^\d+$/.test(qtyText) || qty < 1 || qty > 1000) problems.push('จำนวนต้องเป็นจำนวนเต็ม 1-1000')
    if (price !== '' && !(/^\d+(\.\d{1,2})?$/.test(price))) problems.push('ราคาต้องเป็นตัวเลขไม่ติดลบ')
    if (problems.length) {
      errors.push({ line, message: problems.join(', ') })
      continue
    }
    rows.push({ line, ref: cell('ref').slice(0, 100), at: `${date} ${time}`, item, qty, price })
  }

  if (rows.length + errors.length === 0) errors.push({ line: 2, message: 'ไม่มีแถวข้อมูล' })
  if (rows.length > MAX_ROWS) errors.push({ line: 1, message: `นำเข้าได้ครั้งละไม่เกิน ${MAX_ROWS} แถว` })
  return { rows, errors }
}
