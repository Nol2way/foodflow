import { translateUi } from "../lib/uiText"
import type { TaxSetup } from '../lib/tax'

// เลือกเครื่อง POS ของอุปกรณ์นี้ (จำไว้ในเบราว์เซอร์) · ใช้ออกเลขที่เอกสารและผูกกะ
export default function TerminalPicker({ setup, compact = false }: { setup: TaxSetup; compact?: boolean }) {
  if (setup.loaded && setup.terminals.length === 0) {
    return <p className="text-xs text-amber-700">{translateUi("ยังไม่มีเครื่อง POS ในระบบ ให้เจ้าของร้าน/ผู้จัดการเพิ่มที่หน้าตั้งค่าก่อน")}</p>
  }
  return (
    <label className={compact ? 'flex items-center gap-2 text-sm' : 'block'}>
      <span className={compact ? 'text-gray-500' : 'label'}>{translateUi("เครื่อง POS")}</span>
      <select
        className="input w-full"
        value={setup.terminal?.terminal_code ?? ''}
        onChange={(e) => setup.chooseTerminal(e.target.value || null)}
      >
        <option value="">{translateUi("— เลือกเครื่อง —")}</option>
        {setup.terminals.map((t) => (
          <option key={t.id} value={t.terminal_code}>
            {t.terminal_code} · {t.name}
            {t.pos_reg_no ? ` (เลขอนุมัติ ${t.pos_reg_no})` : ' (ยังไม่มีเลขอนุมัติ)'}
          </option>
        ))}
      </select>
      {!compact && setup.terminal && !setup.terminal.pos_reg_no && (
        <span className="mt-1 block text-xs text-amber-700">{translateUi("เครื่องนี้ยังไม่มีเลขอนุมัติจากกรมสรรพากร ออกใบอย่างย่อ (ABB) ไม่ได้")}</span>
      )}
    </label>
  )
}
