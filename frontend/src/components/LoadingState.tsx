import { useText } from '../lib/preferences'

// Use only while a request is pending. Errors and empty results have their own UI.
export default function LoadingState({ label, rows = 6 }: { label?: string; rows?: number }) {
  const t = useText()
  return <section role="status" aria-busy="true" aria-label={label ?? t('กำลังโหลดข้อมูล', 'Loading data')} className="space-y-4 py-4">
    <span className="sr-only">{label ?? t('กำลังโหลดข้อมูล', 'Loading data')}</span>
    <div aria-hidden="true" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="card space-y-4 p-4">
        <div className="skeleton-block h-5 w-2/3" />
        <div className="skeleton-block h-4 w-1/2" />
        <div className="skeleton-block h-9 w-full" />
      </div>)}
    </div>
  </section>
}
