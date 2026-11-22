import { translateUi } from "../lib/uiText"
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import RequireRole from '../components/RequireRole'
import { Empty, PageHead, StockNav } from '../components/stock/ui'
import { baht } from '../lib/format'
import { rolesFor, type Role } from '../lib/roles'
import { stockApi, shortDate, useLoad, dateTime, type StockIngredient } from '../lib/stockApi'
import { COUNT_TYPES, displayQty, fmtNum } from '../lib/stockMath'

// สต็อกทั้งหมด: ทุกวัตถุดิบที่เปิดใช้ จัดกลุ่มตามที่เก็บ (เรียงตามชั้นเหมือนใบนับ) · สถานะหมด/ใกล้หมดใช้ชุดเดียวกับ stock_overview
function AllStock({ items, outIds, lowIds }: { items: StockIngredient[]; outIds: Set<string>; lowIds: Set<string> }) {
  const [q, setQ] = useState('')
  const groups = useMemo(() => {
    const term = q.trim().toLowerCase()
    const m = new Map<string, StockIngredient[]>()
    for (const i of [...items].sort((a, b) => a.shelf_order - b.shelf_order || a.name.localeCompare(b.name, 'th'))) {
      if (term && !i.name.toLowerCase().includes(term)) continue
      const k = i.storage_location ?? 'ไม่ระบุที่เก็บ'
      m.set(k, [...(m.get(k) ?? []), i])
    }
    return [...m].sort(([a], [b]) => a.localeCompare(b, 'th'))
  }, [items, q])

  return (
    <section className="mt-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="section-title mb-0">{translateUi("สต็อกทั้งหมด (")}{items.length})</h2>
        <input className="input h-9 w-full sm:w-56" placeholder={translateUi("ค้นหาวัตถุดิบ")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={translateUi("ค้นหาวัตถุดิบ")} />
      </div>
      {groups.length === 0 ? <Empty>{items.length ? 'ไม่พบวัตถุดิบที่ค้นหา' : 'ยังไม่มีวัตถุดิบ'}</Empty> : (
        <div className="space-y-4">
          {groups.map(([loc, list]) => (
            <div key={loc} className="table-wrap">
              <div className="border-b bg-gray-50 px-4 py-2 text-sm strong-text">📍 {loc}</div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-right hint">
                    <th className="px-4 py-1.5 text-left font-medium">{translateUi("วัตถุดิบ")}</th>
                    <th className="px-2 py-1.5 font-medium">{translateUi("คงเหลือ")}</th>
                    <th className="px-2 py-1.5 font-medium">{translateUi("จุดสั่ง")}</th>
                    <th className="px-4 py-1.5 font-medium">{translateUi("มูลค่า")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {list.map((i) => {
                    const qty = Number(i.quantity_on_hand)
                    return (
                      <tr key={i.id} className="num">
                        <td className="px-4 py-2 text-left">
                          {i.name} <span className="badge badge-gray">{i.abc_class}</span>
                          {outIds.has(i.id) && <span className="badge badge-red ml-1">{translateUi("หมด")}</span>}
                          {lowIds.has(i.id) && <span className="badge badge-amber ml-1">{translateUi("ใกล้หมด")}</span>}
                        </td>
                        <td className="px-2 py-2 text-gray-900">
                          {displayQty(qty, i.unit, i.display_unit, Number(i.display_factor))}
                          {i.display_unit && Number(i.display_factor) !== 1 && <span className="block hint">{fmtNum(qty)} {i.unit}</span>}
                        </td>
                        <td className="px-2 py-2 text-gray-600">{fmtNum(Number(i.reorder_level))} {i.unit}</td>
                        <td className="px-4 py-2 text-gray-600">{baht(qty * Number(i.cost_per_unit))}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// ภาพรวมสต็อก: ใกล้หมด · หมด · ใกล้หมดอายุ · มูลค่าสต็อก · แนะนำสั่งวันนี้ (stock_overview ใน 0029) · สต็อกทั้งหมด
function Board({ restaurantId, roles }: { restaurantId: string; roles: Role[] }) {
  const { data: o, error, loading } = useLoad(() => stockApi.overview(restaurantId), [restaurantId], 'stock.overview')
  const all = useLoad(() => stockApi.ingredients(restaurantId), [restaurantId], 'stock.ingredients')
  const canWrite = roles.some((r) => ['owner', 'manager', 'stock'].includes(r))

  const bySupplier = new Map<string, NonNullable<typeof o>['reorder_today']>()
  for (const r of o?.reorder_today ?? []) {
    const k = r.supplier_name ?? 'ยังไม่ระบุผู้ขาย'
    bySupplier.set(k, [...(bySupplier.get(k) ?? []), r])
  }

  return (
    <div className="page">
      <PageHead
        title={translateUi("ภาพรวมสต็อก")}
        subtitle={translateUi("ยอดคงเหลือมาจากประวัติรับเข้า ตัดตามสูตร และการนับเท่านั้น (แก้ตรงไม่ได้)")}
        action={canWrite && (
          <>
            <Link className="btn btn-primary btn-sm" to="/stock-receive">{translateUi("รับเข้า")}</Link>
            <Link className="btn btn-secondary btn-sm" to="/stock-count">{translateUi("นับสต็อก")}</Link>
          </>
        )}
      />
      <StockNav roles={roles} />
      {error && <p className="alert-error">{error}</p>}
      {loading && !o && <p className="text-sm text-gray-500">{translateUi("กำลังโหลด...")}</p>}
      {o && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="stat">
              <div className="stat-label">{translateUi("มูลค่าสต็อก (FIFO)")}</div>
              <div className="stat-value">{baht(Number(o.stock_value))}</div>
              <div className="mt-1 hint">{o.ingredient_count}{" " + translateUi("วัตถุดิบ") + ""}</div>
            </div>
            <div className="stat">
              <div className="stat-label">{translateUi("หมด")}</div>
              <div className={`stat-value ${o.out.length ? 'text-red-600' : ''}`}>{o.out.length}</div>
            </div>
            <div className="stat">
              <div className="stat-label">{translateUi("ใกล้หมด")}</div>
              <div className={`stat-value ${o.low.length ? 'text-amber-800' : ''}`}>{o.low.length}</div>
            </div>
            <div className="stat">
              <div className="stat-label">{translateUi("ใกล้หมดอายุ (3 วัน)")}</div>
              <div className={`stat-value ${o.expiring.length ? 'text-amber-800' : ''}`}>{o.expiring.length}</div>
            </div>
          </div>

          {o.recipe_alerts.length > 0 && (
            <div className="alert-warn mt-4">
              <strong>{translateUi("สูตรหรือ yield อาจไม่ตรง:")}</strong>{" " + translateUi("นับแล้วติดลบต่อเนื่อง 3 รอบขึ้นไป —") + ""}{' '}
              {o.recipe_alerts.map((a) => `${a.name} (${a.streak} รอบ)`).join(' · ')}
              <div className="mt-1 text-xs">{"" + translateUi("ตรวจปริมาณที่ตักจริงเทียบสูตร หรือทำ") + " "}<Link className="link" to="/stock-yield">yield test</Link>{" " + translateUi("ใหม่") + ""}</div>
            </div>
          )}
          {o.stock_disabled_menus.length > 0 && (
            <div className="alert-error mt-4">{"" + translateUi("ระบบปิดเมนูเพราะวัตถุดิบไม่พอ:") + " "}{o.stock_disabled_menus.map((m) => m.name).join(' · ')}
              <span className="block text-xs">{translateUi("รับของเข้าหรือนับสต็อก แล้วเมนูจะเปิดให้อัตโนมัติ")}</span>
            </div>
          )}

          <section className="mt-6">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="section-title mb-0">{translateUi("แนะนำสั่งวันนี้")}</h2>
              <span className="hint">{translateUi("par = ใช้ต่อวัน × (lead time + รอบสั่ง) + safety stock")}</span>
            </div>
            {bySupplier.size === 0 ? (
              <Empty>{translateUi("ไม่มีรายการที่ต้องสั่งวันนี้")}</Empty>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {[...bySupplier].map(([sup, rows]) => (
                  <div key={sup} className="card-flush">
                    <div className="border-b bg-gray-50 px-4 py-2 text-sm strong-text">
                      {sup}
                      {rows[0].next_delivery && <span className="ml-2 font-normal text-gray-500">{"" + translateUi("ของถึง") + " "}{shortDate(rows[0].next_delivery)}</span>}
                    </div>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-right hint">
                          <th className="px-4 py-1.5 text-left font-medium">{translateUi("วัตถุดิบ")}</th>
                          <th className="px-2 py-1.5 font-medium">{translateUi("คงเหลือ")}</th>
                          <th className="px-2 py-1.5 font-medium">par</th>
                          <th className="px-4 py-1.5 font-medium">{translateUi("สั่ง")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {rows.map((r) => (
                          <tr key={r.ingredient_id} className="num">
                            <td className="px-4 py-2 text-left">{r.name}</td>
                            <td className="px-2 py-2 text-gray-600">{fmtNum(r.on_hand)} {r.unit}</td>
                            <td className="px-2 py-2 text-gray-600">{fmtNum(r.par)}{r.par_source === 'manual' && <span className="text-xs text-gray-400">{" " + translateUi("(ตั้งเอง)") + ""}</span>}</td>
                            <td className="px-4 py-2 strong-text">{fmtNum(r.suggested_purchase_qty, 0)} {r.purchase_unit}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className="mt-6 grid gap-4 lg:grid-cols-3">
            <section>
              <h2 className="section-title">{translateUi("หมด")}</h2>
              {o.out.length === 0 ? <Empty>{translateUi("ไม่มีวัตถุดิบที่หมด")}</Empty> : (
                <ul className="list-card">
                  {o.out.map((x) => (
                    <li key={x.id} className="flex items-center justify-between px-4 py-2.5">
                      {x.name}
                      <span className="badge badge-red">{translateUi("หมด")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h2 className="section-title">{translateUi("ใกล้หมด")}</h2>
              {o.low.length === 0 ? <Empty>{translateUi("ไม่มีวัตถุดิบใกล้หมด")}</Empty> : (
                <ul className="list-card">
                  {o.low.map((x) => (
                    <li key={x.id} className="row-between px-4 py-2.5">
                      <span>{x.name}</span>
                      <span className="num text-amber-800">
                        {displayQty(Number(x.on_hand), x.unit, x.display_unit, Number(x.display_factor))}
                        <span className="block hint">{"" + translateUi("จุดสั่ง") + " "}{fmtNum(Number(x.threshold))} {x.unit}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h2 className="section-title">{translateUi("ใกล้หมดอายุ")}</h2>
              {o.expiring.length === 0 ? <Empty>{translateUi("ไม่มีล็อตที่หมดอายุใน 3 วัน")}</Empty> : (
                <ul className="list-card">
                  {o.expiring.map((x) => (
                    <li key={x.lot_id} className="row-between px-4 py-2.5">
                      <span>
                        {x.name}
                        <span className="block hint">{fmtNum(Number(x.qty))} {x.unit} · {baht(Number(x.value))}</span>
                      </span>
                      <span className={`badge ${x.days_left <= 0 ? 'badge-red' : 'badge-amber'}`}>
                        {x.days_left < 0 ? `หมดอายุแล้ว ${-x.days_left} วัน` : x.days_left === 0 ? 'หมดอายุวันนี้' : `อีก ${x.days_left} วัน`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 hint">{translateUi("ระบบหยิบล็อตที่หมดอายุก่อนออกก่อน (FEFO) ให้อัตโนมัติ")}</p>
            </section>
          </div>

          {all.error && <p className="alert-error mt-6">{all.error}</p>}
          {all.data && (
            <AllStock items={all.data.ingredients} outIds={new Set(o.out.map((x) => x.id))} lowIds={new Set(o.low.map((x) => x.id))} />
          )}

          <section className="mt-6">
            <h2 className="section-title">{translateUi("นับล่าสุด")}</h2>
            {o.last_count ? (
              <div className="card flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <span>{dateTime(o.last_count.created_at)} · {COUNT_TYPES[o.last_count.count_type]} · {o.last_count.counted_by_name ?? '-'}</span>
                <span className={Number(o.last_count.diff_value) < 0 ? 'text-red-700' : 'text-gray-700'}>{"" + translateUi("ส่วนต่างรวม") + " "}{baht(Number(o.last_count.diff_value))}</span>
                {o.last_count.verified_at ? <span className="badge badge-green">{translateUi("รับรองแล้ว")}</span> : <span className="badge badge-gray">{translateUi("รอผู้ตรวจรับรอง")}</span>}
                <Link className="link ml-auto" to={`/stock-variance?count=${o.last_count.id}`}>{translateUi("ดูรายงานส่วนต่าง")}</Link>
              </div>
            ) : (
              <Empty>{translateUi("ยังไม่เคยนับสต็อก")}</Empty>
            )}
          </section>
        </>
      )}
    </div>
  )
}

export default function Stock() {
  return <RequireRole roles={rolesFor('/stock')}>{(ctx) => <Board restaurantId={ctx.restaurantId} roles={ctx.roles} />}</RequireRole>
}
