// รายงาน: กำไรต่อเมนู · งบกำไรขาดทุน · เหมา 60% vs ตามจริง · ส่งออก (ทุกโหมด)
//         สมุดรายวัน · บัญชีแยกประเภท · งบดุล · งบกระแสเงินสด · ภาษีขาย/ซื้อ (โหมดมืออาชีพ)
import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { apiDownload, apiMessage } from '../../lib/api'
import {
  SOURCE_LABEL,
  balanceSheet,
  cashFlow,
  metrics,
  normalizeSummary,
  stockCheck,
  taxDeductionCompare,
  type AccountingMode,
  type Summary,
  type TrialRow,
} from '../../lib/accounting'
import { baht } from '../../lib/format'
import { AmountTable, Money, Section, addDays, monthStart, prevMonthRange } from './ui'

type View = 'pnl' | 'menu' | 'tax60' | 'journal' | 'ledger' | 'balance' | 'cashflow' | 'vat'
const VIEWS: { key: View; label: string; pro?: boolean }[] = [
  { key: 'pnl', label: 'กำไรขาดทุน' },
  { key: 'menu', label: 'กำไรต่อเมนู' },
  { key: 'tax60', label: 'เหมา 60% vs ตามจริง' },
  { key: 'journal', label: 'สมุดรายวัน', pro: true },
  { key: 'ledger', label: 'บัญชีแยกประเภท', pro: true },
  { key: 'balance', label: 'งบดุล', pro: true },
  { key: 'cashflow', label: 'งบกระแสเงินสด', pro: true },
  { key: 'vat', label: 'ภาษีขาย/ซื้อ', pro: true },
]

interface JournalRow {
  entry_id: string
  entry_no: number
  entry_date: string
  source_type: string
  memo: string | null
  reason: string | null
  reverses_entry_id: string | null
  created_by_name: string | null
  account_code: string
  account_name: string
  debit: number
  credit: number
  line_memo: string | null
}

interface MenuProfit {
  menu_item_id: string
  name: string
  quantity: number
  revenue: number
  cost: number
  gross_profit: number
  has_recipe: boolean
}

const EXPORTS = [
  { report: 'journal', label: 'สมุดรายวัน' },
  { report: 'trial_balance', label: 'งบทดลอง' },
  { report: 'summary', label: 'งบกำไรขาดทุน' },
  { report: 'menu_profit', label: 'กำไรต่อเมนู' },
  { report: 'expenses', label: 'รายจ่าย' },
]

