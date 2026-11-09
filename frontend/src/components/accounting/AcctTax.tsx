// แท็บภาษีในหน้ารายงานบัญชี
//   TaxDocsView: เอกสารภาษีขาย ABB / TAX / CN · ยืนยันฉบับร่าง (ออกเลข + สร้าง XML ETDA ในฐานข้อมูล) · พิมพ์ · ดาวน์โหลด XML
//   RdTaxView:   รายงานภาษีขาย / ภาษีซื้อ / สรุป ภ.พ.30 / ภ.ง.ด.3-53 รายเดือน + ส่งออก CSV
// ทำงานกับ backend ของร้านเท่านั้น ไม่ส่งข้อมูลไปกรมสรรพากรหรือระบบภายนอก (ยื่นแบบเองจากไฟล์ที่ส่งออก)
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, apiDownload, apiMessage } from '../../lib/api'
import {
  ETDA_TYPE_CODE,
  TAX_DOC_LABEL,
  TAX_DOC_STATUS_LABEL,
  WHT_FORM_SHORT,
  filingDue,
  mergeTaxDocs,
  monthOf,
  normalizeTaxDoc,
  pp30Lines,
  taxDocActions,
  taxDocTotals,
  taxReportFileName,
  taxReportPath,
  xmlFileName,
  type Pp30Report,
  type PurchaseTaxReport,
  type SalesTaxReport,
  type TaxDocRow,
  type TaxDocStatus,
  type TaxDocType,
  type TaxReportKind,
  type WhtForm,
  type WhtReport,
} from '../../lib/accounting'
import { branchLabel, confirmDocument, formatTaxId, thaiDateTime, useTaxSetup } from '../../lib/tax'
import { baht } from '../../lib/format'
import Receipt from '../Receipt'
import TerminalPicker from '../TerminalPicker'
import { Money, Section, Stat } from './ui'

const STATUS_BADGE: Record<TaxDocStatus, string> = { draft: 'badge-amber', confirmed: 'badge-green', voided: 'badge-red' }
const TYPE_BADGE: Record<TaxDocType, string> = { ABB: 'badge-gray', TAX: 'badge-blue', CN: 'badge-red' }

