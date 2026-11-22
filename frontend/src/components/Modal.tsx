import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
let openDialogs = 0
let previousOverflow = ''
export default function Modal({ children, label, onClose, busy = false, className = 'max-w-sm p-4' }: { children: ReactNode; label: string; onClose: () => void; busy?: boolean; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null)
  const returnFocus = useRef(document.activeElement as HTMLElement | null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const previous = returnFocus.current
    const dialog = ref.current!
    if (openDialogs++ === 0) { previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden' }
    dialog.showModal()
    dialog.querySelector<HTMLElement>('[autofocus], input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled])')?.focus({ preventScroll: true })
    return () => { dialog.close(); if (--openDialogs === 0) document.body.style.overflow = previousOverflow; if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  return createPortal(<dialog ref={ref} aria-label={label} aria-modal="true" aria-busy={busy || undefined}
    onCancel={(e) => { e.preventDefault(); e.stopPropagation(); if (!busy) close.current() }}
    onKeyDown={(e) => {
      if (e.key !== 'Tab') return
      const dialog = ref.current!
      const controls = [...dialog.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex]')].filter((el) => !el.matches(':disabled, [tabindex="-1"]') && el.getClientRects().length > 0)
      const first = controls[0], last = controls.at(-1)
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      e.stopPropagation()
    }}
    onSubmit={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
    className={`app-dialog fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto overscroll-contain rounded-2xl border-0 bg-white text-gray-900 shadow-2xl backdrop:bg-black/50 ${className}`}>{children}</dialog>, document.body)
}
