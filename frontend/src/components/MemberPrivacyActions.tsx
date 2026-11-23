import { confirmAction } from '../lib/alerts'
import { useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useText } from '../lib/preferences'

export default function MemberPrivacyActions({ restaurantId, memberId, onDeleted }: { restaurantId: string; memberId: string; onDeleted: () => void }) {
  const text = useText()
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [error, setError] = useState('')
  async function act(remove: boolean) {
    if (lock.current || (remove && !await confirmAction(text('ลบข้อมูลระบุตัวสมาชิก? ประวัติทางบัญชีที่จำเป็นจะยังคงอยู่โดยไม่ผูกกับสมาชิก และย้อนกลับไม่ได้', 'Delete this members identifying data? Required financial records remain unlinked. This cannot be undone.')))) return
    lock.current = true
    setBusy(true); setError('')
    try {
      const { data, error } = await supabase.rpc(remove ? 'member_delete' : 'member_export', { p_restaurant_id: restaurantId, p_member_id: memberId })
      if (error) throw error
      if (remove) onDeleted()
      else {
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
        const link = document.createElement('a'); link.href = url; link.download = `member-${memberId}.json`; link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
    } catch { setError(text('ทำรายการไม่สำเร็จ กรุณาตรวจสิทธิ์และลองใหม่', 'Could not complete this action. Check your access and retry.')) }
    finally { lock.current = false; setBusy(false) }
  }
  return <div className="mt-4 border-t pt-3"><div className="flex flex-wrap gap-2">
    <button disabled={busy} className="btn btn-secondary" onClick={() => void act(false)}>{text('ส่งออกข้อมูลสมาชิก', 'Export member data')}</button>
    <button disabled={busy} className="btn btn-secondary text-red-600" onClick={() => void act(true)}>{text('ลบข้อมูลสมาชิก', 'Delete member data')}</button>
    </div>{error && <p role="alert">{error}</p>}</div>
}
