// เอกสารภาษีตามกรมสรรพากร (0031/0032) · ทำงานในเครื่องทั้งหมด ไม่เรียก API ภายนอก
//   ABB = ใบกำกับภาษีอย่างย่อ · TAX = ใบเสร็จรับเงิน/ใบกำกับภาษี (เต็มรูป) · CN = ใบลดหนี้
//   สร้างฉบับร่าง → ยืนยันเอง (ออกเลขไม่ขาดช่วงด้วย next_tax_doc_no + สร้าง XML ETDA เก็บใน xml_payload ในธุรกรรมเดียว)
//   VAT แยกจากยอดรวม: ROUND((total - exempt) * rate / (100 + rate), 2) · rate จาก shop_settings (ปกติ 7)
//   ทุกการเขียนผ่านฟังก์ชัน security definer ด้วย JWT ผู้ใช้ (ฐานข้อมูลตรวจสิทธิ์ซ้ำ)
import type { Context, Hono } from 'hono'
import type { AppEnv, Role } from './env.ts'
import { DbError, asUser } from './supabase.ts'
import type { Helpers } from './accounting.ts'

type Ctx = Context<AppEnv>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TERMINAL = /^[A-Za-z0-9]{1,10}$/
export const DOC_TYPES = ['ABB', 'TAX', 'CN'] as const
export type DocType = (typeof DOC_TYPES)[number]

// ใครออกเอกสารได้ (ตรงกับ tax_doc_roles ในฐานข้อมูล)
export const TAX_ISSUE: Role[] = ['owner', 'manager', 'accountant', 'staff'] // ABB / TAX
export const TAX_CREDIT: Role[] = ['owner', 'manager', 'accountant'] // CN
export const docRoles = (t: DocType) => (t === 'CN' ? TAX_CREDIT : TAX_ISSUE)

// ETDA ขมธอ.3-2560 TypeCode (สร้างจริงในฐานข้อมูล tax_doc_build_xml)
export const ETDA_TYPE_CODE: Record<DocType, string> = { TAX: 'T03', ABB: 'T05', CN: '81' }

// VAT จากยอดรวมภาษี (ใช้แสดงตัวอย่าง/ทดสอบ · ค่าจริงคิดในฐานข้อมูลสูตรเดียวกัน)
export function splitVat(total: number, exempt = 0, rate = 7): { taxable: number; vat: number } {
  const base = Math.round((total - exempt) * 100)
  const vat = Math.round((base * rate) / (100 + rate))
  return { taxable: (base - vat) / 100, vat: vat / 100 }
}

