import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tableLayout } from '../src/lib/tableLayout.ts'
import { workCounts } from '../src/lib/workCounts.ts'

test('table layout separates duplicate coordinates and clamps invalid edges', () => {
  const tables = Array.from({ length: 30 }, (_, i) => ({ id: String(i), floor_x: i % 2 ? 0 : -100, floor_y: i % 3 ? 0 : Number.NaN }))
  const layout = tableLayout(tables)
  assert.equal(new Set(layout.map(cell => `${cell.row}:${cell.column}`)).size, tables.length)
  assert.ok(layout.every(cell => cell.column >= 1 && cell.column <= 6 && cell.row >= 1))
  assert.equal(tableLayout([{ id: 'edge', floor_x: 100, floor_y: 100 }])[0].column, 6)
})

test('work counts group table bills and preserve separate takeaway tickets', () => {
  const base = { order_type: 'dine_in', table_id: 'table-a', bill_requested_at: null }
  assert.deepEqual(workCounts([
    { ...base, id: 'new', status: 'received' },
    { ...base, id: 'ready', status: 'ready' },
    { ...base, id: 'served-a', status: 'served' },
    { ...base, id: 'served-b', status: 'served' },
    { ...base, id: 'requested', status: 'preparing', bill_requested_at: '2026-11-23' },
    { ...base, id: 'takeaway-a', status: 'served', order_type: 'takeaway' },
    { ...base, id: 'takeaway-b', status: 'served', order_type: 'takeaway' },
  ]), { '/kitchen': 1, '/serve': 1, '/counter': 3 })
  assert.deepEqual(workCounts([]), { '/kitchen': 0, '/serve': 0, '/counter': 0 })
})
