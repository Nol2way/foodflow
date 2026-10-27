import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import RequireRole from '../components/RequireRole'
import { Empty, PageHead, Stepper, StockNav } from '../components/stock/ui'
import { baht } from '../lib/format'
import { rolesFor, type Role } from '../lib/roles'
import { useSession } from '../lib/auth'
import { dateTime, errorText, stockApi, useLoad, type SheetItem } from '../lib/stockApi'
import { COUNT_TYPES, fmtNum, round, type AbcClass, type CountType } from '../lib/stockMath'

// นับสต็อกแบบ blind (submit_stock_count ใน 0029)
//   ใบนับไม่แสดงยอดในระบบ/ยอดที่ควรเหลือ · เรียงตามตำแหน่งจัดเก็บ (เดินชั้นไหนนับชั้นนั้น) · กรองคลาส ABC
//   กรอกเป็นหน่วยที่ครัวพูด (ถุง ฟอง) + เศษเป็นหน่วยฐาน · ช่องที่ไม่กรอก = ไม่ได้นับ (ไม่ปรับยอด)
//   บันทึกแล้วระบบปรับยอดเป็นยอดนับจริงทันที ผู้ตรวจ (เจ้าของ/ผู้จัดการ) รับรองภายหลัง

interface Entry {
  units: string // หน่วยครัว (หรือหน่วยฐานถ้าไม่มีหน่วยครัว)
  loose: string // เศษเป็นหน่วยฐาน
  note: string
}
const EMPTY: Entry = { units: '', loose: '', note: '' }
const ABC: AbcClass[] = ['A', 'B', 'C']

const hasDisplay = (i: SheetItem) => Boolean(i.display_unit) && Number(i.display_factor) !== 1
const counted = (e: Entry | undefined) => Boolean(e && (e.units !== '' || e.loose !== ''))
const toBaseQty = (i: SheetItem, e: Entry) =>
  round((Number(e.units) || 0) * (hasDisplay(i) ? Number(i.display_factor) : 1) + (Number(e.loose) || 0), 3)
const enteredText = (i: SheetItem, e: Entry) =>
  hasDisplay(i) ? [e.units && `${e.units} ${i.display_unit}`, e.loose && `${e.loose} ${i.unit}`].filter(Boolean).join(' + ') : ''

// ร่างใบนับเก็บในเครื่อง (นับนานแล้วรีเฟรชไม่หาย) · ไม่มีที่เก็บก็ทำงานได้ปกติ
const draftKey = (rid: string) => `plato.stockcount.${rid}`
function loadDraft(rid: string): Record<string, Entry> {
  try {
    return JSON.parse(localStorage.getItem(draftKey(rid)) ?? '{}') as Record<string, Entry>
  } catch {
    return {}
  }
}
function saveDraft(rid: string, d: Record<string, Entry>) {
  try {
    if (Object.keys(d).length) localStorage.setItem(draftKey(rid), JSON.stringify(d))
    else localStorage.removeItem(draftKey(rid))
  } catch {
    /* ไม่มีที่เก็บ: ข้าม */
  }
}

