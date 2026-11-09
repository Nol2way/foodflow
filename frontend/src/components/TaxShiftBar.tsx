import { useState } from 'react'
import type { TaxSetup } from '../lib/tax'
import ShiftModal, { type CurrentShift } from './ShiftModal'
import TaxDocModal from './TaxDocModal'
import Receipt from './Receipt'
import Icon from './Icon'

// ปุ่มบนหัวหน้า POS/รับชำระ: สถานะกะ + ออกใบกำกับภาษีเต็มรูป/ใบลดหนี้ (เปิดโมดัลและพิมพ์เอกสารในตัว)
export default function TaxShiftBar({ restaurantId, setup, current }: { restaurantId: string; setup: TaxSetup; current: CurrentShift }) {
  const [modal, setModal] = useState<'shift' | 'tax' | null>(null)
  const [print, setPrint] = useState<{ documentId: string } | { shiftId: string } | null>(null)
  const open = current.shift

  return (
    <>
      <div className="toolbar">
        <button
          className={`btn ${open ? 'btn-secondary' : 'btn-primary'}`}
          onClick={() => setModal('shift')}
          title={open ? `กะเปิดเมื่อ ${new Date(open.opened_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}` : undefined}
        >
          <Icon name="clock" className="h-4 w-4" />
          {!current.loaded ? 'กะ...' : open ? 'กะเปิดอยู่' : 'เปิดกะ'}
          {open && <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />}
        </button>
        <button className="btn btn-secondary" onClick={() => setModal('tax')} disabled={!setup.loaded}>
          <Icon name="report" className="h-4 w-4" />
          ใบกำกับภาษี / ใบลดหนี้
        </button>
      </div>

      {modal === 'shift' && (
        <ShiftModal
          restaurantId={restaurantId}
          setup={setup}
          current={current}
          onClose={() => setModal(null)}
          onPrint={(shiftId) => {
            setModal(null)
            setPrint({ shiftId })
          }}
        />
      )}
      {modal === 'tax' && (
        <TaxDocModal
          restaurantId={restaurantId}
          setup={setup}
          onClose={() => setModal(null)}
          onOpenDocument={(documentId) => {
            setModal(null)
            setPrint({ documentId })
          }}
        />
      )}
      {print && ('shiftId' in print ? <Receipt shiftId={print.shiftId} onClose={() => setPrint(null)} /> : <Receipt documentId={print.documentId} onClose={() => setPrint(null)} />)}
    </>
  )
}