export default function AcctReports({ restaurantId, today, mode }: { restaurantId: string; today: string; mode: AccountingMode }) {
  const [from, setFrom] = useState(monthStart(today))
  const [to, setTo] = useState(today)
  const [view, setView] = useState<View>('pnl')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [trial, setTrial] = useState<TrialRow[]>([])
  const [menu, setMenu] = useState<MenuProfit[]>([])
  const [journal, setJournal] = useState<JournalRow[]>([])
  const [ledgerAccount, setLedgerAccount] = useState('')
  const [error, setError] = useState<string | null>(null)

  const pro = mode === 'pro'
  const views = VIEWS.filter((v) => pro || !v.pro)

  const load = useCallback(async () => {
    const args = { p_restaurant_id: restaurantId, p_from: from, p_to: to }
    const [s, t, mp] = await Promise.all([
      supabase.rpc('acct_summary', args),
      supabase.rpc('acct_trial_balance', args),
      supabase.rpc('acct_menu_profit', args),
    ])
    if (s.error || t.error || mp.error) return setError('โหลดรายงานไม่สำเร็จ (ต้องรัน migration 0026)')
    setError(null)
    setSummary(normalizeSummary(s.data as Record<string, unknown>))
    setTrial(((t.data ?? []) as TrialRow[]).map((r) => ({ ...r, opening: Number(r.opening), debit: Number(r.debit), credit: Number(r.credit), closing: Number(r.closing) })))
    setMenu(((mp.data ?? []) as MenuProfit[]).map((r) => ({ ...r, quantity: Number(r.quantity), revenue: Number(r.revenue), cost: Number(r.cost), gross_profit: Number(r.gross_profit) })))
  }, [restaurantId, from, to])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (view !== 'journal' && view !== 'ledger') return
    if (view === 'ledger' && !ledgerAccount) return setJournal([])
    void supabase
      .rpc('acct_journal_rows', { p_restaurant_id: restaurantId, p_from: from, p_to: to, p_account_id: view === 'ledger' ? ledgerAccount : null, p_limit: 5000 })
      .then(({ data, error: err }) => {
        if (err) return setError('โหลดสมุดรายวันไม่สำเร็จ')
        setJournal(((data ?? []) as JournalRow[]).map((r) => ({ ...r, debit: Number(r.debit), credit: Number(r.credit) })))
      })
  }, [view, ledgerAccount, restaurantId, from, to])

  async function download(report: string, format: 'csv' | 'xls') {
    try {
      await apiDownload(
        `/accounting/export?restaurant_id=${restaurantId}&from=${from}&to=${to}&report=${report}&format=${format}`,
        `plato-${report}-${from}_${to}.${format}`,
      )
    } catch (e) {
      setError(apiMessage(e))
    }
  }

  const presets = [
    { label: 'เดือนนี้', from: monthStart(today), to: today },
    { label: 'เดือนก่อน', ...prevMonthRange(today) },
    { label: '30 วัน', from: addDays(today, -29), to: today },
    { label: 'ปีนี้', from: today.slice(0, 4) + '-01-01', to: today },
  ]

  return (
    <div>
      {error && <p className="alert-error">{error}</p>}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {presets.map((p) => (
          <button
            key={p.label}
            className={`rounded-full border px-3 py-1 text-sm ${from === p.from && to === p.to ? 'border-gray-900 bg-gray-900 text-white' : 'bg-white text-gray-600'}`}
            onClick={() => {
              setFrom(p.from)
              setTo(p.to)
            }}
          >
            {p.label}
          </button>
        ))}
        <input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="ตั้งแต่" />
        <span className="text-sm">ถึง</span>
        <input className="input" type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} aria-label="ถึง" />
      </div>

      <div className="mb-4 flex flex-wrap gap-1 border-b" role="tablist" aria-label="รายงาน">
        {views.map((v) => (
          <button
            key={v.key}
            role="tab"
            aria-selected={view === v.key}
            onClick={() => setView(v.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${view === v.key ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-gray-500 hover:text-gray-800'}`}
          >
            {v.label}
          </button>
        ))}
      </div>
      {!pro && <p className="mb-4 text-xs text-gray-500">สมุดรายวัน บัญชีแยกประเภท งบดุล งบกระแสเงินสด และภาษีขาย/ซื้อ ดูได้ในโหมดมืออาชีพ</p>}

      {summary && view === 'pnl' && <ProfitLoss s={summary} />}
      {view === 'menu' && <MenuTable rows={menu} />}
      {summary && view === 'tax60' && <Tax60 s={summary} />}
      {view === 'journal' && <JournalTable rows={journal} />}
      {view === 'ledger' && (
        <>
          <select className="input mb-3" value={ledgerAccount} onChange={(e) => setLedgerAccount(e.target.value)} aria-label="บัญชี">
            <option value="">— เลือกบัญชี —</option>
            {trial.map((r) => (
              <option key={r.account_id} value={r.account_id}>
                {r.code} {r.name}
              </option>
            ))}
          </select>
          {ledgerAccount && <Ledger rows={journal} account={trial.find((t) => t.account_id === ledgerAccount)!} />}
        </>
      )}
      {view === 'balance' && <Balance rows={trial} to={to} />}
      {summary && view === 'cashflow' && <CashFlow s={summary} />}
      {summary && view === 'vat' && (
        <AmountTable
          rows={[
            { label: 'ภาษีขาย (จากบิลที่จ่ายแล้ว)', amount: summary.vat_output },
            { label: 'ภาษีซื้อ (จากรายจ่ายที่ใส่ภาษีซื้อ)', amount: summary.vat_input },
            { label: summary.vat_output - summary.vat_input >= 0 ? 'ภาษีที่ต้องชำระ (ประมาณการ)' : 'ภาษีชำระเกิน (ประมาณการ)', amount: summary.vat_output - summary.vat_input, strong: true },
          ]}
        />
      )}

      <Section title="ส่งออกให้นักบัญชี">
        <div className="card-flush divide-y">
          {EXPORTS.map((x) => (
            <div key={x.report} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span>{x.label}</span>
              <span className="flex gap-2">
                <button className="btn btn-secondary btn-sm" onClick={() => void download(x.report, 'csv')}>
                  CSV
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => void download(x.report, 'xls')}>
                  Excel
                </button>
              </span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-gray-500">ช่วงวันที่ {from} ถึง {to} · CSV เปิดใน Excel ได้ภาษาไทยถูกต้อง</p>
      </Section>
    </div>
  )
}

function ProfitLoss({ s }: { s: Summary }) {
  const m = metrics(s)
  const k = stockCheck(s)
  return (
    <>
      <AmountTable
        rows={[
          ...s.sales_by_account.map((r) => ({ label: r.name, amount: r.amount, indent: true })),
          { label: 'หัก ส่วนลดโปรโมชันและแต้ม', amount: -s.discounts, indent: true },
          { label: 'ยอดขายสุทธิ', amount: m.netSales, strong: true },
          ...s.expenses_by_account.filter((r) => r.grp === 'food_cost').map((r) => ({ label: r.name, amount: r.amount, indent: true })),
          { label: `ต้นทุนอาหาร (${m.foodCostPct ?? '–'}%)`, amount: m.foodCost, strong: true },
          { label: 'กำไรขั้นต้น', amount: m.grossProfit, strong: true },
          ...s.expenses_by_account.filter((r) => r.grp !== 'food_cost').map((r) => ({ label: r.name, amount: r.amount, indent: true })),
          ...(s.other_income ? [{ label: 'รายได้อื่น', amount: s.other_income, indent: true }] : []),
          { label: 'กำไรสุทธิ', amount: m.netProfit, strong: true },
        ]}
      />
      <p className="mt-2 text-xs text-gray-500">
        Prime Cost {m.primeCostPct ?? '–'}% · ต้นทุนขายจริง {baht(k.cogsActual)} = ต้นงวด {baht(k.opening)} + รับเข้า {baht(k.purchases)} − ปลายงวด {baht(k.closing)}
        {k.matches ? ' ✓' : ' (ไม่ตรง ให้ตรวจ)'}
      </p>
    </>
  )
}

function MenuTable({ rows }: { rows: MenuProfit[] }) {
  return (
    <div className="card-flush overflow-x-auto">
      <table className="w-full text-sm [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2">
        <thead>
          <tr>
            <th className="text-left">เมนู</th>
            <th className="text-right">จำนวน</th>
            <th className="text-right">ยอดขาย</th>
            <th className="text-right">ต้นทุน</th>
            <th className="text-right">กำไรขั้นต้น</th>
            <th className="text-right">%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.menu_item_id} className="border-t">
              <td>
                {r.name}
                {!r.has_recipe && <span className="badge badge-amber ml-2">ไม่มีสูตร</span>}
              </td>
              <td className="text-right tabular-nums">{r.quantity.toLocaleString('th-TH')}</td>
              <td className="text-right tabular-nums">{baht(r.revenue)}</td>
              <td className="text-right tabular-nums">{baht(r.cost)}</td>
              <td className="text-right">
                <Money value={r.gross_profit} />
              </td>
              <td className="text-right tabular-nums">{r.revenue > 0 ? ((r.gross_profit / r.revenue) * 100).toFixed(0) + '%' : '–'}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="p-6 text-center text-gray-400">
                ยังไม่มียอดขายในช่วงนี้
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="px-3 py-2 text-xs text-gray-500">ยอดขายก่อนหักส่วนลดท้ายบิล · ต้นทุนตามสูตรปัจจุบัน</p>
    </div>
  )
}

function Tax60({ s }: { s: Summary }) {
  const c = taxDeductionCompare(s)
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="card">
          <h3 className="font-semibold">หักค่าใช้จ่ายแบบเหมา 60%</h3>
          <AmountTable rows={[{ label: 'เงินได้', amount: c.income }, { label: 'หักเหมา 60%', amount: -c.flatExpense }, { label: 'เงินได้หลังหักค่าใช้จ่าย', amount: c.flatNet, strong: true }]} />
        </div>
        <div className="card">
          <h3 className="font-semibold">หักตามจริง (จากบัญชี)</h3>
          <AmountTable rows={[{ label: 'เงินได้', amount: c.income }, { label: 'ค่าใช้จ่ายจริง', amount: -c.actualExpense }, { label: 'เงินได้หลังหักค่าใช้จ่าย', amount: c.actualNet, strong: true }]} />
        </div>
      </div>
      <p className="note mt-3">
        ข้อมูลประกอบเท่านั้น ไม่ใช่คำแนะนำภาษี · ในช่วงนี้ {c.lowerNet === 'same' ? 'สองแบบเท่ากัน' : `แบบ${c.lowerNet === 'flat' ? 'เหมา 60%' : 'ตามจริง'}ทำให้เงินได้หลังหักค่าใช้จ่ายต่ำกว่า`} ·
        หักตามจริงต้องมีหลักฐานรายจ่ายครบ · ภาษีจริงขึ้นกับค่าลดหย่อนและเงินได้อื่น ควรปรึกษานักบัญชี
      </p>
    </>
  )
}

function JournalTable({ rows }: { rows: JournalRow[] }) {
  const groups = useMemo(() => {
    const m = new Map<string, JournalRow[]>()
    for (const r of rows) m.set(r.entry_id, [...(m.get(r.entry_id) ?? []), r])
    return [...m.values()]
  }, [rows])
  return (
    <div className="card-flush overflow-x-auto">
      <table className="w-full text-sm [&_td]:px-3 [&_td]:py-1.5 [&_th]:px-3 [&_th]:py-2">
        <thead>
          <tr>
            <th className="text-left">วันที่ / เลขที่</th>
            <th className="text-left">บัญชี</th>
            <th className="text-right">เดบิต</th>
            <th className="text-right">เครดิต</th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g[0].entry_id} className="border-t-2">
            <tr className="bg-gray-50">
              <td colSpan={4} className="text-xs text-gray-600">
                {g[0].entry_date} · #{g[0].entry_no} · <span className="badge badge-gray">{SOURCE_LABEL[g[0].source_type] ?? g[0].source_type}</span> {g[0].memo}
                {g[0].reason && <span className="text-red-600"> · เหตุผล: {g[0].reason}</span>}
                {g[0].created_by_name && <span> · {g[0].created_by_name}</span>}
              </td>
            </tr>
            {g.map((l, i) => (
              <tr key={i}>
                <td className="text-xs text-gray-400">{l.line_memo}</td>
                <td className={l.credit > 0 ? 'pl-8' : ''}>
                  {l.account_code} {l.account_name}
                </td>
                <td className="text-right tabular-nums">{l.debit > 0 ? baht(l.debit) : ''}</td>
                <td className="text-right tabular-nums">{l.credit > 0 ? baht(l.credit) : ''}</td>
              </tr>
            ))}
          </tbody>
        ))}
        {groups.length === 0 && (
          <tbody>
            <tr>
              <td colSpan={4} className="p-6 text-center text-gray-400">
                ไม่มีรายการในช่วงนี้
              </td>
            </tr>
          </tbody>
        )}
      </table>
    </div>
  )
}

