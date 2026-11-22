// อ่าน CSV ยอดขายย้อนหลัง แล้วตรวจทีละแถว
// แถวไหนผิดจะรายงานเลขบรรทัด + เหตุผล และไม่นำเข้าเลยทั้งไฟล์ (ไม่นำเข้าแบบเงียบๆ)
// + ตัวสร้างรายงานภาษีตามแบบกรมสรรพากร (ท้ายไฟล์)
import { toCsv, type Cell } from '../../frontend/src/lib/accounting.ts'

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
  let closed = false
  const s = text.replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else { quoted = false; closed = true }
      } else field += ch
    } else if (ch === '"') {
      if (field !== '' || closed) throw new Error('invalid_csv_quotes')
      quoted = true
    }
    else if (ch === ',') {
      row.push(field)
      field = ''
      closed = false
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      closed = false
    } else {
      if (closed) throw new Error('invalid_csv_quotes')
      field += ch
    }
  }
  if (quoted) throw new Error('invalid_csv_quotes')
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
  let table: string[][]
  try { table = parseCsv(text) } catch { return { rows: [], errors: [{ line: 1, message: 'invalid_csv_quotes' }] } }
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
    const rawPrice = cell('price')
    const price = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(rawPrice) ? rawPrice.replace(/,/g, '') : rawPrice

    const problems: string[] = []
    if (cell('ref').length > 100) problems.push('reference_too_long')
    if (r.length !== table[0].length) problems.push('invalid_column_count')
    if (price && Number(price) > 100_000_000) problems.push('price_too_large')
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
    rows.push({ line, ref: cell('ref'), at: `${date} ${time}`, item, qty, price })
  }

  if (rows.length + errors.length === 0) errors.push({ line: 2, message: 'ไม่มีแถวข้อมูล' })
  if (rows.length > MAX_ROWS) errors.push({ line: 1, message: `นำเข้าได้ครั้งละไม่เกิน ${MAX_ROWS} แถว` })
  return { rows, errors }
}

// ===== รายงานภาษีตามแบบกรมสรรพากร (ภาษีขาย / ภาษีซื้อ / ภ.พ.30 / ภ.ง.ด.3, 53) =====
// ฟังก์ชันล้วน (ไม่เรียกฐานข้อมูล) / route อยู่ที่ accounting.ts / รวมยอดเป็นสตางค์กันทศนิยมเพี้ยน
// หมายเหตุ: ข้อมูลประกอบการยื่น ไม่ใช่การยื่นภาษีอย่างเป็นทางการ ควรให้นักบัญชีตรวจ

const satang = (v: unknown) => Math.round(Number(v ?? 0) * 100)
const baht = (s: number) => s / 100

const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม']

// 'YYYY-MM' → ช่วงวันที่ของเดือนภาษี (null = รูปแบบผิด)
export function monthRange(month: unknown): { month: string; from: string; to: string; label: string } | null {
  const m = typeof month === 'string' ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month) : null
  if (!m) return null
  const y = +m[1]
  const mo = +m[2]
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  return { month: month as string, from: `${month}-01`, to: `${month}-${pad(last)}`, label: `${TH_MONTHS[mo - 1]} ${y + 543}` }
}

// 'YYYY-MM-DD' → 'DD/MM/พ.ศ.'
export function thaiDate(d: string | null | undefined): string {
  const m = d ? /^(\d{4})-(\d{2})-(\d{2})/.exec(d) : null
  return m ? `${m[3]}/${m[2]}/${+m[1] + 543}` : ''
}

export const branchLabel = (code: string | null | undefined) => (!code ? '' : code === '00000' ? 'สำนักงานใหญ่' : `สาขาที่ ${code}`)

export interface TaxDocRow {
  id: string
  doc_type: 'ABB' | 'TAX' | 'CN'
  doc_number: string
  issue_date: string
  terminal_code: string | null
  ref_document_id: string | null
  buyer_name: string | null
  buyer_tax_id: string | null
  buyer_branch_code: string | null
  taxable_amount: number | string
  exempt_amount: number | string
  vat_amount: number | string
  total_amount: number | string
  credit_note_reason?: string | null
}

