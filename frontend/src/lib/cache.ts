// แคชข้อมูลกลางของแอป (stale-while-revalidate)
// เปลี่ยนหน้าแล้วกลับมา: แสดงข้อมูลเดิมทันที แล้วค่อยโหลดใหม่เงียบ ๆ อยู่เบื้องหลัง
// คำขอเดียวกันที่ยิงซ้อนกัน (หลายคอมโพเนนต์/หลายหน้า) จะใช้คำขอเดียว

interface Entry {
  data?: unknown
  at: number // เวลาที่ได้ข้อมูลล่าสุด (ms) · 0 = ยังไม่มี
  inflight?: Promise<unknown>
}

const store = new Map<string, Entry>()
const MAX_ENTRIES = 200

export function peek<T>(key: string): T | undefined {
  return store.get(key)?.data as T | undefined
}

export function has(key: string): boolean {
  return (store.get(key)?.at ?? 0) > 0
}

export function put<T>(key: string, data: T) {
  const e: Entry = { at: 0 }
  e.data = data
  e.at = Date.now()
  store.delete(key) // ย้ายไปท้าย (ใช้ล่าสุด)
  store.set(key, e)
  if (store.size > MAX_ENTRIES) store.delete(store.keys().next().value as string)
}

// ดึงข้อมูลผ่านแคช · maxAge > 0 และข้อมูลยังใหม่ = ไม่ยิงคำขอ · มีคำขอค้างอยู่ = ใช้ตัวเดิม
// force = ยิงใหม่เสมอ (เช่น หลังบันทึก ต้องได้ข้อมูลล่าสุด ไม่ใช่คำขอที่ค้างจากก่อนบันทึก)
export function fetchCached<T>(key: string, load: () => Promise<T>, maxAge = 0, force = false): Promise<T> {
  const e = store.get(key)
  if (!force && e && e.at > 0 && maxAge > 0 && Date.now() - e.at < maxAge) return Promise.resolve(e.data as T)
  if (!force && e?.inflight) return e.inflight as Promise<T>
  const entry = e ?? { at: 0 }
  const p: Promise<T> = load().then(
    (data) => {
      if (store.get(key) !== entry || entry.inflight !== p) return data // มีคำขอใหม่กว่าแทนแล้ว: ไม่เขียนทับด้วยผลเก่า
      entry.inflight = undefined
      put(key, data)
      return data
    },
    (err) => {
      if (entry.inflight === p) entry.inflight = undefined
      throw err
    },
  )
  entry.inflight = p
  if (!e) store.set(key, entry)
  return p
}

// ลบแคชที่ขึ้นต้นด้วย prefix (ว่าง = ทั้งหมด) เช่น หลังบันทึกข้อมูล
export function invalidate(prefix = '') {
  for (const [k] of store) {
    if (!k.startsWith(prefix)) continue
    store.delete(k)
  }
}

// ออกจากระบบ/เปลี่ยนผู้ใช้: ล้างทุกอย่าง (กันข้อมูลร้านหนึ่งโผล่ในอีกบัญชี)
export function clearAll() {
  store.clear()
}
