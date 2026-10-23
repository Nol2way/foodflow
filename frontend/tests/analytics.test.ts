import assert from 'node:assert/strict'
import {
  buildInsights, classifyHours, forecastForDay, hourTotals, toRanges, weekdayCounts,
  type HourRow,
} from '../src/lib/analytics.ts'

let passed = 0
const t = (name: string, fn: () => void) => { fn(); passed++; console.log('PASS', name) }

const totals = Array<number>(24).fill(0)
Object.assign(totals, { 10: 40, 11: 100, 12: 100, 13: 100, 14: 40, 15: 10, 16: 10, 17: 40, 18: 90, 19: 90, 20: 90, 21: 40 })

t('classifyHours: พีค/ออฟพีค/ปกติ/ไม่มีข้อมูล', () => {
  const lv = classifyHours(totals)
  assert.deepEqual([11, 12, 13, 18, 19, 20].map((h) => lv[h]), Array(6).fill('peak'))
  assert.deepEqual([15, 16].map((h) => lv[h]), ['off', 'off'])
  assert.deepEqual([10, 14, 17, 21].map((h) => lv[h]), Array(4).fill('normal'))
  assert.equal(lv[3], 'none')
})
t('classifyHours: ไม่มีข้อมูลเลย', () => {
  assert.ok(classifyHours(Array(24).fill(0)).every((l) => l === 'none'))
})
t('toRanges: รวมชั่วโมงติดกัน', () => {
  assert.deepEqual(toRanges([11, 12, 13, 18, 19, 20]), ['11:00–14:00', '18:00–21:00'])
  assert.deepEqual(toRanges([5]), ['05:00–06:00'])
  assert.deepEqual(toRanges([]), [])
  assert.deepEqual(toRanges([20, 11, 12]), ['11:00–13:00', '20:00–21:00'])
})
t('weekdayCounts: 28 วัน = วันละ 4 ครั้ง, 10 วันรวม 10', () => {
  const today = new Date(2026, 9, 22)
  assert.deepEqual(weekdayCounts(28, today), Array(7).fill(4))
  assert.equal(weekdayCounts(10, today).reduce((a, b) => a + b, 0), 10)
})

const rows: HourRow[] = []
for (const [dow, mult] of [[1, 1], [6, 2]] as const) {
  totals.forEach((n, h) => { if (n > 0) rows.push({ day_of_week: dow, hour_of_day: h, order_count: n * mult, revenue_total: 0 }) })
}
t('hourTotals: รวมทุกวัน', () => {
  assert.equal(hourTotals(rows)[12], 100 + 200)
})
t('forecastForDay: เฉลี่ยต่อวันเดียวกัน', () => {
  const today = new Date(2026, 9, 22)
  const f = forecastForDay(
    [{ day_of_week: 1, hour_of_day: 12, order_count: 12, revenue_total: 0 }], 1, 28, today)
  assert.equal(f.hours[12], 3)
  assert.equal(f.samples, 4)
  assert.equal(f.enough, true)
  assert.equal(forecastForDay([], 1, 7, today).enough, false)
})
t('buildInsights: ข้อความพีค ช่วงเงียบ วันคึกคัก', () => {
  const text = buildInsights({ rows }).join('\n')
  assert.match(text, /ช่วงพีค 11:00–14:00, 18:00–21:00/)
  assert.match(text, /ช่วงเงียบ 15:00–17:00/)
  assert.match(text, /มากที่สุดคือวันเสาร์ และน้อยที่สุดคือวันจันทร์/)
  assert.deepEqual(buildInsights({ rows: [] }), [])
})
console.log(`\nผ่าน ${passed} ชุดทดสอบ`)