function CountSheet({ restaurantId, onDone }: { restaurantId: string; onDone: (id: string) => void }) {
  const [abc, setAbc] = useState<AbcClass[]>([])
  const [kind, setKind] = useState<CountType>('weekly')
  const [note, setNote] = useState('')
  const [entries, setEntries] = useState<Record<string, Entry>>(() => loadDraft(restaurantId))
  const [openNote, setOpenNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const sheet = useLoad(() => stockApi.countSheet(restaurantId, abc), [restaurantId, abc.join(',')])

  useEffect(() => saveDraft(restaurantId, entries), [restaurantId, entries])

  const items = useMemo(() => sheet.data?.items ?? [], [sheet.data])
  const groups = useMemo(() => {
    const m = new Map<string, SheetItem[]>()
    for (const i of items) m.set(i.storage_location ?? 'ไม่ระบุตำแหน่ง', [...(m.get(i.storage_location ?? 'ไม่ระบุตำแหน่ง') ?? []), i])
    return [...m]
  }, [items])
  const done = items.filter((i) => counted(entries[i.ingredient_id])).length
  const set = (id: string, patch: Partial<Entry>) => setEntries((e) => ({ ...e, [id]: { ...(e[id] ?? EMPTY), ...patch } }))

  async function submit() {
    const lines = items
      .filter((i) => counted(entries[i.ingredient_id]))
      .map((i) => {
        const e = entries[i.ingredient_id]
        return { ingredient_id: i.ingredient_id, counted_qty: toBaseQty(i, e), entered_text: enteredText(i, e) || undefined, note: e.note || undefined }
      })
    if (!lines.length) return setError('ยังไม่ได้กรอกยอดนับ')
    if (lines.some((l) => !(l.counted_qty >= 0))) return setError('ยอดนับต้องไม่ติดลบ')
    if (!window.confirm(`บันทึกใบนับ ${lines.length} รายการ? ระบบจะปรับยอดเป็นยอดนับจริงทันที (แก้ได้ด้วยการกลับรายการเท่านั้น)`)) return
    setSaving(true)
    try {
      const r = await stockApi.submitCount(restaurantId, { count_type: kind, note, lines })
      setEntries({})
      setError(null)
      onDone(r.count_id)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      {error && <p className="alert-error">{error}</p>}
      <div className="card mb-4 flex flex-wrap items-end gap-3">
        <label>
          <span className="label">รอบการนับ</span>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as CountType)}>
            {(Object.keys(COUNT_TYPES) as CountType[]).map((k) => <option key={k} value={k}>{COUNT_TYPES[k]}</option>)}
          </select>
        </label>
        <div>
          <span className="label">คลาส ABC (ไม่เลือก = ทั้งหมด)</span>
          <div className="flex gap-1.5" role="group" aria-label="กรองคลาส ABC">
            {ABC.map((c) => (
              <button key={c} type="button" aria-pressed={abc.includes(c)}
                className={`h-10 w-10 rounded-xl border text-sm font-semibold ${abc.includes(c) ? 'border-charcoal bg-charcoal text-white' : 'bg-white text-gray-600'}`}
                onClick={() => setAbc((a) => (a.includes(c) ? a.filter((x) => x !== c) : [...a, c].sort()))}>
                {c}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-gray-500">A = มูลค่าสูง นับบ่อย (เช่น ทุกวัน) · C = นับรายเดือน</p>
        <span className="ml-auto text-sm text-gray-600">นับแล้ว <strong>{done}</strong> / {items.length}</span>
      </div>

      {sheet.error && <p className="alert-error">{sheet.error}</p>}
      {!sheet.loading && items.length === 0 && <Empty>ไม่มีวัตถุดิบในคลาสที่เลือก</Empty>}

      <div className="space-y-5">
        {groups.map(([loc, list]) => (
          <section key={loc}>
            <h2 className="mb-2 text-sm font-semibold text-gray-500">📍 {loc}</h2>
            <ul className="card-flush divide-y">
              {list.map((i) => {
                const e = entries[i.ingredient_id] ?? EMPTY
                const disp = hasDisplay(i)
                return (
                  <li key={i.ingredient_id} className={`p-3 ${counted(e) ? 'bg-sage-50/60' : ''}`}>
                    <div className="mb-2 flex items-center gap-2">
                      <span className="font-medium text-gray-900">{i.name}</span>
                      <span className="badge badge-gray">{i.abc_class}</span>
                      {counted(e) && <span className="text-xs text-gray-500">= {fmtNum(toBaseQty(i, e))} {i.unit}</span>}
                      <button type="button" className="link-muted ml-auto text-xs" onClick={() => setOpenNote(openNote === i.ingredient_id ? null : i.ingredient_id)}>
                        {e.note ? 'แก้เหตุผล' : 'เหตุผล'}
                      </button>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                      <Stepper label={i.name} unit={disp ? i.display_unit! : i.unit} step={1} value={e.units} onChange={(v) => set(i.ingredient_id, { units: v })} />
                      {disp && (
                        <label className="flex items-center gap-1.5 text-sm text-gray-500">
                          + เศษ
                          <input className="input h-12 w-24 text-right tabular-nums" type="number" min="0" step="any" inputMode="decimal" placeholder="0"
                            value={e.loose} onChange={(ev) => set(i.ingredient_id, { loose: ev.target.value })} aria-label={`เศษ ${i.name} (${i.unit})`} />
                          {i.unit}
                        </label>
                      )}
                    </div>
                    {disp && <p className="mt-1 text-xs text-gray-400">1 {i.display_unit} = {fmtNum(Number(i.display_factor))} {i.unit}</p>}
                    {(openNote === i.ingredient_id || e.note) && (
                      <input className="input mt-2 w-full" maxLength={200} placeholder="เหตุผล (ไม่บังคับ) เช่น ตกแตก หมดอายุทิ้ง"
                        value={e.note} onChange={(ev) => set(i.ingredient_id, { note: ev.target.value })} />
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>

      {items.length > 0 && (
        <div className="sticky bottom-0 mt-4 -mx-4 flex flex-wrap items-center gap-2 border-t bg-surface/95 px-4 py-3 backdrop-blur">
          <input className="input min-w-40 flex-1" maxLength={300} placeholder="หมายเหตุใบนับ" value={note} onChange={(e) => setNote(e.target.value)} />
          {done > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.confirm('ล้างยอดที่กรอกทั้งหมด?') && setEntries({})}>ล้าง</button>}
          <button type="button" className="btn btn-primary" disabled={saving || done === 0} onClick={() => void submit()}>
            {saving ? 'กำลังบันทึก...' : `บันทึกใบนับ (${done})`}
          </button>
        </div>
      )}
    </div>
  )
}

function CountList({ restaurantId, roles, justSaved }: { restaurantId: string; roles: Role[]; justSaved: string | null }) {
  const { session } = useSession()
  const list = useLoad(() => stockApi.counts(restaurantId), [restaurantId, justSaved])
  const [error, setError] = useState<string | null>(null)
  const isOwner = roles.includes('owner')
  const canVerify = isOwner || roles.includes('manager')

  async function verify(id: string) {
    try {
      await stockApi.verifyCount(restaurantId, id)
      setError(null)
      void list.reload()
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <div>
      {justSaved && (
        <p className="alert-success">
          บันทึกใบนับแล้ว ยอดในระบบปรับเป็นยอดนับจริง · <Link className="link" to={`/stock-variance?count=${justSaved}`}>ดูรายงานส่วนต่าง</Link>
        </p>
      )}
      {(error || list.error) && <p className="alert-error">{error ?? list.error}</p>}
      {list.data && list.data.counts.length === 0 && <Empty>ยังไม่มีใบนับ</Empty>}
      <ul className="card-flush divide-y text-sm">
        {(list.data?.counts ?? []).map((c) => {
          const mine = c.counted_by === session?.user.id
          return (
            <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
              <span className="min-w-48 flex-1">
                <span className="block font-medium text-gray-900">{dateTime(c.created_at)} · {COUNT_TYPES[c.count_type]}</span>
                <span className="text-xs text-gray-500">ผู้นับ {c.counted_by_name ?? '-'} · {c.item_count} รายการ · ไม่ตรง {c.diff_count}</span>
              </span>
              <span className={`tabular-nums ${Number(c.diff_value) < 0 ? 'text-red-700' : 'text-gray-700'}`}>{baht(Number(c.diff_value))}</span>
              {c.verified_at ? (
                <span className="badge badge-green">รับรองแล้ว · {c.verified_by_name ?? '-'}</span>
              ) : canVerify && (!mine || isOwner) ? (
                <button className="btn btn-secondary btn-sm" onClick={() => void verify(c.id)}>รับรองใบนับ</button>
              ) : (
                <span className="badge badge-gray">รอผู้ตรวจ</span>
              )}
              <Link className="link" to={`/stock-variance?count=${c.id}`}>ส่วนต่าง</Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function Board({ restaurantId, roles }: { restaurantId: string; roles: Role[] }) {
  const [tab, setTab] = useState<'count' | 'list'>('count')
  const [saved, setSaved] = useState<string | null>(null)
  const chip = (on: boolean) => `rounded-full border px-3.5 py-1.5 text-sm transition ${on ? 'border-gray-900 bg-gray-900 text-white' : 'bg-white text-gray-600 hover:border-gray-300'}`
  return (
    <div className="page">
      <PageHead
        title="นับสต็อก"
        subtitle="นับแบบ blind: ไม่แสดงยอดในระบบ · เดินตามชั้นวาง · ช่องที่ไม่กรอก = ไม่ได้นับ"
        action={
          <>
            <button className={chip(tab === 'count')} onClick={() => setTab('count')}>ใบนับ</button>
            <button className={chip(tab === 'list')} onClick={() => setTab('list')}>ใบนับย้อนหลัง</button>
          </>
        }
      />
      <StockNav roles={roles} />
      {tab === 'count' ? (
        <CountSheet restaurantId={restaurantId} onDone={(id) => { setSaved(id); setTab('list') }} />
      ) : (
        <CountList restaurantId={restaurantId} roles={roles} justSaved={saved} />
      )}
    </div>
  )
}

export default function StockCount() {
  return <RequireRole roles={rolesFor('/stock-count')}>{(ctx) => <Board restaurantId={ctx.restaurantId} roles={ctx.roles} />}</RequireRole>
}
