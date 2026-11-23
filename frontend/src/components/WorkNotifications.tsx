import { useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from './Icon'
import Modal from './Modal'
import { useText } from '../lib/preferences'
import { translateUi } from '../lib/uiText'
import type { useWorkNotifications } from '../lib/useWorkNotifications'

export default function WorkNotifications({ work, onNavigate }: { work: ReturnType<typeof useWorkNotifications>; onNavigate: () => void }) {
  const t = useText()
  const [open, setOpen] = useState(false)
  if (!work.items.length) return null
  return <>
    {work.loaded && !work.error && <span className="sr-only" role="status">{t(`${work.total} งานรอดำเนินการ`, `${work.total} tasks need attention`)}</span>}
    <button type="button" className="notification-trigger" aria-haspopup="dialog" aria-expanded={open} aria-label={t('การแจ้งเตือน', 'Notifications') + (work.loaded && !work.error ? ` (${work.total})` : '')} onClick={() => setOpen(true)}>
      <Icon name="bell" className="h-5 w-5" />
      {work.loaded && !work.error && work.total > 0 && <span aria-hidden="true" className="notification-count">{work.total > 99 ? '99+' : work.total}</span>}
      {work.error && <span aria-hidden="true" className="notification-count">!</span>}
    </button>
    {open && <Modal label={t('การแจ้งเตือน', 'Notifications')} onClose={() => setOpen(false)} className="max-w-md p-6">
      <div className="flex items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">{t('งานที่ต้องดู', 'Needs attention')}</h2><p className="hint mt-1">{t('อัปเดตจากสถานะออเดอร์ของร้าน', 'Live tasks from your restaurant orders')}</p></div><button className="btn btn-ghost p-2" aria-label={t('ปิดการแจ้งเตือน', 'Close notifications')} onClick={() => setOpen(false)}><Icon name="close" /></button></div>
      {!work.loaded ? <div role="status" aria-busy="true" className="space-y-3 py-6"><span className="sr-only">{t('กำลังโหลดการแจ้งเตือน', 'Loading notifications')}</span>{[0, 1, 2].map(i => <div key={i} aria-hidden="true" className="skeleton-block h-14 w-full" />)}</div>
        : work.error ? <div role="alert" className="alert-error my-5">{t('โหลดการแจ้งเตือนไม่สำเร็จ', 'Unable to load notifications')}<button className="btn btn-secondary mt-3" onClick={() => void work.reload()}>{t('ลองใหม่', 'Retry')}</button></div>
        : <><p role="status" className="my-5 text-sm text-gray-600">{work.total ? t(`${work.total} งานรอดำเนินการ`, `${work.total} tasks need attention`) : t('ไม่มีงานค้างในตอนนี้', 'You are all caught up')}</p><div className="divide-y">{work.items.filter(item => item.count > 0).map(item => <Link key={item.path} className="notification-item" to={item.path} onClick={() => { setOpen(false); onNavigate() }}><Icon name={item.path === '/kitchen' ? 'kitchen' : item.path === '/serve' ? 'serve' : 'counter'} /><div className="min-w-0 flex-1"><strong className="block font-medium">{translateUi(item.title)}</strong><span className="hint">{item.path === '/kitchen' ? t('ออเดอร์ใหม่รอเริ่มทำ', 'New orders waiting to be started') : item.path === '/serve' ? t('อาหารพร้อมส่งให้ลูกค้า', 'Orders ready to serve') : t('โต๊ะหรือบิลที่รอชำระ', 'Tables or bills awaiting payment')}</span></div><span className="work-badge">{item.count}</span></Link>)}</div></>}
    </Modal>}
  </>
}