export interface SalesTaxLine {
  no: number
  date: string
  doc_number: string
  doc_type: 'ABB' | 'TAX' | 'CN'
  buyer_name: string
  buyer_tax_id: string
  branch: string
  taxable: number
  exempt: number
  vat: number
  total: number
  note: string
}

export interface TaxTotals {
  taxable: number
  exempt: number
  vat: number
  total: number
}

// รายงานภาษีขาย
//   - ใบกำกับภาษีอย่างย่อ (ABB) รวม 1 บรรทัดต่อวันต่อเครื่อง พร้อมช่วงเลขที่
//   - ใบเต็มรูปที่ออกแทน ABB: แสดงอ้างอิงแต่ยอด 0 (ยอดนับใน ABB เดือนที่ขายแล้ว ไม่นับซ้ำ และไม่ย้อนแก้เดือนเก่า)
//   - ใบลดหนี้: ยอดติดลบ
export function salesTaxReport(docs: TaxDocRow[], refs: Map<string, { doc_number: string; doc_type: string }>) {
  interface Acc { date: string; doc_number: string; doc_type: SalesTaxLine['doc_type']; buyer_name: string; buyer_tax_id: string; branch: string; note: string; t: number; e: number; v: number; g: number }
  const lines: Acc[] = []
  const abb = new Map<string, Acc & { first: string; last: string; count: number }>()
  const sorted = [...docs].sort((a, b) => a.issue_date.localeCompare(b.issue_date) || a.doc_number.localeCompare(b.doc_number))
  for (const d of sorted) {
    const sign = d.doc_type === 'CN' ? -1 : 1
    const t = sign * satang(d.taxable_amount)
    const e = sign * satang(d.exempt_amount)
    const v = sign * satang(d.vat_amount)
    const g = sign * satang(d.total_amount)
    if (d.doc_type === 'ABB') {
      const key = `${d.issue_date}|${d.terminal_code ?? ''}`
      const cur = abb.get(key)
      if (cur) {
        cur.t += t; cur.e += e; cur.v += v; cur.g += g; cur.count++
        if (d.doc_number < cur.first) cur.first = d.doc_number
        if (d.doc_number > cur.last) cur.last = d.doc_number
      } else {
        const row = { date: d.issue_date, doc_number: d.doc_number, doc_type: 'ABB' as const, buyer_name: '', buyer_tax_id: '', branch: '', note: '', t, e, v, g, first: d.doc_number, last: d.doc_number, count: 1 }
        abb.set(key, row)
        lines.push(row)
      }
      continue
    }
    const ref = d.ref_document_id ? refs.get(d.ref_document_id) : undefined
    const replacesAbb = d.doc_type === 'TAX' && ref?.doc_type === 'ABB'
    const k = replacesAbb ? 0 : 1
    lines.push({
      date: d.issue_date, doc_number: d.doc_number, doc_type: d.doc_type,
      buyer_name: d.buyer_name ?? '', buyer_tax_id: d.buyer_tax_id ?? '', branch: branchLabel(d.buyer_branch_code),
      t: t * k, e: e * k, v: v * k, g: g * k,
      note: d.doc_type === 'CN'
        ? `ลดหนี้ใบกำกับภาษีเลขที่ ${ref?.doc_number ?? '-'}${d.credit_note_reason ? ` (${d.credit_note_reason})` : ''}`
        : replacesAbb ? `ออกแทนใบกำกับภาษีอย่างย่อเลขที่ ${ref!.doc_number} (ยอดรวมในใบอย่างย่อแล้ว)` : '',
    })
  }
  for (const r of abb.values()) {
    r.doc_number = r.first === r.last ? r.first : `${r.first} - ${r.last}`
    r.buyer_name = `ขายปลีก (ใบกำกับภาษีอย่างย่อ ${r.count} ใบ)`
  }
  const tot = { t: 0, e: 0, v: 0, g: 0 }
  const rows: SalesTaxLine[] = lines.map((l, i) => {
    tot.t += l.t; tot.e += l.e; tot.v += l.v; tot.g += l.g
    return {
      no: i + 1, date: l.date, doc_number: l.doc_number, doc_type: l.doc_type, buyer_name: l.buyer_name, buyer_tax_id: l.buyer_tax_id,
      branch: l.branch, taxable: baht(l.t), exempt: baht(l.e), vat: baht(l.v), total: baht(l.g), note: l.note,
    }
  })
  const totals: TaxTotals = { taxable: baht(tot.t), exempt: baht(tot.e), vat: baht(tot.v), total: baht(tot.g) }
  return { rows, totals }
}

