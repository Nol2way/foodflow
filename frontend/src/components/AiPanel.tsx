import { useState, type FormEvent } from 'react'
import { api, apiMessage } from '../lib/api'

// สรุป/ถามด้วย AI: backend ส่งเฉพาะตัวเลขที่ฐานข้อมูลคำนวณแล้วให้ Gemini
// และส่งตัวเลขชุดเดียวกันกลับมาให้ตรวจสอบได้ (กด "ดูตัวเลขที่ AI ใช้")
export default function AiPanel({ restaurantId, days }: { restaurantId: string; days: number }) {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [facts, setFacts] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function ask(e?: FormEvent) {
    e?.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ answer: string; facts: unknown }>('/ai/summary', {
        body: { restaurant_id: restaurantId, days, question: question.trim() || undefined },
      })
      setAnswer(r.answer)
      setFacts(r.facts)
    } catch (err) {
      setError(apiMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card mt-6">
      <h2 className="section-title">ผู้ช่วย AI</h2>
      <form onSubmit={ask} className="flex flex-col gap-2 sm:flex-row">
        <input
          className="input flex-1"
          maxLength={500}
          placeholder="ถามเช่น ควรเพิ่มพนักงานช่วงไหน เมนูไหนควรขึ้นราคา (เว้นว่าง = สรุปภาพรวม)"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'กำลังวิเคราะห์...' : question.trim() ? 'ถาม' : 'สรุป ' + days + ' วัน'}
        </button>
      </form>
      {error && <p className="alert-error mt-3 mb-0">{error}</p>}
      {answer && <div className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{answer}</div>}
      {facts !== null && (
        <details className="mt-3 text-xs text-gray-500">
          <summary className="cursor-pointer">ดูตัวเลขที่ AI ใช้</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-gray-50 p-3">{JSON.stringify(facts, null, 2)}</pre>
        </details>
      )}
      <p className="mt-2 text-xs text-gray-400">คำตอบจาก AI เป็นคำแนะนำประกอบการตัดสินใจ ตรวจกับตัวเลขด้านบนก่อนใช้</p>
    </section>
  )
}
