import { translateUi } from "../lib/uiText"
import { useEffect, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { baht } from '../lib/format'
import {
  DOC_COLUMNS,
  DOC_TITLE,
  branchLabel,
  fetchDoc,
  fetchShiftReport,
  formatTaxId,
  money,
  normDoc,
  thaiDateTime,
  type ShiftReport,
  type TaxDocument,
} from '../lib/tax'
import Icon from './Icon'

// ใบเสร็จ/เอกสารภาษี พิมพ์ได้ทั้งเครื่องพิมพ์ทั่วไปและเครื่องพิมพ์ใบเสร็จ 80 มม.
//   orderIds   → ใบอย่างย่อ (ABB · ม.86/6) ถ้าออกแล้ว ไม่งั้นใบเสร็จรับเงินธรรมดา (bill_receipt 0017)
//   documentId → ABB / ใบกำกับภาษีเต็มรูป (TAX · ม.86/4) / ใบลดหนี้ (CN · ม.86/10)
//   shiftId    → Z-Report ปิดกะ (X-Report ถ้ากะยังเปิด)

interface ReceiptData {
  restaurant: string
  header: string | null
  footer: string | null
  paid_at: string | null
  payment_method: string | null
  table: string | null
  bill_no: string
  items: { name: string; quantity: number; unit_price: number; amount: number; options_snapshot?: { id: string; name: string; price: number }[] }[]
  service_charge?: number
  tip?: number
  promotions: { name: string; discount: number }[]
  subtotal: number
  points_discount: number
  total: number
  member: { phone: string; points: number; earned: number; redeemed: number } | null
}

export type ReceiptProps = { onClose: () => void } & (
  | { orderIds: string[]; documentId?: never; shiftId?: never }
  | { documentId: string; orderIds?: never; shiftId?: never }
  | { shiftId: string; orderIds?: never; documentId?: never }
)

type View =
  | { kind: 'bill'; data: ReceiptData }
  | { kind: 'abb'; slips: { doc: TaxDocument; data: ReceiptData | null }[]; bill: ReceiptData | null; missing?: string[] }
  | { kind: 'tax'; doc: TaxDocument; data: ReceiptData | null }
  | { kind: 'cn'; doc: TaxDocument; ref: TaxDocument; priorCredit: number }
  | { kind: 'z'; report: ShiftReport; restaurant: string; tax: TaxSummary[]; netVat: number }

interface TaxSummary {
  doc_type: TaxDocument['doc_type']
  count: number
  first: string | null
  last: string | null
  taxable: number
  exempt: number
  vat: number
  total: number
}

const METHOD: Record<string, string> = { cash: 'เงินสด', promptpay: 'พร้อมเพย์', card: 'บัตร', other: 'อื่นๆ' }

async function billReceipt(orderIds: string[]): Promise<ReceiptData | null> {
  const { data, error } = await supabase.rpc('bill_receipt', { p_order_ids: orderIds })
  return error || !data ? null : (data as ReceiptData)
}

async function loadBillView(orderIds: string[]): Promise<View> {
  const [bill, abbRes] = await Promise.all([
    billReceipt(orderIds),
    supabase.from('tax_documents').select(DOC_COLUMNS).in('order_id', orderIds).eq('doc_type', 'ABB').eq('status', 'confirmed').order('doc_number'),
  ])
  const abbs = abbRes.error ? [] : (abbRes.data ?? []).map((d) => normDoc(d as unknown as Record<string, unknown>))
  if (abbs.length === 0) {
    if (!bill) throw new Error('เปิดใบเสร็จไม่ได้ กรุณาตรวจการเชื่อมต่อแล้วลองใหม่')
    return { kind: 'bill', data: bill }
  }
  // ใบอย่างย่อออกต่อออเดอร์: บิลรวมโต๊ะหลายออเดอร์ = หลายใบ แต่ละใบแสดงรายการของออเดอร์นั้น
  const slips = await Promise.all(abbs.map(async (doc) => ({ doc, data: await billReceipt([doc.order_id]) })))
  return { kind: 'abb', slips, bill, missing: orderIds.filter((id) => !abbs.some((doc) => doc.order_id === id)) }
}

async function loadDocView(id: string): Promise<View> {
  const doc = await fetchDoc(id)
  if (!doc) throw new Error('ไม่พบเอกสาร หรือไม่มีสิทธิ์ดู')
  if (doc.doc_type === 'CN') {
    const ref = doc.ref_document_id ? await fetchDoc(doc.ref_document_id) : null
    if (!ref) throw new Error('ไม่พบเอกสารอ้างอิงของใบลดหนี้')
    // ใบลดหนี้ก่อนหน้าของใบเดียวกัน: ใช้คำนวณ "มูลค่าที่ถูกต้อง"
    const { data } = await supabase
      .from('tax_documents')
      .select('id,total_amount,created_at')
      .eq('ref_document_id', ref.id)
      .eq('doc_type', 'CN')
      .eq('status', 'confirmed')
    const priorCredit = (data ?? [])
      .filter((x) => x.id !== doc.id && x.created_at < doc.created_at)
      .reduce((s, x) => s + Number(x.total_amount), 0)
    return { kind: 'cn', doc, ref, priorCredit }
  }
  const data = await billReceipt([doc.order_id])
  return doc.doc_type === 'ABB' ? { kind: 'abb', slips: [{ doc, data }], bill: data } : { kind: 'tax', doc, data }
}

async function loadZView(shiftId: string): Promise<View> {
  const report = await fetchShiftReport(shiftId)
  const rid = report.shift.restaurant_id
  const [seller, rest, orders] = await Promise.all([
    supabase.from('tax_settings').select('company_name').eq('restaurant_id', rid).maybeSingle(),
    supabase.from('restaurants').select('name').eq('id', rid).maybeSingle(),
    supabase.from('orders').select('id').eq('shift_id', shiftId),
  ])
  const ids = (orders.data ?? []).map((o) => o.id as string)
  const tax: TaxSummary[] = []
  let netVat = 0
  if (ids.length > 0) {
    const { data } = await supabase
      .from('tax_documents')
      .select('id,ref_document_id,doc_type,doc_number,taxable_amount,exempt_amount,vat_amount,total_amount')
      .in('order_id', ids)
      .eq('status', 'confirmed')
      .order('doc_number')
    // ภาษีขายสุทธิ: ABB ที่ถูกแปลงเป็นใบเต็มรูปแล้วนับที่ TAX แทน (ไม่นับซ้ำ) · CN หักออก
    const replaced = new Set((data ?? []).filter((d) => d.doc_type === 'TAX' && d.ref_document_id).map((d) => d.ref_document_id as string))
    for (const d of data ?? []) {
      if (d.doc_type === 'ABB' && replaced.has(d.id as string)) continue
      netVat += (d.doc_type === 'CN' ? -1 : 1) * Number(d.vat_amount)
    }
    for (const type of ['ABB', 'TAX', 'CN'] as const) {
      const rows = (data ?? []).filter((d) => d.doc_type === type)
      if (rows.length === 0) continue
      const sum = (k: 'taxable_amount' | 'exempt_amount' | 'vat_amount' | 'total_amount') => rows.reduce((s, r) => s + Number(r[k]), 0)
      tax.push({
        doc_type: type,
        count: rows.length,
        first: rows[0].doc_number,
        last: rows[rows.length - 1].doc_number,
        taxable: sum('taxable_amount'),
        exempt: sum('exempt_amount'),
        vat: sum('vat_amount'),
        total: sum('total_amount'),
      })
    }
  }
  return { kind: 'z', report, restaurant: seller.data?.company_name ?? rest.data?.name ?? '', tax, netVat: Math.round(netVat * 100) / 100 }
}

export default function Receipt(props: ReceiptProps) {
  const { onClose } = props
  const key = props.orderIds?.join(',') ?? props.documentId ?? props.shiftId ?? ''
  const [view, setView] = useState<View | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setView(null)
    setError(null)
    const job = props.orderIds ? loadBillView(props.orderIds) : props.documentId ? loadDocView(props.documentId) : loadZView(props.shiftId!)
    job
      .then((v) => alive && setView(v))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : 'เปิดเอกสารไม่ได้'))
    return () => {
      alive = false
    }
    // key รวมพร็อพที่ใช้โหลดไว้แล้ว
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const label = view?.kind === 'z' ? 'พิมพ์รายงาน' : view && view.kind !== 'bill' ? 'พิมพ์ใบกำกับภาษี' : 'พิมพ์ใบเสร็จ'

  return (
    <div className="no-print-backdrop fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4" role="dialog" aria-modal="true" aria-label={translateUi("ใบเสร็จ")}>
      <div className="mx-auto max-w-sm">
        <div className="no-print mb-3 flex gap-2">
          <button className="btn btn-primary flex-1" onClick={() => window.print()} disabled={!view}>
            <Icon name="print" className="h-4 w-4" />
            {label}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>{"" + translateUi("ปิด") + " "}</button>
        </div>
        {error && <p className="alert-error">{error}</p>}
        {!view && !error && <p className="rounded-xl bg-white p-6 text-center text-gray-500">{translateUi("กำลังโหลด...")}</p>}
        {view && (
          <div className="print-area space-y-6 rounded-xl bg-white p-5 font-mono text-[13px] leading-relaxed text-gray-900 shadow-xl">
            {view.kind === 'bill' && <BillSlip data={view.data} />}
            {view.kind === 'abb' &&
              view.slips.map((s, i) => (
                <div data-abb={s.doc.order_id} key={s.doc.id} className={i > 0 ? 'break-before-page border-t-2 border-dashed border-gray-400 pt-6' : ''}>
                  <AbbSlip doc={s.doc} data={s.data} bill={view.bill} />
                </div>
              ))}
            {view.kind === 'abb' && Boolean(view.missing?.length) && <div><p role="status">{"" + translateUi("ยังไม่มีใบกำกับภาษีอย่างย่อสำหรับออเดอร์:") + " "}{view.missing?.join(', ')}{" " + translateUi("กรุณาออกเอกสารย้อนหลังจากหน้าบัญชี") + ""}</p>{view.bill && <BillSlip data={view.bill} />}</div>}
            {view.kind === 'tax' && <FullTaxInvoice doc={view.doc} data={view.data} />}
            {view.kind === 'cn' && <CreditNote doc={view.doc} ref={view.ref} priorCredit={view.priorCredit} />}
            {view.kind === 'z' && <ZReport report={view.report} restaurant={view.restaurant} tax={view.tax} netVat={view.netVat} />}
          </div>
        )}
      </div>
    </div>
  )
}

