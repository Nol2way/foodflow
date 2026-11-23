import Swal from 'sweetalert2'
import 'sweetalert2/dist/sweetalert2.min.css'
import { translateUi } from './uiText'

let confirming = false

function options() {
  // A nested alert must stay inside the active native dialog's top layer.
  return {
    target: document.querySelector<HTMLDialogElement>('dialog[open]:last-of-type') ?? document.body,
    buttonsStyling: false,
    heightAuto: false,
    customClass: { popup: 'plato-alert', confirmButton: 'btn btn-primary', cancelButton: 'btn btn-secondary', actions: 'plato-alert-actions' },
    showClass: { popup: '' }, hideClass: { popup: '' },
  }
}

export async function confirmAction(text: string, confirmText = translateUi('ยืนยัน')) {
  if (confirming) return false
  confirming = true
  try {
    const result = await Swal.fire({
      ...options(), titleText: translateUi('ยืนยันรายการ'), text, icon: 'warning',
      showCancelButton: true, confirmButtonText: confirmText, cancelButtonText: translateUi('ยกเลิก'),
      focusCancel: true, returnFocus: true,
    })
    return result.isConfirmed
  } finally { confirming = false }
}

export async function showAlert(text: string, success = true) {
  await Swal.fire({ ...options(), titleText: translateUi(success ? 'สำเร็จ' : 'เกิดข้อผิดพลาด'), text, icon: success ? 'success' : 'error', confirmButtonText: translateUi('ตกลง'), returnFocus: true })
}