function Ledger({ rows, account }: { rows: JournalRow[]; account: TrialRow }) {
  let bal = account.opening
  return (
    <div className="card-flush overflow-x-auto">
      <table className="w-full text-sm [&_td]:px-3 [&_td]:py-1.5 [&_th]:px-3 [&_th]:py-2">
        <thead>
          <tr>
            <th className="text-left">วันที่</th>
            <th className="text-left">รายการ</th>
            <th className="text-right">เดบิต</th>
            <th className="text-right">เครดิต</th>
            <th className="text-right">คงเหลือ (เดบิต+)</th>
          </tr>
        </thead>
        <tbody>
          <tr className="bg-gray-50">
            <td colSpan={4}>ยอดยกมา</td>
            <td className="text-right tabular-nums">{baht(account.opening)}</td>
          </tr>
          {rows.map((r, i) => {
            bal += r.debit - r.credit
            return (
              <tr key={i} className="border-t">
                <td>{r.entry_date}</td>
                <td>
                  #{r.entry_no} {SOURCE_LABEL[r.source_type] ?? r.source_type} · {r.memo}
                </td>
                <td className="text-right tabular-nums">{r.debit > 0 ? baht(r.debit) : ''}</td>
                <td className="text-right tabular-nums">{r.credit > 0 ? baht(r.credit) : ''}</td>
                <td className="text-right tabular-nums">{baht(bal)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Balance({ rows, to }: { rows: TrialRow[]; to: string }) {
  const b = balanceSheet(rows)
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="section-title">สินทรัพย์ ณ {to}</h3>
          <AmountTable rows={[...b.assets.map((a) => ({ label: `${a.code} ${a.name}`, amount: a.amount })), { label: 'รวมสินทรัพย์', amount: b.totalAssets, strong: true }]} />
        </div>
        <div>
          <h3 className="section-title">หนี้สินและส่วนของเจ้าของ</h3>
          <AmountTable
            rows={[
              ...b.liabilities.map((a) => ({ label: `${a.code} ${a.name}`, amount: a.amount })),
              ...b.equity.map((a) => ({ label: `${a.code} ${a.name}`, amount: a.amount })),
              { label: 'กำไร (ขาดทุน) สะสม', amount: b.earnings },
              { label: 'รวมหนี้สินและส่วนของเจ้าของ', amount: b.totalLiabEquity, strong: true },
            ]}
          />
        </div>
      </div>
      <p className={`mt-2 text-xs ${b.balanced ? 'text-emerald-700' : 'font-semibold text-red-600'}`}>{b.balanced ? 'งบดุลสมดุล' : 'งบดุลไม่สมดุล ให้ตรวจ'}</p>
    </>
  )
}

function CashFlow({ s }: { s: Summary }) {
  const f = cashFlow(s)
  return (
    <AmountTable
      rows={[
        { label: 'เงินสดและธนาคารต้นงวด', amount: f.open, strong: true },
        ...f.rows.map((r) => ({ label: r.label, amount: r.net, indent: true })),
        { label: 'เงินสดสุทธิจากการดำเนินงาน', amount: f.operating, strong: true },
        ...(f.financing ? [{ label: 'ยอดยกมา / เงินทุนจากเจ้าของ', amount: f.financing, indent: true }] : []),
        { label: 'เงินสดและธนาคารปลายงวด', amount: f.close, strong: true },
      ]}
    />
  )
}
