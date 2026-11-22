import { useEffect, useState } from 'react'
import { useText } from '../lib/preferences'

export default function Pagination({ page, pageSize, count, total, hasNext, loading = false, onPrevious, onNext, onPageSizeChange, label }: {
  page: number; pageSize: number; count: number; total?: number; hasNext: boolean; loading?: boolean;
  onPrevious: () => void; onNext: () => void; onPageSizeChange: (size: number) => void; label: string
}) {
  const t = useText()
  return <nav aria-label={label} className="pagination-bar my-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-white p-3">
    <label className="flex items-center gap-2 text-sm">{t('ต่อหน้า', 'Per page')}
      <select aria-label={`${label}: ${t('ต่อหน้า', 'Per page')}`} className="input w-20" value={pageSize} disabled={loading} onChange={e => onPageSizeChange(Number(e.target.value))}>
        {[10, 20, 50].map(size => <option key={size} value={size}>{size}</option>)}
      </select>
    </label>
    <span role="status" className="text-sm text-gray-600">{loading ? t('กำลังโหลด...', 'Loading...') : `${count ? page * pageSize + 1 : 0}-${count ? page * pageSize + count : 0}${total !== undefined ? ` / ${total}` : ''}`} {t('รายการ', 'items')}</span>
    <div className="flex items-center gap-2">
      <button type="button" className="btn btn-secondary" disabled={loading || page === 0} onClick={onPrevious}>{t('ก่อนหน้า', 'Previous')}</button>
      <span className="min-w-12 text-center text-sm" aria-current="page">{t('หน้า', 'Page')} {page + 1}</span>
      <button type="button" className="btn btn-secondary" disabled={loading || !hasNext} onClick={onNext}>{t('ถัดไป', 'Next')}</button>
    </div>
  </nav>
}

// For bounded, filtered result sets. Keep server caps and export totals explicit.
export function useLocalPagination<T>(rows: T[], resetKey: string, label: string) {
  const [index, setIndex] = useState(0)
  const [size, setSize] = useState(10)
  useEffect(() => setIndex(0), [resetKey])
  const page = Math.min(index, Math.max(0, Math.ceil(rows.length / size) - 1))
  const items = rows.slice(page * size, (page + 1) * size)
  return { items, controls: <Pagination label={label} page={page} pageSize={size} count={items.length} total={rows.length} hasNext={(page + 1) * size < rows.length}
    onPrevious={() => setIndex(page - 1)} onNext={() => setIndex(page + 1)} onPageSizeChange={n => { setSize(n); setIndex(0) }} /> }
}