// ===== ชิ้นส่วนพิมพ์ =====
function Row({ label, value, strong = false, muted = false }: { label: ReactNode; value: ReactNode; strong?: boolean; muted?: boolean }) {
  return (
    <div className={`flex justify-between gap-2 ${strong ? 'text-base font-bold' : ''} ${muted ? 'text-gray-600' : ''}`}>
      <span>{label}</span>
      <span className="num">{value}</span>
    </div>
  )
}
const Rule = ({ double = false }: { double?: boolean }) => (
  <div className={`my-2 border-t ${double ? 'border-double border-t-4' : 'border-dashed'} border-gray-400`} />
)

function DraftBanner({ doc }: { doc: TaxDocument }) {
  if (doc.status === 'confirmed') return null
  return (
    <div className="mb-2 border-2 border-red-500 p-1 text-center field-error font-bold">
      {doc.status === 'draft' ? 'ฉบับร่าง · ยังไม่ใช่ใบกำกับภาษี' : 'เอกสารถูกยกเลิก'}
    </div>
  )
}

function SellerBlock({ doc, compact = false }: { doc: TaxDocument; compact?: boolean }) {
  return (
    <div className="text-center text-xs">
      <div className="text-base font-bold">{doc.seller_name ?? '-'}</div>
      {!compact && doc.seller_address && (
        <div className="whitespace-pre-line">
          {doc.seller_address}
          {doc.seller_postcode ? ` ${doc.seller_postcode}` : ''}
        </div>
      )}
      <div>{"" + translateUi("เลขประจำตัวผู้เสียภาษี") + " "}{formatTaxId(doc.seller_tax_id)}</div>
      <div>{branchLabel(doc.seller_branch_code)}</div>
    </div>
  )
}