// ข้อความไทยของรหัสข้อผิดพลาดจากฐานข้อมูล (0031)
export const TAX_ERRORS: Record<string, string> = {
  invalid_doc_type: 'ประเภทเอกสารต้องเป็น ABB, TAX หรือ CN',
  invalid_doc_prefix: 'ประเภทเอกสารไม่ถูกต้อง',
  vat_not_registered: 'ร้านยังไม่ได้ตั้งค่าจดทะเบียน VAT',
  tax_settings_missing: 'ยังไม่ได้กรอกข้อมูลผู้ประกอบการ (เลขผู้เสียภาษี ชื่อ ที่อยู่)',
  terminal_not_found: 'ไม่พบเครื่อง POS ที่เปิดใช้งาน',
  pos_not_registered: 'เครื่อง POS ยังไม่มีเลขอนุมัติจากกรมสรรพากร ออกใบกำกับภาษีอย่างย่อไม่ได้',
  order_not_found: 'ไม่พบออเดอร์',
  order_not_paid: 'ออเดอร์ยังไม่ได้ชำระเงิน',
  order_total_changed: 'ยอดออเดอร์เปลี่ยนหลังสร้างฉบับร่าง ให้ยกเลิกร่างแล้วสร้างใหม่',
  invalid_buyer_tax_id: 'เลขประจำตัวผู้เสียภาษีของผู้ซื้อไม่ถูกต้อง',
  invalid_buyer_branch_code: 'รหัสสาขาผู้ซื้อต้องเป็นตัวเลข 5 หลัก',
  buyer_info_required: 'ใบกำกับภาษีเต็มรูปต้องมีชื่อ เลขผู้เสียภาษี และที่อยู่ผู้ซื้อ',
  tax_invoice_exists: 'ออเดอร์นี้มีใบกำกับภาษีเต็มรูปแล้ว',
  abb_exists_use_ref: 'ออเดอร์นี้มีใบกำกับภาษีอย่างย่อแล้ว ให้แปลงจากใบอย่างย่อ (ส่ง ref_document_id)',
  ref_not_found: 'ไม่พบเอกสารอ้างอิง',
  ref_order_mismatch: 'เอกสารอ้างอิงไม่ใช่ของออเดอร์นี้',
  ref_required: 'ใบลดหนี้ต้องอ้างอิงใบกำกับภาษี (ref_document_id)',
  ref_must_be_confirmed: 'เอกสารอ้างอิงต้องยืนยันแล้ว',
  ref_must_be_confirmed_abb: 'แปลงได้เฉพาะใบกำกับภาษีอย่างย่อที่ยืนยันแล้ว',
  ref_must_be_confirmed_invoice: 'ลดหนี้ได้เฉพาะใบกำกับภาษีที่ยืนยันแล้ว',
  abb_has_credit_note: 'ใบอย่างย่อนี้มีใบลดหนี้แล้ว แปลงเป็นใบเต็มรูปไม่ได้',
  abb_replaced_use_tax_invoice: 'ใบอย่างย่อนี้ถูกแปลงเป็นใบเต็มรูปแล้ว ให้ลดหนี้จากใบเต็มรูป',
  credit_exceeds_invoice: 'ยอดลดหนี้รวมเกินยอดใบกำกับภาษี',
  invalid_exempt_amount: 'ยอดยกเว้นภาษีไม่ถูกต้อง',
  amounts_follow_ref: 'ยอดเงินเป็นไปตามเอกสารอ้างอิง แก้ไม่ได้',
  zero_amount: 'ยอดเอกสารต้องมากกว่า 0',
  document_exists: 'ออเดอร์นี้มีเอกสารประเภทนี้แล้ว',
  not_draft: 'เอกสารนี้ไม่ใช่ฉบับร่าง',
  tax_document_immutable: 'เอกสารที่ยืนยันแล้วแก้ไขไม่ได้ (ยกเลิกด้วยใบลดหนี้)',
  tax_document_no_delete: 'ลบเอกสารภาษีไม่ได้',
  tax_record_immutable: 'ข้อมูลภาษีแก้ไขไม่ได้',
  terminal_in_use: 'เครื่อง POS นี้ออกเอกสารแล้ว เปลี่ยนรหัสไม่ได้',
  shift_already_open: 'มีกะที่เปิดอยู่แล้ว (ผู้ใช้หรือเครื่องนี้)',
  shift_closed: 'กะนี้ปิดแล้ว',
  shift_immutable: 'กะที่ปิดแล้วแก้ไขไม่ได้',
  invalid_log_type: 'ประเภทต้องเป็น cash_in หรือ cash_out',
  insufficient_cash: 'เงินในลิ้นชักไม่พอให้นำออก',
  wht_supplier_tax_id_required: 'หัก ณ ที่จ่ายต้องมีเลขผู้เสียภาษีของผู้ขาย',
  wht_manual_expense_only: 'หัก ณ ที่จ่ายใช้ได้เฉพาะรายจ่ายที่บันทึกเอง',
}
const TAX_CONFLICTS = new Set([
  'tax_invoice_exists', 'abb_exists_use_ref', 'abb_has_credit_note', 'abb_replaced_use_tax_invoice', 'credit_exceeds_invoice',
  'document_exists', 'not_draft', 'tax_document_immutable', 'tax_document_no_delete', 'tax_record_immutable', 'terminal_in_use',
  'order_total_changed', 'shift_already_open', 'shift_closed', 'shift_immutable', 'insufficient_cash',
])

