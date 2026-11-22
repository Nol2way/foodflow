import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { offlineShell } from '../pwa-plugin.ts'

const emitted: { source: string }[] = []
const plugin = offlineShell()
const generate = plugin.generateBundle as Function
generate.call({ emitFile: (asset: { source: string }) => emitted.push(asset) }, {}, { 'index.html': {}, 'assets/app.js': {}, 'assets/app.css': {} })
const listeners = new Map<string, Function>()
let installed: string[] = [], matched = '', intercepted = false
const deleted: string[] = []
const cache = {
  addAll: async (paths: string[]) => { assert.equal(new Set(paths).size, paths.length, 'Cache.addAll rejects duplicate URLs'); installed = paths },
  match: async (request: string | { url: string }) => { matched = typeof request === 'string' ? request : request.url; return { shell: true } },
}
runInNewContext(emitted[0].source, {
  URL,
  self: { location: { origin: 'https://shop.test' }, addEventListener: (name: string, handler: Function) => listeners.set(name, handler) },
  caches: { open: async () => cache, keys: async () => ['foodflow-shell-old', 'unrelated'], delete: async (key: string) => { deleted.push(key); return true } },
  fetch: async () => { throw new Error('offline') },
})
let pending: Promise<unknown> = Promise.resolve()
listeners.get('install')!({ waitUntil: (promise: Promise<unknown>) => { pending = promise } })
await pending
assert.ok(installed.includes('/index.html'))
assert.ok(installed.includes('/assets/app.js'))
listeners.get('activate')!({ waitUntil: (promise: Promise<unknown>) => { pending = promise } })
await pending
assert.deepEqual(deleted, ['foodflow-shell-old'])
function request(path: string, method = 'GET', auth = false, mode = 'cors') {
  intercepted = false
  listeners.get('fetch')!({ request: { url: `https://shop.test${path}`, method, mode, headers: { has: () => auth } }, respondWith: (promise: Promise<unknown>) => { intercepted = true; pending = promise } })
}
request('/api/orders'); assert.equal(intercepted, false)
request('/assets/app.js', 'GET', true); assert.equal(intercepted, false)
request('/api/orders', 'POST'); assert.equal(intercepted, false)
request('/pos', 'GET', false, 'navigate'); assert.equal(intercepted, true)
await pending
assert.equal(matched, '/index.html')
console.log('PWA installs unique assets, preserves unrelated caches and never caches authenticated/API traffic')