function BuyerBlock({ doc }: { doc: TaxDocument }) {
  return (
    <div className="space-y-0.5 text-xs">
      <div className="font-bold">{translateUi("ผู้ซื้อ / ลูกค้า")}</div>
      <div>{doc.buyer_name ?? '-'}</div>
      {doc.buyer_address && <div className="whitespace-pre-line">{doc.buyer_address}</div>}
      <div>{"" + translateUi("เลขประจำตัวผู้เสียภาษี") + " "}{formatTaxId(doc.buyer_tax_id)}</div>
      <div>{branchLabel(doc.buyer_branch_code)}</div>
    </div>
  )
}

// ยอดจากรายการ ≠ ยอดเอกสาร (เช่น บิลรวมโต๊ะที่ใช้ส่วนลดทั้งบิล): แสดงส่วนต่างเป็นส่วนลด
function Items({ data, doc, vatMark }: { data: ReceiptData | null; doc: TaxDocument; vatMark: boolean }) {
  if (!data) return <Row label={translateUi("ค่าอาหารและเครื่องดื่ม")} value={money(doc.total_amount)} />
  const gross = data.items.reduce((s, it) => s + Number(it.amount), 0)
  const fees = Number(data.service_charge ?? 0) + Number(data.tip ?? 0)
  const discount = Math.round((gross + fees - doc.total_amount) * 100) / 100
  const mark = vatMark && doc.vat_amount > 0 ? ' V' : ''
  return (
    <>
      {data.items.map((it, i) => (
        <div key={i}>
          <div>{it.name}</div>
          {it.options_snapshot?.map((option) => <div key={option.id} className="text-xs">+ {option.name} ({money(Number(option.price))})</div>)}
          <Row label={`  ${it.quantity} × ${money(Number(it.unit_price))}`} value={`${money(Number(it.amount))}${mark}`} />
        </div>
      ))}
      {Number(data.service_charge) > 0 && <Row label={translateUi("ค่าบริการ")} value={money(Number(data.service_charge))} />}
      {Number(data.tip) > 0 && <Row label={translateUi("ทิป")} value={money(Number(data.tip))} />}
      {discount > 0.004 && (
        <>
          <Rule />
          <Row label={translateUi("รวมก่อนส่วนลด")} value={money(gross)} />
          <Row label={translateUi("ส่วนลด")} value={`−${money(discount)}`} />
        </>
      )}
    </>
  )
}

