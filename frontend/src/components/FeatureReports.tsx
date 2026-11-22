import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { baht } from '../lib/format'
import { useText } from '../lib/preferences'

type PromotionResult = { id: string; name: string; uses: number; orders: number; discount: number; attributed_sales: number }
type FeedbackResult = { count: number; average: number | null; ratings: Record<string, number> }
export default function FeatureReports({ restaurantId, date, kind }: { restaurantId: string; date: string; kind: 'promotions' | 'feedback' }) {
  const text = useText()
  const seq = useRef(0)
  const [promos, setPromos] = useState<PromotionResult[]>([])
  const [feedback, setFeedback] = useState<FeedbackResult | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const current = ++seq.current
    setPromos([]); setFeedback(null); setError('')
    void Promise.resolve(supabase.rpc(kind === 'promotions' ? 'promo_report' : 'feedback_report', { p_restaurant_id: restaurantId, p_from: date, p_to: date })).then(({ data, error }) => {
      if (current !== seq.current) return
      if (error) setError(text('โหลดสรุปไม่สำเร็จ', 'Could not load this summary'))
      else if (kind === 'promotions') setPromos((data ?? []) as PromotionResult[])
      else setFeedback(data as FeedbackResult)
    })
    return () => { seq.current++ }
  }, [restaurantId, date, kind])
  return <section className="card mt-4">
    <h2 className="section-title">{kind === 'promotions' ? text('ผลโปรโมชัน', 'Promotion results') : text('ความพึงพอใจลูกค้า', 'Customer feedback')} · {date}</h2>
    {error && <p role="alert">{error}</p>}
    {kind === 'promotions' ? <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th>{text('โปรโมชัน', 'Promotion')}</th><th>{text('ครั้ง', 'Uses')}</th><th>{text('ส่วนลด', 'Discount')}</th><th>{text('ยอดขายที่ร่วมโปร', 'Attributed sales')}</th></tr></thead><tbody>{promos.map(row => <tr key={row.id}><td>{row.name}</td><td>{row.uses}</td><td>{baht(Number(row.discount))}</td><td>{baht(Number(row.attributed_sales))}</td></tr>)}</tbody></table><p className="hint">{text('บิลที่ใช้หลายโปรอาจปรากฏในแต่ละโปร ยอดคอลัมน์นี้ไม่ใช่ยอดขายสุทธิรวมร้าน', 'A bill with several promotions can appear in each promotion. This column is not total shop revenue.')}</p></div>
      : feedback && <><p>{text('คะแนนเฉลี่ย', 'Average')} {feedback.average === null ? '—' : Number(feedback.average).toFixed(1)} / 5 · {feedback.count} {text('คำตอบ', 'responses')}</p><ul>{[1,2,3,4,5].map(star => <li key={star}>{star} ★: {feedback.ratings?.[star] ?? 0}</li>)}</ul></>}
  </section>
}
