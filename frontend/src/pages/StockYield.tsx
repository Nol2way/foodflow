import { useMemo, useState, type FormEvent } from 'react'
import RequireRole from '../components/RequireRole'
import { Empty, PageHead, StockNav } from '../components/stock/ui'
import { baht } from '../lib/format'
import { rolesFor, type Role } from '../lib/roles'
import { dateTime, errorText, stockApi, useLoad } from '../lib/stockApi'
import { fmtNum, yieldAverage, yieldUnitCost, type YieldKind } from '../lib/stockMath'

// Yield test (record_yield_test ใน 0029): ชั่งก่อน-หลัง 3 ครั้ง บันทึกค่าเฉลี่ย
//   trim = หลังตัดแต่ง/แกะ/ล้าง · cook = หลังปรุงสุก (ข้าวหุงได้เกิน 100%)
//   นำไปใช้ = ตั้งเป็น yield ของวัตถุดิบ -> ต้นทุนสูตรที่ใช้คำนวณใหม่ (ราคาซื้อ ÷ (trim x cook))

const KIND: Record<YieldKind, { label: string; before: string; after: string }> = {
  trim: { label: 'ตัดแต่ง (trim)', before: 'ก่อนตัดแต่ง', after: 'หลังตัดแต่ง' },
  cook: { label: 'ปรุงสุก (cook)', before: 'ดิบ', after: 'สุก' },
}
const blank = () => [0, 1, 2].map(() => ({ before: '', after: '' }))