function VatBreakdown({ doc, label = 'จำนวนเงินรวมทั้งสิ้น' }: { doc: TaxDocument; label?: string }) {
  return (
    <>
      <Row label={translateUi("มูลค่าสินค้า/บริการ (ก่อน VAT)")} value={money(doc.taxable_amount)} />
      {doc.exempt_amount > 0 && <Row label={translateUi("มูลค่าที่ได้รับยกเว้น VAT")} value={money(doc.exempt_amount)} />}
      <Row label={`ภาษีมูลค่าเพิ่ม ${doc.vat_rate}%`} value={money(doc.vat_amount)} />
      <Row label={label} value={money(doc.total_amount)} strong />
    </>
  )
}

function BillSlip({ data }: { data: ReceiptData }) {
  return (
    <div>
      <div className="text-center">
        <div className="text-base font-bold">{data.restaurant}</div>
        {data.header && <div className="whitespace-pre-line text-xs">{data.header}</div>}
        <div className="mt-1 text-xs">{translateUi("ใบเสร็จรับเงิน")}</div>
      </div>
      <Rule />
      <Row label={translateUi("เลขที่")} value={data.bill_no} />
      <Row label={translateUi("วันที่")} value={thaiDateTime(data.paid_at)} />
      {data.table && <Row label={translateUi("โต๊ะ")} value={data.table} />}
      <Rule />
      {data.items.map((it, i) => (
        <div key={i}>
          <div>{it.name}</div>
          {it.options_snapshot?.map((option) => <div key={option.id} className="text-xs">+ {option.name} ({money(Number(option.price))})</div>)}
          <Row label={`  ${it.quantity} × ${baht(Number(it.unit_price))}`} value={baht(Number(it.amount))} />
        </div>
      ))}
      <Rule />
      <Row label={translateUi("รวม")} value={baht(Number(data.subtotal))} />
      {data.promotions.map((p, i) => (
        <Row key={i} label={`ส่วนลด ${p.name}`} value={`−${baht(Number(p.discount))}`} />
      ))}
      {Number(data.points_discount) > 0 && <Row label={translateUi("ส่วนลดจากแต้ม")} value={`−${baht(Number(data.points_discount))}`} />}
      {Number(data.service_charge) > 0 && <Row label={translateUi("ค่าบริการ")} value={baht(Number(data.service_charge))} />}
      {Number(data.tip) > 0 && <Row label={translateUi("ทิป")} value={baht(Number(data.tip))} />}
      <Row label={translateUi("ยอดสุทธิ")} value={baht(Number(data.total))} strong />
      <Row label={translateUi("ชำระโดย")} value={METHOD[data.payment_method ?? ''] ?? '-'} />
      <MemberLines data={data} />
      <Rule />
      <div className="whitespace-pre-line text-center text-xs">{data.footer || 'ขอบคุณที่ใช้บริการ'}</div>
    </div>
  )
}