// ===================== เอกสารภาษี & ความพร้อม e-Tax =====================
export function TaxDocsView({ restaurantId, from, to }: { restaurantId: string; from: string; to: string }) {
  const setup = useTaxSetup(restaurantId)
  const [docs, setDocs] = useState<TaxDocRow[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [typeFilter, setTypeFilter] = useState<TaxDocType | ''>('')
  const [statusFilter, setStatusFilter] = useState<TaxDocStatus | ''>('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [printId, setPrintId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const q = (extra: string) => `/tax/documents?restaurant_id=${restaurantId}${extra}`
    try {
      // ฉบับร่างยังไม่มีวันที่ออก จึงดึงแยกแล้วรวมกับเอกสารในช่วงวันที่
      const [ranged, drafts] = await Promise.all([
        api<{ documents: Record<string, unknown>[] }>(q(`&from=${from}&to=${to}`)),
        api<{ documents: Record<string, unknown>[] }>(q('&status=draft')),
      ])
      setDocs(mergeTaxDocs(ranged.documents.map(normalizeTaxDoc), drafts.documents.map(normalizeTaxDoc)))
    } catch (e) {
      setMsg({ ok: false, text: apiMessage(e) })
    } finally {
      setLoading(false)
    }
  }, [restaurantId, from, to])

  useEffect(() => {
    void load()
  }, [load])

  const shown = useMemo(
    () => docs.filter((d) => (!typeFilter || d.doc_type === typeFilter) && (!statusFilter || d.status === statusFilter)),
    [docs, typeFilter, statusFilter],
  )
  const totals = useMemo(() => taxDocTotals(docs), [docs])
  const numberOf = useMemo(() => new Map(docs.map((d) => [d.id, d.doc_number])), [docs])

  async function confirm(d: TaxDocRow) {
    if (!setup.terminal) return setMsg({ ok: false, text: 'เลือกเครื่อง POS ก่อนยืนยันเอกสาร (ใช้ออกเลขที่เอกสาร)' })
    if (d.doc_type === 'ABB' && !setup.terminal.pos_reg_no) {
      return setMsg({ ok: false, text: 'เครื่องนี้ยังไม่มีเลขอนุมัติจากกรมสรรพากร ออกใบกำกับภาษีอย่างย่อไม่ได้' })
    }
    setBusyId(d.id)
    try {
      const doc = await confirmDocument(restaurantId, d.id, setup.terminal.terminal_code)
      setMsg({ ok: true, text: `ยืนยัน${TAX_DOC_LABEL[d.doc_type]} เลขที่ ${doc.doc_number} แล้ว · สร้างไฟล์ XML (ETDA) เรียบร้อย` })
      await load()
    } catch (e) {
      setMsg({ ok: false, text: apiMessage(e) })
    } finally {
      setBusyId(null)
    }
  }

  async function downloadXml(d: TaxDocRow) {
    if (!d.doc_number) return
    try {
      await apiDownload(`/tax/documents/${d.id}/xml?restaurant_id=${restaurantId}`, xmlFileName(d.doc_number))
    } catch (e) {
      setMsg({ ok: false, text: apiMessage(e) })
    }
  }

  const readiness = [
    { ok: setup.vatRegistered, text: 'ตั้งค่าจดทะเบียน VAT (ตั้งค่า → จดทะเบียนภาษีมูลค่าเพิ่ม)' },
    { ok: setup.seller !== null, text: 'กรอกข้อมูลผู้ประกอบการ (เลขผู้เสียภาษี ชื่อ สาขา ที่อยู่)' },
    { ok: setup.terminals.length > 0, text: 'เพิ่มเครื่อง POS อย่างน้อย 1 เครื่อง' },
    { ok: setup.terminals.some((t) => t.pos_reg_no), text: 'มีเลขอนุมัติเครื่อง POS จากกรมสรรพากร (จำเป็นสำหรับใบอย่างย่อ)' },
  ]

  return (
    <div>
      {msg && <p className={msg.ok ? 'alert-success' : 'alert-error'}>{msg.text}</p>}

      <div className="grid gap-3 lg:grid-cols-[1fr_20rem]">
        <div className="card">
          <h3 className="font-semibold">ความพร้อมออกใบกำกับภาษี / e-Tax</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {readiness.map((r) => (
              <li key={r.text} className="flex items-start gap-2">
                <span className={`badge ${r.ok ? 'badge-green' : 'badge-amber'}`}>{r.ok ? 'พร้อม' : 'ยังไม่พร้อม'}</span>
                <span className={r.ok ? 'text-gray-600' : 'text-gray-900'}>{r.text}</span>
              </li>
            ))}
          </ul>
          {setup.seller && (
            <p className="mt-3 hint">
              ผู้ขาย: {setup.seller.company_name} · {formatTaxId(setup.seller.tax_id)} · {branchLabel(setup.seller.branch_code)}
            </p>
          )}
          <p className="mt-2 hint">
            XML สร้างตามโครงสร้าง ETDA (ขมธอ.3-2560) ตอนยืนยัน: TypeCode ใบอย่างย่อ {ETDA_TYPE_CODE.ABB} · ใบเสร็จ/ใบกำกับภาษี {ETDA_TYPE_CODE.TAX} · ใบลดหนี้ {ETDA_TYPE_CODE.CN} ·
            ระบบไม่ส่งไฟล์ให้กรมสรรพากรเอง ควรตรวจกับ XSD และลงลายมือชื่ออิเล็กทรอนิกส์ก่อนยื่นจริง
          </p>
        </div>
        <div className="card">
          <TerminalPicker setup={setup} />
          <p className="mt-2 hint">เลขที่เอกสารออกตามเครื่องที่เลือกตอนกดยืนยัน</p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="ฉบับร่าง" value={totals.count.draft} tone={totals.count.draft > 0 ? 'bad' : undefined} hint="รอยืนยัน" />
        <Stat label="ยืนยันแล้ว" value={totals.count.confirmed} hint={`ABB ${totals.byType.ABB} · TAX ${totals.byType.TAX} · CN ${totals.byType.CN}`} />
        <Stat label="ยอดรวม (สุทธิใบลดหนี้)" value={<Money value={totals.total} />} />
        <Stat label="ภาษีขาย (สุทธิ)" value={<Money value={totals.vat} />} />
      </div>

      <Section
        title="รายการเอกสารภาษี"
        action={
          <div className="flex flex-wrap gap-2 text-sm">
            <select className="input" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as TaxDocType | '')} aria-label="ประเภทเอกสาร">
              <option value="">ทุกประเภท</option>
              {(Object.keys(TAX_DOC_LABEL) as TaxDocType[]).map((t) => (
                <option key={t} value={t}>
                  {t} · {TAX_DOC_LABEL[t]}
                </option>
              ))}
            </select>
            <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as TaxDocStatus | '')} aria-label="สถานะ">
              <option value="">ทุกสถานะ</option>
              {(Object.keys(TAX_DOC_STATUS_LABEL) as TaxDocStatus[]).map((s) => (
                <option key={s} value={s}>
                  {TAX_DOC_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <button className="btn btn-secondary btn-sm" onClick={() => void load()} disabled={loading}>
              รีเฟรช
            </button>
          </div>
        }
      >
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th className="text-left">ประเภท / เลขที่</th>
                <th className="text-left">สถานะ</th>
                <th className="text-left">ผู้ซื้อ</th>
                <th className="text-right">VAT</th>
                <th className="text-right">ยอดรวม</th>
                <th className="text-right">การทำงาน</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => {
                const act = taxDocActions(d)
                const sign = d.doc_type === 'CN' ? -1 : 1
                return (
                  <tr key={d.id} className={`border-t align-top ${d.status === 'voided' ? 'text-gray-400' : ''}`}>
                    <td>
                      <span className={`badge ${TYPE_BADGE[d.doc_type]}`}>{d.doc_type}</span>{' '}
                      <span className="font-mono">{d.doc_number ?? '(ยังไม่มีเลขที่)'}</span>
                      <div className="hint">
                        {TAX_DOC_LABEL[d.doc_type]} · {d.issue_date ?? `สร้าง ${thaiDateTime(d.created_at)}`}
                        {d.terminal_code && ` · ${d.terminal_code}`}
                      </div>
                      {d.ref_document_id && <div className="hint">อ้างอิง {numberOf.get(d.ref_document_id) ?? 'เอกสารนอกช่วงวันที่'}</div>}
                      {d.credit_note_reason && <div className="hint">เหตุผล: {d.credit_note_reason}</div>}
                    </td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[d.status]}`}>{TAX_DOC_STATUS_LABEL[d.status]}</span>
                      {d.status === 'confirmed' && d.confirmed_by_name && <div className="hint">{d.confirmed_by_name}</div>}
                      {d.status === 'voided' && d.void_reason && <div className="text-xs">{d.void_reason}</div>}
                    </td>
                    <td>
                      {d.buyer_name ?? (d.doc_type === 'ABB' ? 'ขายปลีก' : '-')}
                      {d.buyer_tax_id && (
                        <div className="hint">
                          {formatTaxId(d.buyer_tax_id)} · {branchLabel(d.buyer_branch_code)}
                        </div>
                      )}
                    </td>
                    <td className="num">{baht(sign * d.vat_amount)}</td>
                    <td className="num">{baht(sign * d.total_amount)}</td>
                    <td className="text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        {act.canConfirm && (
                          <button className="btn btn-primary btn-sm" disabled={busyId !== null || !setup.terminal} onClick={() => void confirm(d)}>
                            {busyId === d.id ? 'กำลังยืนยัน...' : 'ยืนยันและออกเลขที่'}
                          </button>
                        )}
                        {act.canPrint && (
                          <button className="btn btn-secondary btn-sm" onClick={() => setPrintId(d.id)}>
                            {d.status === 'draft' ? 'ดูตัวอย่าง' : 'พิมพ์ใบกำกับภาษี'}
                          </button>
                        )}
                        {act.canDownloadXml && (
                          <button className="btn btn-secondary btn-sm" onClick={() => void downloadXml(d)}>
                            XML (ETDA)
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
              {!loading && shown.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty-cell">
                    ไม่มีเอกสารภาษีในช่วงนี้
                  </td>
                </tr>
              )}
              {loading && (
                <tr>
                  <td colSpan={6} className="empty-cell">
                    กำลังโหลด...
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 hint">
          ช่วงวันที่ {from} ถึง {to} (ตามวันที่ออกเอกสาร) · ฉบับร่างแสดงทั้งหมด · เอกสารที่ยืนยันแล้วแก้ไม่ได้ ให้ออกใบลดหนี้แทน
        </p>
      </Section>

      {printId && <Receipt documentId={printId} onClose={() => setPrintId(null)} />}
    </div>
  )
}

// ===================== รายงานภาษี กรมสรรพากร (ภ.พ.30 / ภ.ง.ด.) =====================
type RdPart = 'pp30' | 'sales' | 'purchase' | 'wht'
const RD_PARTS: { key: RdPart; label: string }[] = [
  { key: 'pp30', label: 'สรุป ภ.พ.30' },
  { key: 'sales', label: 'รายงานภาษีขาย' },
  { key: 'purchase', label: 'รายงานภาษีซื้อ' },
  { key: 'wht', label: 'ภ.ง.ด.3 / ภ.ง.ด.53' },
]

interface RdData {
  pp30: Pp30Report | null
  sales: SalesTaxReport | null
  purchase: PurchaseTaxReport | null
  wht: WhtReport | null
}
const EMPTY_RD: RdData = { pp30: null, sales: null, purchase: null, wht: null }

const thDate = (d: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d)
  return m ? `${m[3]}/${m[2]}/${+m[1] + 543}` : d
}

export function RdTaxView({ restaurantId, today }: { restaurantId: string; today: string }) {
  const [month, setMonth] = useState(monthOf(today))
  const [part, setPart] = useState<RdPart>('pp30')
  const [whtType, setWhtType] = useState<WhtForm | ''>('')
  const [data, setData] = useState<RdData>(EMPTY_RD)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const get = <T,>(kind: TaxReportKind, type?: WhtForm) => api<T>(taxReportPath(kind, restaurantId, month, 'json', type))
    try {
      const [pp30, sales, purchase, wht] = await Promise.all([
        get<Pp30Report>('pp30-summary'),
        get<SalesTaxReport>('sales-tax'),
        get<PurchaseTaxReport>('purchase-tax'),
        get<WhtReport>('wht', whtType || undefined),
      ])
      setData({ pp30, sales, purchase, wht })
    } catch (e) {
      setData(EMPTY_RD)
      setError(apiMessage(e))
    } finally {
      setLoading(false)
    }
  }, [restaurantId, month, whtType])

  useEffect(() => {
    void load()
  }, [load])

  async function csv(kind: TaxReportKind, type?: WhtForm) {
    try {
      await apiDownload(taxReportPath(kind, restaurantId, month, 'csv', type), taxReportFileName(kind, month, type))
    } catch (e) {
      setError(apiMessage(e))
    }
  }

  const vatDue = filingDue(month, 'pp30')
  const whtDue = filingDue(month, 'wht')
  const seller = data.pp30?.seller ?? data.sales?.seller ?? null

  return (
    <div>
      {error && <p className="alert-error">{error}</p>}
      <div className="mb-4 toolbar">
        <label className="flex items-center gap-2 text-sm">
          <span>เดือนภาษี</span>
          <input className="input" type="month" value={month} max={monthOf(today)} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </label>
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="รายงานภาษี">
          {RD_PARTS.map((p) => (
            <button
              key={p.key}
              role="tab"
              aria-selected={part === p.key}
              onClick={() => setPart(p.key)}
              className={`rounded-full border px-3 py-1 text-sm ${part === p.key ? 'border-gray-900 bg-gray-900 text-white' : 'bg-white text-gray-600'}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        {loading && <span className="text-xs text-gray-400">กำลังโหลด...</span>}
      </div>

      {!seller && !loading && !error && (
        <p className="note mb-4">ยังไม่ได้กรอกข้อมูลผู้ประกอบการ หัวรายงานจะว่าง (ตั้งค่า → ข้อมูลผู้ประกอบการ)</p>
      )}

      {part === 'pp30' && data.pp30 && (
        <Pp30Card r={data.pp30} due={vatDue} onCsv={() => void csv('pp30-summary')} />
      )}

      {part === 'sales' && data.sales && (
        <Section
          title={`รายงานภาษีขาย · ${data.sales.rows.length} รายการ`}
          action={<CsvButton onClick={() => void csv('sales-tax')} />}
        >
          <div className="table-wrap">
            <table className="tbl-tight">
              <thead>
                <tr>
                  <th className="text-right">#</th>
                  <th className="text-left">วันที่</th>
                  <th className="text-left">เลขที่</th>
                  <th className="text-left">ผู้ซื้อ</th>
                  <th className="text-right">มูลค่า</th>
                  <th className="text-right">ยกเว้น/0%</th>
                  <th className="text-right">VAT</th>
                  <th className="text-right">รวม</th>
                </tr>
              </thead>
              <tbody>
                {data.sales.rows.map((r) => (
                  <tr key={r.no} className="border-t align-top">
                    <td className="num text-gray-400">{r.no}</td>
                    <td className="whitespace-nowrap">{thDate(r.date)}</td>
                    <td className="font-mono text-xs">{r.doc_number}</td>
                    <td>
                      {r.buyer_name}
                      {r.buyer_tax_id && (
                        <div className="hint">
                          {formatTaxId(r.buyer_tax_id)} · {r.branch}
                        </div>
                      )}
                      {r.note && <div className="hint">{r.note}</div>}
                    </td>
                    <td className="text-right"><Money value={r.taxable} /></td>
                    <td className="text-right"><Money value={r.exempt} /></td>
                    <td className="text-right"><Money value={r.vat} /></td>
                    <td className="text-right"><Money value={r.total} /></td>
                  </tr>
                ))}
                {data.sales.rows.length === 0 && <EmptyRow cols={8} />}
              </tbody>
              <tfoot>
                <tr className="border-t-2 bg-gray-50 font-semibold">
                  <td colSpan={4}>รวม</td>
                  <td className="text-right"><Money value={data.sales.totals.taxable} /></td>
                  <td className="text-right"><Money value={data.sales.totals.exempt} /></td>
                  <td className="text-right"><Money value={data.sales.totals.vat} /></td>
                  <td className="text-right"><Money value={data.sales.totals.total} /></td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-2 hint">ใบอย่างย่อรวม 1 บรรทัดต่อวันต่อเครื่อง · ใบลดหนี้ติดลบ · ใบเต็มรูปที่ออกแทนใบอย่างย่อไม่นับยอดซ้ำ</p>
        </Section>
      )}

      {part === 'purchase' && data.purchase && (
        <Section
          title={`รายงานภาษีซื้อ · ${data.purchase.rows.length} ใบกำกับ`}
          action={<CsvButton onClick={() => void csv('purchase-tax')} />}
        >
          {data.purchase.without_invoice.count > 0 && (
            <p className="alert-error">
              มีรายจ่าย {data.purchase.without_invoice.count} รายการที่ใส่ภาษีซื้อ {baht(data.purchase.without_invoice.vat)} แต่ไม่มีใบกำกับภาษี · นำมาหักใน ภ.พ.30 ไม่ได้
            </p>
          )}
          <div className="table-wrap">
            <table className="tbl-tight">
              <thead>
                <tr>
                  <th className="text-right">#</th>
                  <th className="text-left">วันที่ใบกำกับ</th>
                  <th className="text-left">เลขที่</th>
                  <th className="text-left">ผู้ขาย</th>
                  <th className="text-right">มูลค่า</th>
                  <th className="text-right">VAT</th>
                  <th className="text-right">รวม</th>
                </tr>
              </thead>
              <tbody>
                {data.purchase.rows.map((r) => (
                  <tr key={r.no} className="border-t align-top">
                    <td className="num text-gray-400">{r.no}</td>
                    <td className="whitespace-nowrap">{thDate(r.invoice_date)}</td>
                    <td className="font-mono text-xs">{r.invoice_no}</td>
                    <td>
                      {r.supplier_name}
                      <div className="hint">
                        {formatTaxId(r.supplier_tax_id)} · {r.branch} · ลงบัญชี {thDate(r.posted_on)}
                      </div>
                    </td>
                    <td className="text-right"><Money value={r.value} /></td>
                    <td className="text-right"><Money value={r.vat} /></td>
                    <td className="text-right"><Money value={r.total} /></td>
                  </tr>
                ))}
                {data.purchase.rows.length === 0 && <EmptyRow cols={7} />}
              </tbody>
              <tfoot>
                <tr className="border-t-2 bg-gray-50 font-semibold">
                  <td colSpan={4}>รวม</td>
                  <td className="text-right"><Money value={data.purchase.totals.value} /></td>
                  <td className="text-right"><Money value={data.purchase.totals.vat} /></td>
                  <td className="text-right"><Money value={data.purchase.totals.total} /></td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-2 hint">จากรายจ่ายที่ติ๊ก "มีใบกำกับภาษีเต็มรูป" และยังไม่ยกเลิก (ตามวันที่จ่ายในเดือนนี้)</p>
        </Section>
      )}

      {part === 'wht' && data.wht && (
        <Section
          title="สรุปภาษีหัก ณ ที่จ่าย"
          action={
            <div className="toolbar">
              <select className="input" value={whtType} onChange={(e) => setWhtType(e.target.value as WhtForm | '')} aria-label="แบบ">
                <option value="">ทั้ง ภ.ง.ด.3 และ 53</option>
                <option value="pnd3">ภ.ง.ด.3 (บุคคลธรรมดา)</option>
                <option value="pnd53">ภ.ง.ด.53 (นิติบุคคล)</option>
              </select>
              <CsvButton onClick={() => void csv('wht', whtType || undefined)} />
            </div>
          }
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label={`ภ.ง.ด.3 · ${data.wht.summary.pnd3.count} ราย`} value={<Money value={data.wht.summary.pnd3.wht} />} hint={`เงินได้ ${baht(data.wht.summary.pnd3.paid_amount)}`} />
            <Stat label={`ภ.ง.ด.53 · ${data.wht.summary.pnd53.count} ราย`} value={<Money value={data.wht.summary.pnd53.wht} />} hint={`เงินได้ ${baht(data.wht.summary.pnd53.paid_amount)}`} />
            <Stat label="ภาษีที่ต้องนำส่งรวม" value={<Money value={data.wht.summary.total_wht} />} hint={`ยื่นภายใน ${thDate(whtDue.paper)} (ออนไลน์ ${thDate(whtDue.online)})`} />
          </div>
          <div className="table-wrap mt-3">
            <table className="tbl-tight">
              <thead>
                <tr>
                  <th className="text-right">#</th>
                  <th className="text-left">แบบ</th>
                  <th className="text-left">ผู้มีเงินได้</th>
                  <th className="text-left">วันที่จ่าย</th>
                  <th className="text-left">ประเภทเงินได้</th>
                  <th className="text-right">อัตรา</th>
                  <th className="text-right">เงินได้</th>
                  <th className="text-right">ภาษีที่หัก</th>
                </tr>
              </thead>
              <tbody>
                {data.wht.rows.map((r) => (
                  <tr key={r.no} className="border-t align-top">
                    <td className="num text-gray-400">{r.no}</td>
                    <td>
                      <span className="badge badge-amber">{WHT_FORM_SHORT[r.form]}</span>
                    </td>
                    <td>
                      {r.payee_name}
                      <div className="hint">
                        {formatTaxId(r.payee_tax_id)} · {r.branch}
                      </div>
                    </td>
                    <td className="whitespace-nowrap">{thDate(r.paid_on)}</td>
                    <td>{r.income_type}</td>
                    <td className="num">{r.rate}%</td>
                    <td className="text-right"><Money value={r.paid_amount} /></td>
                    <td className="text-right"><Money value={r.wht} /></td>
                  </tr>
                ))}
                {data.wht.rows.length === 0 && <EmptyRow cols={8} />}
              </tbody>
            </table>
          </div>
          <p className="mt-2 hint">ฐานภาษี = ยอดก่อน VAT · ออกหนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) ให้ผู้รับเงินทุกครั้ง</p>
        </Section>
      )}

      <p className="mt-6 text-xs text-gray-400">
        รายงานสร้างจากข้อมูลในระบบเท่านั้น ไม่ได้ยื่นต่อกรมสรรพากรอัตโนมัติ · ไฟล์ CSV เป็น UTF-8 เปิดใน Excel ได้ · ควรให้นักบัญชีตรวจก่อนยื่นแบบ
      </p>
    </div>
  )
}

function Pp30Card({ r, due, onCsv }: { r: Pp30Report; due: { paper: string; online: string }; onCsv: () => void }) {
  const s = r.summary
  const payable = s.vat_payable > 0
  return (
    <Section title={`สรุปภาษีมูลค่าเพิ่ม (ภ.พ.30) · ${r.period.from} ถึง ${r.period.to}`} action={<CsvButton onClick={onCsv} />}>
      <div className="grid gap-3 lg:grid-cols-[1fr_18rem]">
        <div className="card-flush">
          <table className="w-full text-sm">
            <tbody>
              {pp30Lines(s).map((l) => (
                <tr key={l.no} className={`border-t first:border-t-0 ${l.strong ? 'bg-gray-50 font-semibold' : ''}`}>
                  <td className="w-10 px-3 py-2 text-gray-400">{l.no}.</td>
                  <td className="px-3 py-2">{l.label}</td>
                  <td className="px-3 py-2 text-right">
                    <Money value={l.amount} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={`card ${payable ? 'border-red-200' : 'border-emerald-200'}`}>
          <div className="stat-label">{payable ? 'ภาษีที่ต้องชำระ' : s.vat_credit > 0 ? 'ภาษีชำระเกิน (ยกไป/ขอคืน)' : 'ไม่มีภาษีต้องชำระ'}</div>
          <div className={`stat-value ${payable ? 'text-red-600' : 'text-emerald-700'}`}>{baht(payable ? s.vat_payable : s.vat_credit)}</div>
          <dl className="mt-3 space-y-1 text-xs text-gray-600">
            <div className="flex justify-between">
              <dt>รายการภาษีขาย</dt>
              <dd>{r.counts.sales_lines}</dd>
            </div>
            <div className="flex justify-between">
              <dt>ใบกำกับภาษีซื้อ</dt>
              <dd>{r.counts.purchase_invoices}</dd>
            </div>
            <div className="flex justify-between">
              <dt>ยื่นแบบกระดาษภายใน</dt>
              <dd>{thDate(due.paper)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>ยื่นออนไลน์ภายใน</dt>
              <dd>{thDate(due.online)}</dd>
            </div>
          </dl>
          {r.purchases_without_invoice.count > 0 && (
            <p className="mt-3 text-xs text-amber-700">
              ภาษีซื้อ {baht(r.purchases_without_invoice.vat)} จาก {r.purchases_without_invoice.count} รายจ่ายไม่มีใบกำกับภาษี จึงไม่นับในข้อ 6
            </p>
          )}
        </div>
      </div>
    </Section>
  )
}

function CsvButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="btn btn-secondary btn-sm" onClick={onClick}>
      ส่งออก CSV
    </button>
  )
}

function EmptyRow({ cols }: { cols: number }) {
  return (
    <tr>
      <td colSpan={cols} className="empty-cell">
        ไม่มีรายการในเดือนนี้
      </td>
    </tr>
  )
}
