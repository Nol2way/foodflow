import { translateUi } from "../lib/uiText"
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { apiMessage } from '../lib/api'
import { orderLabel } from '../lib/format'
import {
  DOC_COLUMNS,
  DOC_TITLE,
  confirmDocument,
  createDraft,
  dbMessage,
  findBuyerByPhone,
  findBuyerByTaxId,
  money,
  normDoc,
  rememberBuyer,
  thaiDateTime,
  thaiTaxIdValid,
  updateDraft,
  type TaxDocument,
  type TaxSetup,
} from '../lib/tax'
import TerminalPicker from './TerminalPicker'
import Icon from './Icon'

// ออกใบกำกับภาษีเต็มรูป (TAX) / ใบลดหนี้ (CN): เลือกบิลหรือเอกสารอ้างอิง → กรอกผู้ซื้อ → บันทึกร่าง → ยืนยันและล็อก
// ยืนยันแล้ว = ออกเลขที่เรียงลำดับ + สร้าง XML ETDA ในธุรกรรมเดียว แก้ไม่ได้อีก (แก้ด้วยใบลดหนี้เท่านั้น)

type Kind = 'TAX' | 'CN'

interface PaidOrder {
  id: string
  total: number
  paid_at: string | null
  label: string
  abb: TaxDocument | null
  hasTax: boolean
}

interface RefDoc {
  doc: TaxDocument
  credited: number
}

interface BuyerForm {
  phone: string
  tax_id: string
  branch_code: string
  name: string
  address: string
}

const EMPTY_BUYER: BuyerForm = { phone: '', tax_id: '', branch_code: '00000', name: '', address: '' }
const CN_REASONS = ['ยกเลิกรายการ/คืนสินค้า', 'คิดราคาผิด (สูงกว่าที่ตกลง)', 'ให้ส่วนลดหลังออกใบกำกับภาษี', 'สินค้า/บริการไม่ตรงตามที่ตกลง']
const round2 = (n: number) => Math.round(n * 100) / 100