function MemberLines({ data }: { data: ReceiptData | null }) {
  if (!data?.member) return null
  return (
    <>
      <Rule />
      <Row label={translateUi("สมาชิก")} value={data.member.phone} />
      {Number(data.member.redeemed) > 0 && <Row label={translateUi("ใช้แต้ม")} value={`${data.member.redeemed}`} />}
      <Row label={translateUi("ได้แต้ม")} value={`+${data.member.earned ?? 0}`} />
      <Row label={translateUi("แต้มคงเหลือ")} value={`${data.member.points}`} />
    </>
  )
}

// ม.86/6: ชื่อ/เลขผู้เสียภาษีผู้ขาย · คำว่า "ใบกำกับภาษีอย่างย่อ" · เลขที่เรียงลำดับ · รายการ · ราคารวม VAT + "VAT INCLUDED"
function AbbSlip({ doc, data, bill }: { doc: TaxDocument; data: ReceiptData | null; bill: ReceiptData | null }) {
  return (
    <div>
      <DraftBanner doc={doc} />
      <SellerBlock doc={doc} compact />
      {doc.pos_reg_no && <div className="text-center text-xs">POS REG. NO. {doc.pos_reg_no}</div>}
      <div className="mt-1 text-center font-bold">{DOC_TITLE.ABB}</div>
      <div className="text-center text-xs">(VAT INCLUDED)</div>
      <Rule />
      <Row label={translateUi("เลขที่ ABB")} value={doc.doc_number ?? '(ร่าง)'} />
      <Row label={translateUi("วันที่")} value={thaiDateTime(doc.confirmed_at ?? data?.paid_at)} />
      <Row label={translateUi("เครื่อง")} value={doc.terminal_code ?? '-'} />
      {data?.table && <Row label={translateUi("โต๊ะ")} value={data.table} />}
      {data?.bill_no && <Row label={translateUi("บิล")} value={data.bill_no} muted />}
      <Rule />
      <Items data={data} doc={doc} vatMark />
      <Rule />
      <VatBreakdown doc={doc} label={translateUi("รวมทั้งสิ้น (รวม VAT)")} />
      {data?.payment_method && <Row label={translateUi("ชำระโดย")} value={METHOD[data.payment_method] ?? '-'} />}
      <div className="mt-1 text-xs text-gray-600">{translateUi("V = สินค้า/บริการที่มีภาษีมูลค่าเพิ่ม · VAT INCLUDED")}</div>
      <MemberLines data={bill} />
      <Rule />
      {doc.confirmed_by_name && <div className="text-center text-xs">{"" + translateUi("แคชเชียร์:") + " "}{doc.confirmed_by_name}</div>}
      <div className="whitespace-pre-line text-center text-xs">{bill?.footer || 'ขอบคุณที่ใช้บริการ'}</div>
    </div>
  )
}