export function taxErrorCode(message: string): string | null {
  const code = message.split(':')[0].trim()
  return code in TAX_ERRORS ? code : null
}
export const taxErrorStatus = (code: string): 400 | 409 => (TAX_CONFLICTS.has(code) ? 409 : 400)

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const LIST_COLUMNS =
  'id,order_id,ref_document_id,doc_type,doc_number,status,terminal_code,pos_reg_no,buyer_name,buyer_tax_id,buyer_branch_code,' +
  'vat_rate,taxable_amount,exempt_amount,vat_amount,total_amount,credit_note_reason,issue_date,created_by_name,created_at,' +
  'confirmed_by_name,confirmed_at,voided_at,void_reason'

export function registerTax(app: Hono<AppEnv>, h: Helpers) {
  const { auth, requireRole, fail, body } = h
  const db = (c: Ctx) => asUser(c.env, c.var.token)
  const confirm = (c: Ctx, id: string, terminal: string) =>
    db(c).rpc<Record<string, unknown>>('tax_doc_confirm', { p_document_id: id, p_terminal_code: terminal.toUpperCase() })
  const strip = (d: Record<string, unknown>) => {
    const { xml_payload, ...rest } = d
    return { ...rest, has_xml: typeof xml_payload === 'string' }
  }

  // สร้างเอกสาร (ฉบับร่าง) · confirm=true + terminal_code = ยืนยันทันที
  app.post('/tax/documents', auth, async (c) => {
    const b = await body(c)
    const type = String(b.doc_type ?? '').toUpperCase() as DocType
    if (!DOC_TYPES.includes(type)) return fail(c, 400, 'invalid_doc_type', { message: TAX_ERRORS.invalid_doc_type })
    const rid = await requireRole(c, b.restaurant_id, docRoles(type))
    if (typeof rid !== 'string') return rid
    const orderId = b.order_id ?? null
    const refId = b.ref_document_id ?? null
    if (orderId !== null && (typeof orderId !== 'string' || !UUID.test(orderId))) return fail(c, 400, 'invalid_order_id')
    if (refId !== null && (typeof refId !== 'string' || !UUID.test(refId))) return fail(c, 400, 'invalid_ref_document_id')
    if (!orderId && !refId) return fail(c, 400, 'order_required', { message: 'ต้องระบุ order_id (หรือ ref_document_id)' })
    if (type === 'CN' && !refId) return fail(c, 400, 'ref_required', { message: TAX_ERRORS.ref_required })
    for (const k of ['exempt_amount', 'amount'] as const) {
      if (b[k] !== undefined && b[k] !== null && !(Number(b[k]) >= 0 && Number(b[k]) <= 100_000_000)) return fail(c, 400, 'invalid_amount')
    }
    const confirmNow = b.confirm === true
    const terminal = String(b.terminal_code ?? '')
    if (confirmNow && !TERMINAL.test(terminal)) return fail(c, 400, 'terminal_required', { message: 'ยืนยันทันทีต้องระบุ terminal_code' })

    const id = await db(c).rpc<string>('tax_doc_create', {
      p_doc_type: type,
      p_order_id: orderId,
      p_ref_document_id: refId,
      p_buyer_name: str(b.buyer_name, 200),
      p_buyer_tax_id: str(b.buyer_tax_id, 13),
      p_buyer_branch_code: str(b.buyer_branch_code, 5),
      p_buyer_address: str(b.buyer_address, 500),
      p_exempt_amount: b.exempt_amount === undefined || b.exempt_amount === null ? 0 : Number(b.exempt_amount),
      p_amount: b.amount === undefined || b.amount === null ? null : Number(b.amount),
      p_credit_note_reason: str(b.credit_note_reason, 300),
    })
    if (confirmNow) {
      try {
        return c.json({ document: strip(await confirm(c, id, terminal)) }, 201)
      } catch (e) {
        // ร่างถูกบันทึกแล้ว ยืนยันไม่ผ่าน: คืน id ให้แก้แล้วยืนยันใหม่
        if (!(e instanceof DbError)) throw e
        const code = taxErrorCode(e.message)
        if (!code) throw e
        return fail(c, taxErrorStatus(code), code, { message: TAX_ERRORS[code], document_id: id, status: 'draft' })
      }
    }
    const [doc] = await db(c).select<Record<string, unknown>>(`tax_documents?select=${LIST_COLUMNS}&id=eq.${id}`)
    return c.json({ document: doc ?? { id, status: 'draft' } }, 201)
  })

  // ยืนยันฉบับร่าง: ออกเลขที่ + สร้าง XML (ETDA) ในธุรกรรมเดียว
  app.post('/tax/documents/:id/confirm', auth, async (c) => {
    const b = await body(c)
    const rid = await requireRole(c, b.restaurant_id, TAX_ISSUE)
    if (typeof rid !== 'string') return rid
    const id = c.req.param('id')
    if (!UUID.test(id)) return fail(c, 400, 'invalid_document_id')
    const terminal = String(b.terminal_code ?? '')
    if (!TERMINAL.test(terminal)) return fail(c, 400, 'terminal_required', { message: 'ระบุ terminal_code ของเครื่อง POS' })
    const found = await db(c).select<{ id: string }>(`tax_documents?select=id&id=eq.${id}&restaurant_id=eq.${rid}`)
    if (found.length === 0) return fail(c, 404, 'not_found')
    return c.json({ document: strip(await confirm(c, id, terminal)) })
  })

  app.get('/tax/documents', auth, async (c) => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), TAX_ISSUE)
    if (typeof rid !== 'string') return rid
    const f: string[] = [`restaurant_id=eq.${rid}`]
    const type = c.req.query('doc_type')
    const status = c.req.query('status')
    const from = c.req.query('from')
    const to = c.req.query('to')
    const order = c.req.query('order_id')
    if (type !== undefined) {
      if (!DOC_TYPES.includes(type.toUpperCase() as DocType)) return fail(c, 400, 'invalid_doc_type')
      f.push(`doc_type=eq.${type.toUpperCase()}`)
    }
    if (status !== undefined) {
      if (!['draft', 'confirmed', 'voided'].includes(status)) return fail(c, 400, 'invalid_status')
      f.push(`status=eq.${status}`)
    }
    if (order !== undefined) {
      if (!UUID.test(order)) return fail(c, 400, 'invalid_order_id')
      f.push(`order_id=eq.${order}`)
    }
    // ช่วงวันที่กรองตามวันที่ออกเอกสาร (ฉบับร่างยังไม่มีวันที่ออก)
    for (const [k, v, op] of [['from', from, 'gte'], ['to', to, 'lte']] as const) {
      if (v === undefined) continue
      if (!DATE.test(v) || Number.isNaN(Date.parse(v))) return fail(c, 400, 'invalid_range', { message: `${k} ต้องเป็น YYYY-MM-DD` })
      f.push(`issue_date=${op}.${v}`)
    }
    const documents = await db(c).select(`tax_documents?select=${LIST_COLUMNS}&${f.join('&')}&order=created_at.desc&limit=1000`)
    return c.json({ documents })
  })

  // ดาวน์โหลด XML ที่สร้างไว้ตอนยืนยัน (ส่งออกเอง ไม่ส่งกรมสรรพากรอัตโนมัติ)
  app.get('/tax/documents/:id/xml', auth, async (c) => {
    const rid = await requireRole(c, c.req.query('restaurant_id'), TAX_ISSUE)
    if (typeof rid !== 'string') return rid
    const id = c.req.param('id')
    if (!UUID.test(id)) return fail(c, 400, 'invalid_document_id')
    const [d] = await db(c).select<{ doc_number: string | null; status: string; xml_payload: string | null }>(
      `tax_documents?select=doc_number,status,xml_payload&id=eq.${id}&restaurant_id=eq.${rid}`,
    )
    if (!d) return fail(c, 404, 'not_found')
    if (d.status !== 'confirmed' || !d.xml_payload || !d.doc_number) {
      return fail(c, 409, 'not_confirmed', { message: 'มี XML เฉพาะเอกสารที่ยืนยันแล้ว' })
    }
    return new Response(d.xml_payload, {
      headers: {
        'content-type': 'application/xml; charset=utf-8',
        'content-disposition': `attachment; filename="${d.doc_number.replace(/[^A-Za-z0-9_-]/g, '_')}.xml"`,
        'cache-control': 'no-store',
      },
    })
  })
}
