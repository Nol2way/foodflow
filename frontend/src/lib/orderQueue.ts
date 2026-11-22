import { supabase } from './supabase'
import { getSession } from './session'

export interface QueuedOrder {
  id: string
  userId: string
  restaurantId: string
  payload: Record<string, unknown>
  createdAt: string
  error?: string
}
const EVENT = 'plato:order-queue'
let opening: Promise<IDBDatabase> | undefined
function db() {
  return opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('plato-order-queue', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('orders', { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { opening = undefined; reject(request.error) }
  })
}
async function write(value: QueuedOrder | string) {
  const database = await db()
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('orders', 'readwrite')
    const store = tx.objectStore('orders')
    if (typeof value === 'string') store.delete(value)
    else store.put(value)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('queue_aborted'))
  })
  window.dispatchEvent(new Event(EVENT))
}
export async function queuedOrders(userId: string, restaurantId: string): Promise<QueuedOrder[]> {
  const database = await db()
  return new Promise((resolve, reject) => {
    const request = database.transaction('orders').objectStore('orders').getAll()
    request.onsuccess = () => resolve((request.result as QueuedOrder[]).filter(row => row.userId === userId && row.restaurantId === restaurantId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    request.onerror = () => reject(request.error)
  })
}
export async function queueOrder(userId: string, restaurantId: string, payload: Record<string, unknown>, id = crypto.randomUUID()) {
  if (getSession()?.user.id !== userId) throw new Error('session_changed')
  const row: QueuedOrder = { id, userId, restaurantId, payload: { ...payload, p_restaurant_id: restaurantId, p_client_ref: id }, createdAt: new Date().toISOString() }
  await write(row)
  return row
}
const sending = new Set<string>()
export async function sendQueuedOrder(row: QueuedOrder): Promise<string> {
  if (sending.has(row.id)) throw new Error('already_sending')
  if (getSession()?.user.id !== row.userId) throw new Error('session_changed')
  sending.add(row.id)
  try {
    const { data, error } = await supabase.rpc('staff_place_order', row.payload)
    if (error) throw new Error(error.message)
    // The durable client_ref makes a retry safe even if acknowledgement/deletion fails.
    await write(row.id)
    return String(data)
  } catch (error) {
    await write({ ...row, error: error instanceof Error ? error.message : 'send_failed' })
    throw error
  } finally { sending.delete(row.id) }
}
export const removeQueuedOrder = (id: string) => write(id)
export function onQueueChange(callback: () => void) {
  window.addEventListener(EVENT, callback)
  return () => window.removeEventListener(EVENT, callback)
}