// ม.86/4: คำว่า "ใบกำกับภาษี" · ผู้ขาย/ผู้ซื้อ (ชื่อ ที่อยู่ เลขผู้เสียภาษี สาขา) · เลขที่ · รายการ · VAT แยก · วันที่
function FullTaxInvoice({ doc, data }: { doc: TaxDocument; data: ReceiptData | null }) {
  return (
    <div>
      <DraftBanner doc={doc} />
      <SellerBlock doc={doc} />
      <div className="mt-2 text-center text-base font-bold">{DOC_TITLE.TAX}</div>
      <div className="text-center text-xs">{translateUi("ต้นฉบับ (ORIGINAL)")}</div>
      <Rule />
      <Row label={translateUi("เลขที่")} value={doc.doc_number ?? '(ร่าง)'} />
      <Row label={translateUi("วันที่")} value={doc.issue_date ? new Date(doc.issue_date).toLocaleDateString('th-TH') : '-'} />
      {doc.terminal_code && <Row label={translateUi("เครื่อง POS")} value={doc.terminal_code} muted />}
      <Rule />
      <BuyerBlock doc={doc} />
      <Rule />
      <div className="flex justify-between text-xs font-bold">
        <span>{translateUi("รายการ")}</span>
        <span>{translateUi("จำนวนเงิน")}</span>
      </div>
      <Items data={data} doc={doc} vatMark={false} />
      <Rule />
      <VatBreakdown doc={doc} />
      <Rule />
      <div className="mt-8 grid grid-cols-2 gap-4 text-center text-xs">
        <div>
          <div className="border-b border-gray-500 pb-6" />
          <div className="mt-1">{translateUi("ผู้รับเงิน / ผู้ออกเอกสาร")}</div>
          <div>{doc.confirmed_by_name ?? ''}</div>
        </div>
        <div>
          <div className="border-b border-gray-500 pb-6" />
          <div className="mt-1">{translateUi("ผู้รับเอกสาร")}</div>
        </div>
      </div>
    </div>
  )
}

