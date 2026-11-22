import { useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useText } from '../lib/preferences'

export default function Feedback({ restaurantId }: { restaurantId: string }) {
  const text = useText()
  const key = useRef(crypto.randomUUID())
  const lock = useRef(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [chosen, setChosen] = useState<number | null>(null)
  async function submit(rating: number) {
    if (lock.current || done || (chosen !== null && chosen !== rating)) return
    setChosen(rating)
    lock.current = true; setBusy(true); setError('')
    try {
      const result = await supabase.rpc('submit_feedback', { p_restaurant_id: restaurantId, p_rating: rating, p_client_ref: key.current })
      if (result.error) throw result.error
      setDone(true)
    } catch { setError(text('ส่งคะแนนไม่สำเร็จ ลองอีกครั้งได้', 'Could not send your rating. Please retry.')) }
    finally { lock.current = false; setBusy(false) }
  }
  return <section className="card my-3" aria-label={text('ความพึงพอใจ', 'Feedback')}>
    {done ? <p role="status">{text('ขอบคุณสำหรับความคิดเห็น', 'Thank you for your feedback')}</p> : <>
      <p>{text('ให้คะแนนบริการ 1-5 ดาว (ไม่เก็บชื่อหรือเบอร์โทร)', 'Rate your visit from 1 to 5 stars (no name or phone collected)')}</p>
      <div className="mt-2 flex gap-2">{[1, 2, 3, 4, 5].map(rating => <button key={rating} type="button" disabled={busy || (chosen !== null && chosen !== rating)} className="btn btn-secondary" aria-label={text(`${rating} ดาว`, `${rating} stars`)} onClick={() => void submit(rating)}>{rating} ★</button>)}</div>
      {error && <p role="alert">{error}</p>}
    </>}
  </section>
}
