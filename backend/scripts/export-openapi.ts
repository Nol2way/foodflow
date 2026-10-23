// ส่งออก OpenAPI เป็นไฟล์ docs/openapi.json (ใช้เปิดใน Swagger Editor / Postman โดยไม่ต้องรัน backend)
import { writeFileSync } from 'node:fs'
import { openapi } from '../src/openapi.ts'

const out = new URL('../../docs/openapi.json', import.meta.url)
writeFileSync(out, JSON.stringify(openapi, null, 2) + '\n')
console.log('wrote', out.pathname)