// ม.86/10: คำว่า "ใบลดหนี้" · ผู้ขาย/ผู้ซื้อ · เลขที่ · อ้างอิงใบกำกับเดิม · มูลค่าเดิม/ที่ถูกต้อง/ผลต่าง · VAT ของผลต่าง · เหตุผล
function CreditNote({ doc, ref, priorCredit }: { doc: TaxDocument; ref: TaxDocument; priorCredit: number }) {
  const before = Math.round((ref.total_amount - priorCredit) * 100) / 100
  const correct = Math.round((before - doc.total_amount) * 100) / 100
  const exVat = (total: number) => Math.round(((total * ref.taxable_amount) / ref.total_amount) * 100) / 100
  return (
    <div>
      <DraftBanner doc={doc} />
      <SellerBlock doc={doc} />
      <div className="mt-2 text-center text-base font-bold">{DOC_TITLE.CN}</div>
      <div className="text-center text-xs">CREDIT NOTE</div>
      <Rule />
      <Row label={translateUi("เลขที่")} value={doc.doc_number ?? '(ร่าง)'} />
      <Row label={translateUi("วันที่")} value={doc.issue_date ? new Date(doc.issue_date).toLocaleDateString('th-TH') : '-'} />
      <Rule />
      <Row label={translateUi("อ้างอิง")} value={`${ref.doc_type === 'ABB' ? 'ใบกำกับอย่างย่อ' : 'ใบกำกับภาษี'}`} />
      <Row label={translateUi("เลขที่เดิม")} value={ref.doc_number ?? '-'} />
      <Row label={translateUi("ลงวันที่")} value={ref.issue_date ? new Date(ref.issue_date).toLocaleDateString('th-TH') : '-'} />
      <Rule />
      {doc.buyer_name || doc.buyer_tax_id ? <BuyerBlock doc={doc} /> : <div className="text-xs">{translateUi("ผู้ซื้อ: ลูกค้าทั่วไป")}</div>}
      <Rule />
      <div className="text-xs font-bold">{translateUi("เหตุผลในการลดหนี้")}</div>
      <div className="whitespace-pre-line text-xs">{doc.credit_note_reason ?? '-'}</div>
      <Rule />
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 text-xs">
        <span />
        <span className="text-right font-bold">{translateUi("ก่อน VAT")}</span>
        <span className="text-right font-bold">{translateUi("รวม VAT")}</span>
        <span>{translateUi("มูลค่าตามใบกำกับเดิม")}</span>
        <span className="num">{money(exVat(before))}</span>
        <span className="num">{money(before)}</span>
        <span>{translateUi("มูลค่าที่ถูกต้อง")}</span>
        <span className="num">{money(exVat(before) - doc.taxable_amount - doc.exempt_amount)}</span>
        <span className="num">{money(correct)}</span>
        <span className="font-bold">{translateUi("ผลต่าง (ลดหนี้)")}</span>
        <span className="num font-bold">{money(doc.taxable_amount + doc.exempt_amount)}</span>
        <span className="num font-bold">{money(doc.total_amount)}</span>
      </div>
      {priorCredit > 0 && <div className="mt-1 text-xs text-gray-600">{"" + translateUi("หักใบลดหนี้ก่อนหน้าแล้ว") + " "}{money(priorCredit)}</div>}
      <Rule />
      <Row label={`ภาษีมูลค่าเพิ่มของผลต่าง ${doc.vat_rate}%`} value={money(doc.vat_amount)} />
      <Row label={translateUi("รวมลดหนี้ทั้งสิ้น")} value={money(doc.total_amount)} strong />
      <div className="mt-8 grid grid-cols-2 gap-4 text-center text-xs">
        <div>
          <div className="border-b border-gray-500 pb-6" />
          <div className="mt-1">{translateUi("ผู้มีอำนาจลงนาม")}</div>
          <div>{doc.confirmed_by_name ?? ''}</div>
        </div>
        <div>
          <div className="border-b border-gray-500 pb-6" />
          <div className="mt-1">{translateUi("ผู้รับเอกสาร")}</div>
        </div>
      </div>
    </div>
  )
}

