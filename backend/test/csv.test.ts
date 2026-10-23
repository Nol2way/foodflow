import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv, parseDate, parseSales, parseTime } from '../src/csv.ts'

test('parseCsv: เครื่องหมายคำพูด จุลภาค และ CRLF', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n'), [['a', 'b'], ['x, y', 'say "hi"']])
  assert.deepEqual(parseCsv('﻿a\n1'), [['a'], ['1']])
})

test('parseDate: ISO, วัน/เดือน/ปี และปี พ.ศ.', () => {
  assert.equal(parseDate('2026-09-01'), '2026-09-01')
  assert.equal(parseDate('1/9/2026'), '2026-09-01')
  assert.equal(parseDate('01/09/2569'), '2026-09-01')
  assert.equal(parseDate('2026-02-30'), null)
  assert.equal(parseDate('hello'), null)
  assert.equal(parseTime('9:05'), '09:05:00')
  assert.equal(parseTime('18.30'), '18:30:00')
  assert.equal(parseTime('24:00'), null)
})

test('parseSales: date + time แยกคอลัมน์ หัวตารางภาษาไทย', () => {
  const { rows, errors } = parseSales('วันที่,เวลา,เลขที่บิล,เมนู,จำนวน,ราคา\n2026-09-01,12:05,B1,ข้าวผัด,2,"1,050.50"\n\n')
  assert.deepEqual(errors, [])
  assert.deepEqual(rows, [{ line: 2, ref: 'B1', at: '2026-09-01 12:05:00', item: 'ข้าวผัด', qty: 2, price: '1050.50' }])
})

test('parseSales: คอลัมน์ datetime รูปแบบ ISO', () => {
  const { rows } = parseSales('datetime,item,qty\n2026-09-01T18:30,ต้มยำ,1\n')
  assert.equal(rows[0].at, '2026-09-01 18:30:00')
  assert.equal(rows[0].price, '')
})

test('parseSales: แถวผิดรายงานเลขบรรทัด ไม่ข้ามแบบเงียบๆ', () => {
  const csv = 'datetime,item,qty,price\n2026-09-01 12:00,A,1,\n2026-13-01 12:00,B,1,\nx,,0,-5\n'
  const { rows, errors } = parseSales(csv)
  assert.equal(rows.length, 1)
  assert.equal(errors.length, 2)
  assert.equal(errors[0].line, 3)
  assert.equal(errors[1].line, 4)
  assert.match(errors[1].message, /ไม่มีชื่อเมนู/)
  assert.match(errors[1].message, /จำนวน/)
  assert.match(errors[1].message, /ราคา/)
})

test('parseSales: ขาดคอลัมน์จำเป็น', () => {
  const { errors } = parseSales('date,item\n2026-09-01,A\n')
  assert.equal(errors[0].line, 1)
  assert.match(errors[0].message, /qty/)
})

test('parseSales: ไฟล์ว่าง', () => {
  assert.equal(parseSales('').errors.length, 1)
  assert.equal(parseSales('datetime,item,qty\n').errors.length, 1)
})
