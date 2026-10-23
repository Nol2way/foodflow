// จำกัดความถี่การเรียก (ใช้กับ AI ต่อผู้ใช้)
import type { RateLimiter } from './env.ts'

// ใช้ Cloudflare Rate Limiting binding ถ้าผูกไว้ (นับรวมทุกเครื่อง แม่นกว่า)
// ถ้าไม่ได้ผูก ใช้ตัวนับในหน่วยความจำของ Worker แต่ละตัวแทน (best effort)
const memory = new Map<string, number[]>()
export const WINDOW_MS = 60_000

export async function allow(
  binding: RateLimiter | undefined,
  key: string,
  perMinute: number,
  now = Date.now(),
): Promise<boolean> {
  if (binding) return (await binding.limit({ key })).success
  const hits = (memory.get(key) ?? []).filter((t) => now - t < WINDOW_MS)
  const ok = hits.length < perMinute
  if (ok) hits.push(now)
  memory.set(key, hits)
  if (memory.size > 10_000) memory.clear() // กันหน่วยความจำโต
  return ok
}

export function resetMemoryLimiter() {
  memory.clear()
}