function ZReport({ report: r, restaurant, tax, netVat }: { report: ShiftReport; restaurant: string; tax: TaxSummary[]; netVat: number }) {
  const s = r.shift
  const closed = s.status === 'closed'
  const methods = Object.entries(r.sales_by_method)
  const bills = methods.reduce((n, [, v]) => n + v.bills, 0)
  const sales = methods.reduce((n, [, v]) => n + v.total, 0)
  const variance = s.variance_cash ?? 0
  return (
    <div>
      <div className="text-center">
        <div className="text-base font-bold">{restaurant}</div>
        <div className="font-bold">{closed ? 'Z-REPORT · สรุปปิดกะ' : 'X-REPORT · สรุประหว่างกะ'}</div>
      </div>
      <Rule />
      <Row label={translateUi("แคชเชียร์")} value={s.cashier_name} />
      <Row label={translateUi("เปิดกะ")} value={thaiDateTime(s.opened_at)} />
      <Row label={translateUi("ปิดกะ")} value={closed ? thaiDateTime(s.closed_at) : 'ยังเปิดอยู่'} />
      {s.closed_by_name && s.closed_by_name !== s.cashier_name && <Row label={translateUi("ปิดโดย")} value={s.closed_by_name} />}
      <Row label={translateUi("พิมพ์เมื่อ")} value={thaiDateTime(new Date().toISOString())} muted />
      <Rule />
      <div className="font-bold">{translateUi("ยอดขายตามวิธีชำระ")}</div>
      {methods.length === 0 && <div className="text-xs text-gray-600">{translateUi("ไม่มีบิล")}</div>}
      {methods.map(([m, v]) => (
        <Row key={m} label={`${METHOD[m] ?? m} (${v.bills} บิล)`} value={money(v.total)} />
      ))}
      <Row label={`รวม ${bills} บิล`} value={money(sales)} strong />
      {r.cancelled_after_paid > 0 && <Row label={translateUi("ยกเลิกหลังชำระ")} value={`${r.cancelled_after_paid} บิล`} />}
      {tax.length > 0 && (
        <>
          <Rule />
          <div className="font-bold">{translateUi("เอกสารภาษี")}</div>
          {tax.map((t) => (
            <div key={t.doc_type} className="mb-1">
              <Row label={`${DOC_TITLE[t.doc_type]} (${t.count})`} value={money(t.doc_type === 'CN' ? -t.total : t.total)} />
              <div className="text-xs text-gray-600">
                {t.first}
                {t.last !== t.first ? ` – ${t.last}` : ''}
              </div>
              <Row label={translateUi("  ก่อน VAT / VAT")} value={`${money(t.taxable + t.exempt)} / ${money(t.vat)}`} muted />
            </div>
          ))}
          <Row label={translateUi("ภาษีขายสุทธิ (หักใบลดหนี้)")} value={money(netVat)} strong />
        </>
      )}
      <Rule />
      <div className="font-bold">{translateUi("ลิ้นชักเงินสด")}</div>
      <Row label={translateUi("เงินทอนตั้งต้น")} value={money(s.starting_cash)} />
      <Row label={translateUi("ขายเงินสด")} value={money(closed ? (s.cash_sales ?? 0) : r.cash_sales)} />
      <Row label={translateUi("นำเงินเข้า")} value={`+${money(closed ? (s.cash_in_total ?? 0) : r.cash_in_total)}`} />
      <Row label={translateUi("นำเงินออก")} value={`−${money(closed ? (s.cash_out_total ?? 0) : r.cash_out_total)}`} />
      <Row label={translateUi("เงินที่ควรมี")} value={money(r.expected_cash)} strong />
      {closed && (
        <>
          <Row label={translateUi("นับได้จริง")} value={money(s.actual_cash ?? 0)} strong />
          <Row label={variance === 0 ? 'ส่วนต่าง' : variance > 0 ? 'ส่วนต่าง (เกิน)' : 'ส่วนต่าง (ขาด)'} value={`${variance > 0 ? '+' : ''}${money(variance)}`} strong />
          {s.close_note && <div className="text-xs">{"" + translateUi("หมายเหตุ:") + " "}{s.close_note}</div>}
        </>
      )}
      {r.drawer_logs.length > 0 && (
        <>
          <Rule />
          <div className="font-bold">{translateUi("รายการเงินเข้า/ออก")}</div>
          {r.drawer_logs.map((l, i) => (
            <div key={i} className="text-xs">
              <Row label={`${new Date(l.at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} ${l.type === 'cash_in' ? 'เข้า' : 'ออก'}`} value={`${l.type === 'cash_in' ? '+' : '−'}${money(l.amount)}`} />
              <div className="pl-2 text-gray-600">
                {l.reason}
                {l.by ? ` · ${l.by}` : ''}
              </div>
            </div>
          ))}
        </>
      )}
      <Rule double />
      <div className="mt-6 grid grid-cols-2 gap-4 text-center text-xs">
        <div>
          <div className="border-b border-gray-500 pb-6" />
          <div className="mt-1">{translateUi("แคชเชียร์")}</div>
        </div>
        <div>
          <div className="border-b border-gray-500 pb-6" />
          <div className="mt-1">{translateUi("ผู้ตรวจ")}</div>
        </div>
      </div>
    </div>
  )
}