function Board({ restaurantId, roles }: { restaurantId: string; roles: Role[] }) {
  const canWrite = roles.some((r) => ['owner', 'manager', 'stock'].includes(r))
  const ings = useLoad(() => stockApi.ingredients(restaurantId), [restaurantId])
  const tests = useLoad(() => stockApi.yieldTests(restaurantId), [restaurantId])
  const [ingredientId, setIngredientId] = useState('')
  const [kind, setKind] = useState<YieldKind>('trim')
  const [trials, setTrials] = useState(blank)
  const [apply, setApply] = useState(true)
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const ing = ings.data?.ingredients.find((i) => i.id === ingredientId)
  const filled = trials.every((t) => Number(t.before) > 0 && Number(t.after) > 0)
  const calc = useMemo(() => {
    if (!filled) return null
    try {
      return yieldAverage(trials.map((t) => ({ before: Number(t.before), after: Number(t.after) })), kind)
    } catch (e) {
      return (e as Error).message
    }
  }, [trials, kind, filled])
  const current = ing ? Number(kind === 'trim' ? ing.trim_yield_pct : ing.cook_yield_pct) : null
  const price = ing ? Number(ing.last_unit_cost ?? ing.cost_per_unit) : 0

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!ing) return setMsg({ ok: false, text: 'เลือกวัตถุดิบ' })
    if (typeof calc !== 'object' || !calc) return setMsg({ ok: false, text: 'กรอกน้ำหนักให้ครบ 3 ครั้ง (ตัดแต่งแล้วต้องไม่หนักขึ้น)' })
    setSaving(true)
    try {
      const r = await stockApi.recordYield(restaurantId, {
        ingredient_id: ing.id, kind, apply, note,
        trials: trials.map((t) => ({ before: Number(t.before), after: Number(t.after) })),
      })
      setMsg({ ok: true, text: `บันทึกแล้ว: ${ing.name} ${KIND[kind].label} เฉลี่ย ${fmtNum(r.avg_pct, 2)}%${r.applied ? ' · ตั้งเป็น yield ของวัตถุดิบและคำนวณต้นทุนสูตรใหม่แล้ว' : ''}` })
      setTrials(blank())
      setNote('')
      void tests.reload()
      void ings.reload()
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page">
      <PageHead title="Yield test" subtitle="ชั่งก่อน-หลังตัดแต่ง (หรือก่อน-หลังปรุง) 3 ครั้ง ระบบบันทึกค่าเฉลี่ย" />
      <StockNav roles={roles} />
      {msg && <p className={msg.ok ? 'alert-success' : 'alert-error'}>{msg.text}</p>}
      {(ings.error || tests.error) && <p className="alert-error">{ings.error ?? tests.error}</p>}

      {canWrite && (
        <form onSubmit={submit} className="card space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label>
              <span className="label">วัตถุดิบ</span>
              <select className="input w-full" value={ingredientId} onChange={(e) => setIngredientId(e.target.value)} required>
                <option value="">เลือก...</option>
                {(ings.data?.ingredients ?? []).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </label>
            <div>
              <span className="label">ทดสอบ</span>
              <div className="flex gap-1.5" role="radiogroup" aria-label="ประเภท yield">
                {(Object.keys(KIND) as YieldKind[]).map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={kind === k}
                    className={`rounded-xl border px-4 py-2 text-sm ${kind === k ? 'border-charcoal bg-charcoal text-white' : 'bg-white text-gray-600'}`}
                    onClick={() => setKind(k)}>
                    {KIND[k].label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            {trials.map((t, i) => {
              const one = Number(t.before) > 0 && Number(t.after) > 0 ? (Number(t.after) / Number(t.before)) * 100 : null
              return (
                <fieldset key={i} className="rounded-xl border border-gray-200 p-3">
                  <legend className="px-1 text-xs font-semibold text-gray-500">ครั้งที่ {i + 1}</legend>
                  {(['before', 'after'] as const).map((f) => (
                    <label key={f} className="mt-1 flex items-center gap-2 text-sm">
                      <span className="w-24 text-gray-600">{KIND[kind][f]}</span>
                      <input className="input w-full text-right tabular-nums" type="number" min="0" step="any" inputMode="decimal" required
                        value={t[f]} onChange={(e) => setTrials((ts) => ts.map((x, j) => (j === i ? { ...x, [f]: e.target.value } : x)))} />
                      <span className="w-8 text-gray-500">{ing?.unit ?? 'g'}</span>
                    </label>
                  ))}
                  <div className="mt-2 text-right text-sm tabular-nums text-gray-700">{one === null ? '–' : `${fmtNum(one, 2)}%`}</div>
                </fieldset>
              )
            })}
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl bg-gray-50 px-4 py-3 text-sm">
            <span>
              ค่าเฉลี่ย{' '}
              <strong className="text-lg tabular-nums">{calc && typeof calc === 'object' ? `${fmtNum(calc.avg, 2)}%` : '–'}</strong>
            </span>
            {typeof calc === 'string' && <span className="text-red-700">น้ำหนักไม่ถูกต้อง (ตัดแต่งแล้วต้องไม่หนักขึ้น)</span>}
            {ing && current !== null && (
              <span className="text-gray-600">
                ตอนนี้ตั้งไว้ {fmtNum(current, 2)}%
                {calc && typeof calc === 'object' && price > 0 && (
                  <>
                    {' '}· ต้นทุนต่อ {ing.unit} ที่ใช้ได้{' '}
                    {baht(yieldUnitCost(price, Number(ing.trim_yield_pct), Number(ing.cook_yield_pct)))} →{' '}
                    <strong>
                      {baht(yieldUnitCost(price, kind === 'trim' ? calc.avg : Number(ing.trim_yield_pct), kind === 'cook' ? calc.avg : Number(ing.cook_yield_pct)))}
                    </strong>
                  </>
                )}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <input className="input min-w-48 flex-1" maxLength={200} placeholder="หมายเหตุ เช่น กุ้งไซซ์ 40 ตัว/kg" value={note} onChange={(e) => setNote(e.target.value)} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} />
              ตั้งค่าเฉลี่ยเป็น yield ของวัตถุดิบ (ต้นทุนสูตรคำนวณใหม่)
            </label>
            <button className="btn btn-primary" disabled={saving}>{saving ? 'กำลังบันทึก...' : 'บันทึก yield test'}</button>
          </div>
        </form>
      )}

      <section className="mt-6">
        <h2 className="section-title">ผลทดสอบย้อนหลัง</h2>
        {tests.data && tests.data.tests.length === 0 ? (
          <Empty>ยังไม่มี yield test</Empty>
        ) : (
          <div className="card-flush overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-left">
                  <th className="px-3 py-2">วันที่</th>
                  <th className="px-3 py-2">วัตถุดิบ</th>
                  <th className="px-3 py-2">ประเภท</th>
                  <th className="px-3 py-2 text-right">3 ครั้ง</th>
                  <th className="px-3 py-2 text-right">เฉลี่ย</th>
                  <th className="px-3 py-2">ผู้ทดสอบ</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {(tests.data?.tests ?? []).map((t) => (
                  <tr key={t.id} className="align-top">
                    <td className="px-3 py-2 text-gray-600">{dateTime(t.created_at)}</td>
                    <td className="px-3 py-2">
                      {t.ingredients?.name ?? '-'}
                      {t.note && <div className="text-xs text-gray-500">{t.note}</div>}
                    </td>
                    <td className="px-3 py-2">{KIND[t.kind].label}{t.applied && <span className="badge badge-green ml-1.5">ใช้แล้ว</span>}</td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums text-gray-600">
                      {t.trials.map((x) => `${fmtNum(Number(x.after))}/${fmtNum(Number(x.before))}`).join(' · ')}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtNum(Number(t.avg_pct), 2)}%</td>
                    <td className="px-3 py-2 text-gray-600">{t.tested_by_name ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

export default function StockYield() {
  return <RequireRole roles={rolesFor('/stock-yield')}>{(ctx) => <Board restaurantId={ctx.restaurantId} roles={ctx.roles} />}</RequireRole>
}