export interface PurchaseExpenseRow {
  tax_invoice_date: string
  tax_invoice_no: string
  supplier_name: string
  supplier_tax_id: string
  supplier_branch_code: string | null
  amount: number | string
  vat_amount: number | string
  spent_on: string
}

export interface PurchaseTaxLine {
  no: number
  invoice_date: string
  invoice_no: string
  supplier_name: string
  supplier_tax_id: string
  branch: string
  value: number
  vat: number
  total: number
  posted_on: string
}

// รายงานภาษีซื้อ (รายจ่ายที่มีใบกำกับภาษีซื้อ ยังไม่ยกเลิก)
export function purchaseTaxReport(expenses: PurchaseExpenseRow[]) {
  const tot = { v: 0, t: 0, g: 0 }
  const rows: PurchaseTaxLine[] = [...expenses]
    .sort((a, b) => a.tax_invoice_date.localeCompare(b.tax_invoice_date) || a.tax_invoice_no.localeCompare(b.tax_invoice_no))
    .map((x, i) => {
      const g = satang(x.amount)
      const t = satang(x.vat_amount)
      tot.v += g - t; tot.t += t; tot.g += g
      return {
        no: i + 1, invoice_date: x.tax_invoice_date, invoice_no: x.tax_invoice_no, supplier_name: x.supplier_name,
        supplier_tax_id: x.supplier_tax_id, branch: branchLabel(x.supplier_branch_code),
        value: baht(g - t), vat: baht(t), total: baht(g), posted_on: x.spent_on,
      }
    })
  return { rows, totals: { value: baht(tot.v), vat: baht(tot.t), total: baht(tot.g) } }
}

// ภ.พ.30: ภาษีขาย - ภาษีซื้อ (บวก = ต้องชำระ / ลบ = ชำระเกิน ยกไปเดือนถัดไป/ขอคืน)
export function pp30Summary(sales: TaxTotals, purchases: { value: number; vat: number }) {
  const net = satang(sales.vat) - satang(purchases.vat)
  return {
    sales_total: baht(satang(sales.taxable) + satang(sales.exempt)),
    sales_exempt_or_zero: sales.exempt,
    sales_taxable: sales.taxable,
    output_vat: sales.vat,
    purchases_eligible: purchases.value,
    input_vat: purchases.vat,
    net_vat: baht(net),
    vat_payable: net > 0 ? baht(net) : 0,
    vat_credit: net < 0 ? baht(-net) : 0,
  }
}

export interface WhtExpenseRow {
  spent_on: string
  supplier_name: string
  supplier_tax_id: string
  supplier_branch_code: string | null
  amount: number | string
  vat_amount: number | string
  wht_rate: number | string
  wht_amount: number | string
  wht_type: 'pnd3' | 'pnd53'
  note: string | null
  accounts?: { name?: string } | null
}

export interface WhtLine {
  no: number
  form: 'pnd3' | 'pnd53'
  payee_tax_id: string
  branch: string
  payee_name: string
  paid_on: string
  income_type: string
  rate: number
  paid_amount: number
  wht: number
}