export default function TaxDocModal({
  restaurantId,
  setup,
  initialKind = 'TAX',
  onClose,
  onOpenDocument,
}: {
  restaurantId: string
  setup: TaxSetup
  initialKind?: Kind
  onClose: () => void
  onOpenDocument: (documentId: string) => void
}) {
  const [kind, setKind] = useState<Kind>(initialKind)
  const createIntent = useRef(crypto.randomUUID())
  const saving = useRef(false)
  const [query, setQuery] = useState('')
  const [orders, setOrders] = useState<PaidOrder[]>([])
  const [refs, setRefs] = useState<TaxDocument[]>([])
  const [drafts, setDrafts] = useState<TaxDocument[]>([])
  const [order, setOrder] = useState<PaidOrder | null>(null)
  const [ref, setRef] = useState<RefDoc | null>(null)
  const [buyer, setBuyer] = useState<BuyerForm>(EMPTY_BUYER)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [draft, setDraft] = useState<TaxDocument | null>(null)
  const [dirty, setDirty] = useState(false)
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState<'save' | 'confirm' | 'lookup' | 'discard' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // ===== โหลดรายการให้เลือก =====
  const loadOrders = useCallback(async () => {
    const { data, error: e } = await supabase
      .from('orders')
      .select('id,total,paid_at,order_type,customer_label,dining_tables(label)')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'paid')
      .order('paid_at', { ascending: false })
      .limit(40)
    if (e) return setError('โหลดบิลที่ชำระแล้วไม่สำเร็จ')
    const rows = (data ?? []) as unknown as {
      id: string
      total: number
      paid_at: string | null
      order_type: 'dine_in' | 'takeaway'
      customer_label: string | null
      dining_tables: { label: string } | null
    }[]
    const ids = rows.map((r) => r.id)
    const docs = ids.length
      ? ((await supabase.from('tax_documents').select(DOC_COLUMNS).in('order_id', ids).in('doc_type', ['ABB', 'TAX']).neq('status', 'voided')).data ?? []).map(
          (d) => normDoc(d as unknown as Record<string, unknown>),
        )
      : []
    setOrders(
      rows.map((r) => ({
        id: r.id,
        total: Number(r.total),
        paid_at: r.paid_at,
        label: orderLabel(r),
        abb: docs.find((d) => d.order_id === r.id && d.doc_type === 'ABB' && d.status === 'confirmed') ?? null,
        hasTax: docs.some((d) => d.order_id === r.id && d.doc_type === 'TAX'),
      })),
    )
  }, [restaurantId])

  const loadRefs = useCallback(
    async (q: string) => {
      let req = supabase
        .from('tax_documents')
        .select(DOC_COLUMNS)
        .eq('restaurant_id', restaurantId)
        .eq('status', 'confirmed')
        .in('doc_type', ['ABB', 'TAX'])
        .order('confirmed_at', { ascending: false })
        .limit(30)
      const term = q.trim().replace(/[%,()]/g, '')
      if (term) req = req.ilike('doc_number', `%${term}%`)
      const { data, error: e } = await req
      if (e) return setError('ค้นหาเอกสารอ้างอิงไม่สำเร็จ')
      setRefs((data ?? []).map((d) => normDoc(d as unknown as Record<string, unknown>)))
    },
    [restaurantId],
  )

  const loadDrafts = useCallback(async () => {
    const { data } = await supabase
      .from('tax_documents')
      .select(DOC_COLUMNS)
      .eq('restaurant_id', restaurantId)
      .eq('status', 'draft')
      .in('doc_type', ['TAX', 'CN'])
      .order('created_at', { ascending: false })
      .limit(10)
    setDrafts((data ?? []).map((d) => normDoc(d as unknown as Record<string, unknown>)))
  }, [restaurantId])

  useEffect(() => {
    void loadDrafts()
  }, [loadDrafts])

  useEffect(() => {
    if (kind === 'TAX') void loadOrders()
  }, [kind, loadOrders])

  useEffect(() => {
    if (kind !== 'CN') return
    const t = setTimeout(() => void loadRefs(query), 250)
    return () => clearTimeout(t)
  }, [kind, query, loadRefs])

  // ===== เปลี่ยนแบบฟอร์ม =====
  function reset(next: Kind) {
    if (saving.current) return
    createIntent.current = crypto.randomUUID()
    setKind(next)
    setOrder(null)
    setRef(null)
    setDraft(null)
    setBuyer(EMPTY_BUYER)
    setAmount('')
    setReason('')
    setDirty(false)
    setChecked(false)
    setError(null)
    setNotice(null)
    setQuery('')
  }

  const edit = <K extends keyof BuyerForm>(k: K, v: BuyerForm[K]) => {
    setBuyer((b) => ({ ...b, [k]: v }))
    setDirty(true)
    setChecked(false)
  }

  async function pickRef(doc: TaxDocument) {
    const { data } = await supabase.from('tax_documents').select('total_amount').eq('ref_document_id', doc.id).eq('doc_type', 'CN').neq('status', 'voided')
    const credited = round2((data ?? []).reduce((s, x) => s + Number(x.total_amount), 0))
    setRef({ doc, credited })
    setAmount(String(round2(doc.total_amount - credited)))
    setBuyer({
      phone: '',
      tax_id: doc.buyer_tax_id ?? '',
      branch_code: doc.buyer_branch_code ?? '00000',
      name: doc.buyer_name ?? '',
      address: doc.buyer_address ?? '',
    })
    setDraft(null)
    setDirty(true)
  }

  async function openDraft(d: TaxDocument) {
    reset(d.doc_type === 'CN' ? 'CN' : 'TAX')
    setDraft(d)
    setBuyer({ phone: '', tax_id: d.buyer_tax_id ?? '', branch_code: d.buyer_branch_code ?? '00000', name: d.buyer_name ?? '', address: d.buyer_address ?? '' })
    if (d.doc_type === 'CN' && d.ref_document_id) {
      const { data } = await supabase.from('tax_documents').select(DOC_COLUMNS).eq('id', d.ref_document_id).maybeSingle()
      if (data) {
        const refDoc = normDoc(data as unknown as Record<string, unknown>)
        const { data: cns } = await supabase.from('tax_documents').select('id,total_amount').eq('ref_document_id', refDoc.id).eq('doc_type', 'CN').neq('status', 'voided')
        const credited = round2((cns ?? []).filter((x) => x.id !== d.id).reduce((s, x) => s + Number(x.total_amount), 0))
        setRef({ doc: refDoc, credited })
      }
      setAmount(String(d.total_amount))
      setReason(d.credit_note_reason ?? '')
    } else {
      setOrder({ id: d.order_id, total: d.total_amount, paid_at: null, label: 'จากฉบับร่าง', abb: null, hasTax: false })
    }
    setDirty(false)
  }

  // ===== ค้นหาผู้ซื้อ =====
  const taxIdOk = thaiTaxIdValid(buyer.tax_id)
  const taxIdError = buyer.tax_id.length === 13 && !taxIdOk ? 'เลขผู้เสียภาษีไม่ถูกต้อง (checksum ไม่ผ่าน)' : null

  async function lookup(by: 'tax' | 'phone') {
    setBusy('lookup')
    setNotice(null)
    try {
      const found = by === 'tax' ? await findBuyerByTaxId(restaurantId, buyer.tax_id) : await findBuyerByPhone(restaurantId, buyer.phone)
      if (!found) return setNotice('ไม่พบข้อมูลผู้ซื้อเดิม กรอกใหม่ได้เลย')
      setBuyer((b) => ({
        ...b,
        name: found.name || b.name,
        tax_id: found.tax_id || b.tax_id,
        branch_code: found.branch_code || b.branch_code,
        address: found.address || b.address,
      }))
      setDirty(true)
      setNotice('เติมข้อมูลผู้ซื้อแล้ว ตรวจสอบก่อนบันทึก')
    } finally {
      setBusy(null)
    }
  }

  // เลขครบ 13 หลักและถูกต้อง + ยังไม่มีชื่อ: ค้นให้อัตโนมัติ
  useEffect(() => {
    if (taxIdOk && !buyer.name.trim()) void lookup('tax')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taxIdOk])

  // ===== ตรวจแบบฟอร์ม =====
  const remaining = ref ? round2(ref.doc.total_amount - ref.credited) : 0
  const amountNum = round2(Number(amount))
  const problems = useMemo(() => {
    const p: string[] = []
    if (!setup.vatRegistered) p.push('ร้านยังไม่ได้จดทะเบียน VAT (ตั้งค่าในหน้าบัญชี)')
    if (!setup.seller) p.push('ยังไม่ได้กรอกข้อมูลผู้ประกอบการ (เลขผู้เสียภาษี ชื่อ ที่อยู่)')
    if (kind === 'TAX') {
      if (!order) p.push('เลือกบิลที่ต้องการออกใบกำกับภาษี')
      if (!buyer.name.trim()) p.push('กรอกชื่อผู้ซื้อ')
      if (!taxIdOk) p.push('เลขผู้เสียภาษีผู้ซื้อต้องเป็นเลข 13 หลักที่ถูกต้อง')
      if (!/^\d{5}$/.test(buyer.branch_code)) p.push('รหัสสาขาต้องเป็นตัวเลข 5 หลัก')
      if (!buyer.address.trim()) p.push('กรอกที่อยู่ผู้ซื้อ')
    } else {
      if (!ref) p.push('เลือกใบกำกับภาษีที่จะลดหนี้')
      if (!reason.trim()) p.push('ระบุเหตุผลในการลดหนี้')
      if (!(amountNum > 0)) p.push('ยอดลดหนี้ต้องมากกว่า 0')
      else if (ref && amountNum > remaining) p.push(`ยอดลดหนี้เกินยอดที่ลดได้ (${money(remaining)})`)
      if (buyer.tax_id && !taxIdOk) p.push('เลขผู้เสียภาษีผู้ซื้อไม่ถูกต้อง')
      if (buyer.tax_id && !/^\d{5}$/.test(buyer.branch_code)) p.push('รหัสสาขาต้องเป็นตัวเลข 5 หลัก')
    }
    return p
  }, [setup.vatRegistered, setup.seller, kind, order, ref, buyer, taxIdOk, reason, amountNum, remaining])

  const buyerPayload = () => ({
    buyer_name: buyer.name.trim() || null,
    buyer_tax_id: buyer.tax_id || null,
    buyer_branch_code: buyer.tax_id ? buyer.branch_code : null,
    buyer_address: buyer.address.trim() || null,
  })

  // ===== บันทึกร่าง / ยืนยัน =====
  async function save(): Promise<TaxDocument | null> {
    if (problems.length || saving.current) return null
    saving.current = true
    setBusy('save')
    setError(null)
    setNotice(null)
    try {
      let doc: TaxDocument
      if (draft) {
        doc = await updateDraft(draft.id, {
          ...buyerPayload(),
          amount: kind === 'CN' ? amountNum : null,
          credit_note_reason: kind === 'CN' ? reason.trim() : null,
        })
      } else if (kind === 'TAX') {
        doc = await createDraft({
          client_ref: createIntent.current,
          restaurant_id: restaurantId,
          doc_type: 'TAX',
          order_id: order!.id,
          ref_document_id: order!.abb?.id ?? null, // บิลที่มีใบอย่างย่อแล้ว: แปลงจากใบอย่างย่อ
          ...buyerPayload(),
        })
      } else {
        doc = await createDraft({
          client_ref: createIntent.current,
          restaurant_id: restaurantId,
          doc_type: 'CN',
          ref_document_id: ref!.doc.id,
          amount: amountNum,
          credit_note_reason: reason.trim(),
          ...buyerPayload(),
        })
      }
      if (taxIdOk) rememberBuyer(buyer.phone, { name: buyer.name.trim(), tax_id: buyer.tax_id, branch_code: buyer.branch_code, address: buyer.address.trim() })
      setDraft(doc)
      setDirty(false)
      setNotice('บันทึกฉบับร่างแล้ว ตรวจสอบแล้วกด "ยืนยันและล็อกเอกสาร" เพื่อออกเลขที่')
      void loadDrafts()
      return doc
    } catch (e) {
      setError(e instanceof Error && !('status' in e) ? dbMessage(e.message) : apiMessage(e))
      return null
    } finally {
      saving.current = false
      setBusy(null)
    }
  }

  async function confirm() {
    if (!draft || dirty || !checked || !setup.terminal) return
    setBusy('confirm')
    setError(null)
    try {
      const doc = await confirmDocument(restaurantId, draft.id, setup.terminal.terminal_code)
      void loadDrafts()
      onOpenDocument(doc.id)
    } catch (e) {
      setError(apiMessage(e))
    } finally {
      setBusy(null)
    }
  }

  async function discard() {
    if (!draft) return
    setBusy('discard')
    const { error: e } = await supabase.rpc('tax_doc_void_draft', { p_document_id: draft.id, p_reason: 'ยกเลิกฉบับร่างจากหน้ารับชำระ' })
    setBusy(null)
    if (e) return setError(dbMessage(e.message))
    void loadDrafts()
    reset(kind)
    setNotice('ยกเลิกฉบับร่างแล้ว')
  }

  const q = query.trim().toLowerCase()
  const visibleOrders = orders.filter((o) => !q || o.label.toLowerCase().includes(q) || (o.abb?.doc_number ?? '').toLowerCase().includes(q))
  const locked = draft !== null && kind === 'TAX' // ร่าง TAX ผูกบิลแล้ว เปลี่ยนบิลไม่ได้ (ยกเลิกร่างก่อน)

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-gray-900/50 p-4" role="dialog" aria-modal="true" aria-label={translateUi("ออกใบกำกับภาษี / ใบลดหนี้")}>
      <div className="card mx-auto w-full max-w-2xl p-5">
        <div className="mb-4 row-between">
          <h2 className="title-lg">{translateUi("ออกใบกำกับภาษี / ใบลดหนี้")}</h2>
          <button className="grid h-8 w-8 place-items-center rounded-full hover:bg-gray-100" onClick={onClose} aria-label={translateUi("ปิด")}>
            <Icon name="close" className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-4 inline-flex rounded-xl border bg-white p-1" role="tablist">
          {(['TAX', 'CN'] as Kind[]).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={kind === k}
              onClick={() => reset(k)}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition ${kind === k ? 'bg-brand-500 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              {k === 'TAX' ? 'ใบกำกับภาษีเต็มรูป' : 'ใบลดหนี้'}
            </button>
          ))}
        </div>

        {drafts.length > 0 && !draft && (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">
            <div className="mb-1 font-medium text-amber-800">{translateUi("ฉบับร่างที่ค้างอยู่")}</div>
            <ul className="space-y-1">
              {drafts.map((d) => (
                <li key={d.id}>
                  <button className="flex w-full justify-between gap-2 text-left text-amber-900 hover:underline" onClick={() => void openDraft(d)}>
                    <span>
                      {DOC_TITLE[d.doc_type]} · {d.buyer_name ?? 'ไม่ระบุผู้ซื้อ'}
                    </span>
                    <span className="tabular-nums">{money(d.total_amount)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 1) เลือกที่มา */}
        <section className="mb-4">
          <h3 className="label">{kind === 'TAX' ? '1. เลือกบิลที่ชำระแล้ว' : '1. เลือกใบกำกับภาษีที่จะลดหนี้'}</h3>
          {(kind === 'CN' || !locked) && !(kind === 'CN' && draft) && (
            <input
              className="input mb-2 w-full"
              placeholder={kind === 'TAX' ? 'ค้นหาโต๊ะ ชื่อลูกค้า หรือเลข ABB' : 'ค้นหาเลขที่เอกสาร เช่น ABB-POS1-'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          {kind === 'TAX' ? (
            locked ? (
              <SelectedBox title={order?.label ?? '-'} amount={draft?.total_amount ?? 0} />
            ) : (
              <ul className="max-h-52 divide-y overflow-y-auto rounded-xl border text-sm">
                {visibleOrders.map((o) => (
                  <li key={o.id}>
                    <button
                      disabled={o.hasTax}
                      onClick={() => {
                        setOrder(o)
                        setDirty(true)
                      }}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-40 ${order?.id === o.id ? 'bg-brand-50' : 'hover:bg-gray-50'}`}
                    >
                      <span>
                        <span className="font-medium">{o.label}</span>
                        <span className="block hint">
                          {thaiDateTime(o.paid_at)}
                          {o.abb ? ` · ${o.abb.doc_number}` : ''}
                          {o.hasTax ? ' · มีใบกำกับเต็มรูปแล้ว' : ''}
                        </span>
                      </span>
                      <span className="tabular-nums">{money(o.total)}</span>
                    </button>
                  </li>
                ))}
                {visibleOrders.length === 0 && <li className="empty py-4">{translateUi("ไม่พบบิลที่ชำระแล้ว")}</li>}
              </ul>
            )
          ) : draft || ref ? (
            ref && (
              <SelectedBox
                title={`${ref.doc.doc_number} · ${DOC_TITLE[ref.doc.doc_type]}`}
                subtitle={`ลดหนี้ไปแล้ว ${money(ref.credited)} · ลดได้อีก ${money(remaining)}`}
                amount={ref.doc.total_amount}
                onClear={draft ? undefined : () => setRef(null)}
              />
            )
          ) : (
            <ul className="max-h-52 divide-y overflow-y-auto rounded-xl border text-sm">
              {refs.map((d) => (
                <li key={d.id}>
                  <button onClick={() => void pickRef(d)} className="row-between w-full px-3 py-2 text-left hover:bg-gray-50">
                    <span>
                      <span className="font-medium">{d.doc_number}</span>
                      <span className="block hint">
                        {thaiDateTime(d.confirmed_at)} · {d.buyer_name ?? 'ลูกค้าทั่วไป'}
                      </span>
                    </span>
                    <span className="tabular-nums">{money(d.total_amount)}</span>
                  </button>
                </li>
              ))}
              {refs.length === 0 && <li className="empty py-4">{translateUi("ไม่พบเอกสาร")}</li>}
            </ul>
          )}
        </section>

        {/* 2) ยอดและเหตุผล (ใบลดหนี้) */}
        {kind === 'CN' && ref && (
          <section className="mb-4 grid gap-3 sm:grid-cols-[160px_1fr]">
            <label className="block">
              <span className="label">{translateUi("ยอดลดหนี้ (รวม VAT)")}</span>
              <input
                className="input w-full num"
                type="number"
                inputMode="decimal"
                min="0.01"
                max={remaining}
                step="0.01"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value)
                  setDirty(true)
                  setChecked(false)
                }}
              />
            </label>
            <label className="block">
              <span className="label">{translateUi("เหตุผลในการลดหนี้")}</span>
              <input
                className="input w-full"
                list="cn-reasons"
                maxLength={300}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value)
                  setDirty(true)
                  setChecked(false)
                }}
              />
              <datalist id="cn-reasons">
                {CN_REASONS.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            </label>
          </section>
        )}

        {/* 3) ผู้ซื้อ */}
        <section className="mb-4">
          <h3 className="label">{kind === 'TAX' ? '2. ข้อมูลผู้ซื้อ (บังคับ)' : '2. ข้อมูลผู้ซื้อ (ตามใบเดิม แก้ได้)'}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <span className="hint">{translateUi("เลขประจำตัวผู้เสียภาษี 13 หลัก")}</span>
              <div className="flex gap-1.5">
                <input
                  className={`input w-full tabular-nums ${taxIdError ? 'border-red-400' : taxIdOk ? 'border-emerald-400' : ''}`}
                  inputMode="numeric"
                  maxLength={13}
                  value={buyer.tax_id}
                  onChange={(e) => edit('tax_id', e.target.value.replace(/\D/g, '').slice(0, 13))}
                  aria-invalid={Boolean(taxIdError)}
                />
                <button className="btn btn-secondary" disabled={!taxIdOk || busy === 'lookup'} onClick={() => void lookup('tax')}>{"" + translateUi("ค้นหา") + " "}</button>
              </div>
              {taxIdError && <p className="mt-1 field-error">{taxIdError}</p>}
              {taxIdOk && <p className="mt-1 text-xs text-emerald-600">{translateUi("✓ เลขถูกต้อง")}</p>}
            </div>
            <div>
              <span className="hint">{translateUi("เบอร์โทร (ค้นหาผู้ซื้อที่เคยออกใบ)")}</span>
              <div className="flex gap-1.5">
                <input
                  className="input w-full tabular-nums"
                  inputMode="tel"
                  maxLength={10}
                  value={buyer.phone}
                  onChange={(e) => setBuyer((b) => ({ ...b, phone: e.target.value.replace(/\D/g, '').slice(0, 10) }))}
                />
                <button className="btn btn-secondary" disabled={!/^0\d{8,9}$/.test(buyer.phone) || busy === 'lookup'} onClick={() => void lookup('phone')}>{"" + translateUi("ค้นหา") + " "}</button>
              </div>
            </div>
            <label className="block sm:col-span-2">
              <span className="hint">{translateUi("ชื่อผู้ซื้อ / บริษัท")}</span>
              <input className="input w-full" maxLength={200} value={buyer.name} onChange={(e) => edit('name', e.target.value)} />
            </label>
            <div>
              <span className="hint">{translateUi("สาขา (5 หลัก · 00000 = สำนักงานใหญ่)")}</span>
              <div className="flex gap-1.5">
                <input
                  className="input w-full tabular-nums"
                  inputMode="numeric"
                  maxLength={5}
                  value={buyer.branch_code}
                  onChange={(e) => edit('branch_code', e.target.value.replace(/\D/g, '').slice(0, 5))}
                />
                <button type="button" className="btn btn-secondary whitespace-nowrap" onClick={() => edit('branch_code', '00000')}>{"" + translateUi("สนญ.") + " "}</button>
              </div>
            </div>
            <label className="block sm:col-span-2">
              <span className="hint">{translateUi("ที่อยู่ตามทะเบียน")}</span>
              <textarea className="input w-full" rows={2} maxLength={500} value={buyer.address} onChange={(e) => edit('address', e.target.value)} />
            </label>
          </div>
        </section>

        {/* 4) เครื่อง POS ที่ออกเลข */}
        <section className="mb-4">
          <TerminalPicker setup={setup} />
        </section>

        {draft && (
          <div className="mb-3 rounded-xl bg-gray-50 p-3 text-sm">
            <div className="flex justify-between">
              <span>{"" + translateUi("ฉบับร่าง") + " "}{DOC_TITLE[draft.doc_type]}</span>
              <span className="badge badge-amber">{translateUi("ร่าง")}</span>
            </div>
            <div className="mt-1 grid grid-cols-3 gap-2 text-xs text-gray-600">
              <span>{"" + translateUi("ก่อน VAT") + " "}{money(draft.taxable_amount + draft.exempt_amount)}</span>
              <span>VAT {draft.vat_rate}% {money(draft.vat_amount)}</span>
              <span className="text-right strong-text">{"" + translateUi("รวม") + " "}{money(draft.total_amount)}</span>
            </div>
          </div>
        )}

        {problems.length > 0 && (
          <ul className="mb-3 list-inside list-disc hint">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {error && <p className="alert-error">{error}</p>}
        {notice && <p className="alert-success">{notice}</p>}

        {draft && !dirty && (
          <label className="mb-3 flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            <span>{translateUi("ตรวจสอบข้อมูลแล้ว · เอกสารที่ยืนยันจะได้เลขที่ถาวรและแก้ไขไม่ได้ (แก้ได้ด้วยใบลดหนี้เท่านั้น)")}</span>
          </label>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          {draft && (
            <button className="btn btn-secondary mr-auto text-red-600" disabled={busy !== null} onClick={() => void discard()}>{"" + translateUi("ยกเลิกร่าง") + " "}</button>
          )}
          <button className="btn btn-secondary" disabled={problems.length > 0 || busy !== null || (draft !== null && !dirty)} onClick={() => void save()}>
            {busy === 'save' ? 'กำลังบันทึก...' : draft ? 'บันทึกการแก้ไขร่าง' : 'บันทึกฉบับร่าง'}
          </button>
          <button
            className="btn btn-primary"
            disabled={!draft || dirty || !checked || !setup.terminal || busy !== null}
            title={!setup.terminal ? 'เลือกเครื่อง POS ก่อน' : dirty ? 'บันทึกร่างก่อนยืนยัน' : undefined}
            onClick={() => void confirm()}
          >
            <Icon name="check" className="h-4 w-4" />
            {busy === 'confirm' ? 'กำลังออกเลขที่...' : 'ยืนยันและล็อกเอกสาร'}
          </button>
        </div>
      </div>
    </div>
  )
}

function SelectedBox({ title, subtitle, amount, onClear }: { title: string; subtitle?: string; amount: number; onClear?: () => void }) {
  return (
    <div className="row-between rounded-xl border border-brand-300 bg-brand-50 px-3 py-2 text-sm">
      <span>
        <span className="font-medium">{title}</span>
        {subtitle && <span className="block text-xs text-gray-600">{subtitle}</span>}
      </span>
      <span className="flex items-center gap-2">
        <span className="tabular-nums">{money(amount)}</span>
        {onClear && (
          <button className="link-muted text-xs" onClick={onClear}>{"" + translateUi("เปลี่ยน") + " "}</button>
        )}
      </span>
    </div>
  )
}
