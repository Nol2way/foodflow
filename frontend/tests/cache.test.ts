import assert from 'node:assert/strict'
import { clearAll, fetchCached, invalidate, peek } from '../src/lib/cache.ts'
const deferred = () => { let resolve!: (value: string) => void; const promise = new Promise<string>((r) => { resolve = r }); return { promise, resolve } }
for (const reset of [() => invalidate('key'), clearAll]) {
  const old = deferred()
  const pending = fetchCached('key', () => old.promise)
  reset()
  old.resolve('stale')
  await pending
  assert.equal(peek('key'), undefined)
}
const old = deferred(), fresh = deferred()
const first = fetchCached('key', () => old.promise)
const second = fetchCached('key', () => fresh.promise, 0, true)
fresh.resolve('fresh'); await second
old.resolve('stale'); await first
assert.equal(peek('key'), 'fresh')
clearAll()
console.log('cache invalidation, session reset and forced refresh ordering passed')