// สรุปภาษีหัก ณ ที่จ่าย (ฐาน = ยอดก่อน VAT) แยก ภ.ง.ด.3 / ภ.ง.ด.53
export function whtReport(expenses: WhtExpenseRow[]) {
  const sum = { pnd3: { count: 0, b: 0, w: 0 }, pnd53: { count: 0, b: 0, w: 0 } }
  const rows: WhtLine[] = [...expenses]
    .sort((a, b) => a.wht_type.localeCompare(b.wht_type) || a.spent_on.localeCompare(b.spent_on))
    .map((x, i) => {
      const b = satang(x.amount) - satang(x.vat_amount)
      const w = satang(x.wht_amount)
      const s = sum[x.wht_type]
      s.count++; s.b += b; s.w += w
      return {
        no: i + 1, form: x.wht_type, payee_tax_id: x.supplier_tax_id, branch: branchLabel(x.supplier_branch_code),
        payee_name: x.supplier_name, paid_on: x.spent_on, income_type: x.accounts?.name ?? x.note ?? '',
        rate: Number(x.wht_rate), paid_amount: baht(b), wht: baht(w),
      }
    })
  const fmt = (s: { count: number; b: number; w: number }) => ({ count: s.count, paid_amount: baht(s.b), wht: baht(s.w) })
  return { rows, summary: { pnd3: fmt(sum.pnd3), pnd53: fmt(sum.pnd53), total_wht: baht(sum.pnd3.w + sum.pnd53.w) } }
}

// CSV รายงาน: หัวรายงาน (ผู้ประกอบการ / เดือนภาษี) + บรรทัดว่าง + ตาราง + แถวรวม / UTF-8 BOM เปิดใน Excel ได้
export function reportCsv(title: string, meta: [string, Cell][], header: string[], rows: Cell[][], total?: Cell[]): string {
  return toCsv([title], [...meta.map(([k, v]) => [k, v]), [], header, ...rows, ...(total ? [total] : [])])
}

export const SALES_TAX_HEADER = ['ลำดับ', 'วัน/เดือน/ปี', 'เลขที่ใบกำกับภาษี', 'ชื่อผู้ซื้อสินค้า/ผู้รับบริการ', 'เลขประจำตัวผู้เสียภาษีของผู้ซื้อ', 'สถานประกอบการ', 'มูลค่าสินค้าหรือบริการ', 'มูลค่ายกเว้น/อัตรา 0', 'จำนวนเงินภาษีมูลค่าเพิ่ม', 'รวม', 'หมายเหตุ']
export const salesTaxCells = (r: SalesTaxLine): Cell[] =>
  [r.no, thaiDate(r.date), r.doc_number, r.buyer_name, r.buyer_tax_id, r.branch, r.taxable, r.exempt, r.vat, r.total, r.note]

export const PURCHASE_TAX_HEADER = ['ลำดับ', 'วัน/เดือน/ปี', 'เลขที่ใบกำกับภาษี', 'ชื่อผู้ขายสินค้า/ผู้ให้บริการ', 'เลขประจำตัวผู้เสียภาษีของผู้ขาย', 'สถานประกอบการ', 'มูลค่าสินค้าหรือบริการ', 'จำนวนเงินภาษีมูลค่าเพิ่ม', 'รวม', 'ลงบัญชีวันที่']
export const purchaseTaxCells = (r: PurchaseTaxLine): Cell[] =>
  [r.no, thaiDate(r.invoice_date), r.invoice_no, r.supplier_name, r.supplier_tax_id, r.branch, r.value, r.vat, r.total, thaiDate(r.posted_on)]

export const WHT_HEADER = ['ลำดับ', 'แบบ', 'เลขประจำตัวผู้เสียภาษีผู้มีเงินได้', 'สาขา', 'ชื่อผู้มีเงินได้', 'วันที่จ่าย', 'ประเภทเงินได้', 'อัตราภาษี (%)', 'จำนวนเงินที่จ่าย', 'ภาษีที่หักและนำส่ง']
export const whtCells = (r: WhtLine): Cell[] =>
  [r.no, r.form === 'pnd3' ? 'ภ.ง.ด.3' : 'ภ.ง.ด.53', r.payee_tax_id, r.branch, r.payee_name, thaiDate(r.paid_on), r.income_type, r.rate, r.paid_amount, r.wht]
