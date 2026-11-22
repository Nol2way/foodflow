// ตัวโหลดโค้ดของแต่ละหน้า (แยก chunk) · ใช้ทั้งใน App (lazy) และโหลดล่วงหน้าเบื้องหลัง
export const pageLoaders = {
  '/': () => import('./Home'),
  '/pos': () => import('./Pos'),
  '/tables': () => import('./TableMap'),
  '/bills': () => import('./Bills'),
  '/kitchen': () => import('./Kitchen'),
  '/counter': () => import('./Counter'),
  '/serve': () => import('./Serve'),
  '/accounting': () => import('./Accounting'),
  '/stock': () => import('./Stock'),
  '/login': () => import('./Login'),
  '/import': () => import('./Import'),
  '/staff': () => import('./Staff'),
  '/set-password': () => import('./SetPassword'),
  '/menu': () => import('./MenuAdmin'),
  '/promotions': () => import('./Promotions'),
  '/display': () => import('./Display'),
  '/settings': () => import('./Settings'),
  '/members': () => import('./Members'),
  '/privacy': () => import('./Privacy'),
  '/audit': () => import('./Audit'),
  '/report': () => import('./Report'),
  '/stock-history': () => import('./StockHistory'),
  '/stock-count': () => import('./StockCount'),
  '/stock-receive': () => import('./StockReceive'),
  '/stock-variance': () => import('./StockVariance'),
  '/stock-yield': () => import('./StockYield'),
  '/stock-setup': () => import('./StockSetup'),
} as const

export type PagePath = keyof typeof pageLoaders

const started = new Set<string>()

// โหลดโค้ดหน้าที่ผู้ใช้เข้าได้ไว้ก่อน ตอนเบราว์เซอร์ว่าง (ทีละหน้า ไม่แย่งเน็ตกับงานจริง)
// กดเปลี่ยนหน้าแล้วจึงไม่ต้องรอดาวน์โหลดโค้ด
export function preloadPages(paths: string[]) {
  const queue = paths.filter((p): p is PagePath => p in pageLoaders && !started.has(p))
  if (queue.length === 0) return
  const idle: (cb: () => void) => void =
    typeof window !== 'undefined' && 'requestIdleCallback' in window
      ? (cb) => window.requestIdleCallback(cb, { timeout: 3000 })
      : (cb) => setTimeout(cb, 300)
  const next = () => {
    const p = queue.shift()
    if (!p) return
    if (started.has(p)) return next()
    started.add(p)
    pageLoaders[p]()
      .catch(() => started.delete(p)) // เน็ตหลุด: ไว้ลองใหม่ครั้งหน้า
      .finally(() => idle(next))
  }
  idle(next)
}

// โหลดหน้าเดียวทันที (เช่น ตอนชี้/แตะลิงก์)
export function preloadPage(path: string) {
  if (!(path in pageLoaders) || started.has(path)) return
  started.add(path)
  pageLoaders[path as PagePath]().catch(() => started.delete(path))
}
