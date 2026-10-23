import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { maskPromptPay, promptPayPayload } from '../lib/promptpay'
import { baht } from '../lib/format'

// QR พร้อมเพย์ใส่ยอดเงิน ให้ลูกค้าสแกนด้วยแอปธนาคาร
export default function PromptPayQR({ id, amount, size = 260 }: { id: string; amount: number; size?: number }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    try {
      void QRCode.toString(promptPayPayload(id, amount), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then((s) => {
        if (alive) setSvg(s)
      })
      setError(false)
    } catch {
      setError(true)
    }
    return () => {
      alive = false
    }
  }, [id, amount])

  if (error) return <p className="alert-error">เลขพร้อมเพย์ของร้านไม่ถูกต้อง แก้ได้ที่หน้าตั้งค่าร้าน</p>
  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-full rounded-t-xl bg-[#113566] py-2 text-sm font-bold tracking-wide text-white">THAI QR PAYMENT · พร้อมเพย์</div>
      {/* svg มาจากไลบรารี qrcode ที่สร้างจากข้อความของเราเอง */}
      <div className="border-x border-b bg-white p-3" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg ?? '' }} />
      <div className="mt-3 text-3xl font-extrabold tabular-nums text-gray-900">{baht(amount)}</div>
      <div className="text-sm text-gray-500">พร้อมเพย์ {maskPromptPay(id)}</div>
    </div>
  )
}
