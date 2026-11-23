import type { OrderStatus } from './types'

export type WorkOrder = { id: string; status: OrderStatus; order_type: string; table_id: string | null; bill_requested_at: string | null }

export function workCounts(orders: WorkOrder[]) {
  const bills = new Set(orders.filter(order => order.bill_requested_at || order.status === 'served').map(order => order.order_type === 'dine_in' && order.table_id ? order.table_id : order.id))
  return { '/kitchen': orders.filter(order => order.status === 'received').length, '/serve': orders.filter(order => order.status === 'ready').length, '/counter': bills.size }
}
