// npm run share — รัน backend + หน้าเว็บในเครื่อง แล้วสร้างลิงก์สาธารณะชั่วคราว (https://xxxx.trycloudflare.com)
// ใครมีลิงก์ก็เปิดได้จากที่ไหนก็ได้ (มือถือ iPad เครื่องอื่น) · ได้ลิงก์ใหม่ทุกครั้งที่รัน · กด Ctrl+C = ปิดทั้งหมด ลิงก์หายทันที
// ต้องติดตั้ง cloudflared ก่อน: winget install Cloudflare.cloudflared
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import net from 'node:net'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// เปิด npm run dev ค้างไว้อยู่แล้วก็ไม่ชนกัน: หาพอร์ตว่างเอง
async function freePort(start) {
  const busy = (port, host) =>
    new Promise((resolve) => {
      const srv = net.createServer().once('error', () => resolve(true)).once('listening', () => srv.close(() => resolve(false)))
      srv.listen(port, host)
    })
  for (let p = start; p < start + 100; p++) {
    if (!(await busy(p, '127.0.0.1')) && !(await busy(p, '::1').catch(() => false))) return p
  }
  throw new Error(`ไม่มีพอร์ตว่างช่วง ${start}-${start + 99}`)
}
const API_PORT = await freePort(Number(process.env.API_PORT ?? 8788))
const WEB_PORT = await freePort(Number(process.env.WEB_PORT ?? 5174))
const isWin = process.platform === 'win32'
const children = []

const log = (tag, color) => (buf) => {
  for (const line of String(buf).split(/\r?\n/)) if (line.trim()) console.log(`\x1b[${color}m[${tag}]\x1b[0m ${line}`)
}

function run(tag, color, cmd, args, opts = {}) {
  // คำสั่งเป็นข้อความเดียว (ไม่มีค่าจากผู้ใช้) · Windows ต้องผ่าน shell เพื่อหา npm.cmd
  const child = isWin
    ? spawn([cmd, ...args].join(' '), { cwd: opts.cwd ?? root, shell: true, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(cmd, args, { cwd: opts.cwd ?? root, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  if (!opts.quiet) {
    child.stdout.on('data', log(tag, color))
    child.stderr.on('data', log(tag, color))
  }
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`\n[${tag}] หยุดทำงาน (code ${code}) — ปิดทั้งหมด`)
      stop(1)
    }
  })
  children.push(child)
  return child
}

let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const c of children) {
    if (c.exitCode !== null || !c.pid) continue
    // Windows: ต้องฆ่าทั้งต้นไม้ของโปรเซส (npm → node → workerd)
    if (isWin) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
    else c.kill('SIGTERM')
  }
  process.exit(code)
}
process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

async function waitFor(url, label, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      await fetch(url)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error(`${label} ไม่ขึ้นภายใน ${timeoutMs / 1000} วินาที`)
}

// มี cloudflared ไหม
const check = spawnSync('cloudflared --version', { shell: true, encoding: 'utf8' })
if (check.status !== 0) {
  console.error('ไม่พบ cloudflared — ติดตั้งก่อน: winget install Cloudflare.cloudflared (แล้วเปิด terminal ใหม่)')
  process.exit(1)
}

console.log('กำลังเปิด backend และหน้าเว็บ...')
// รันในโฟลเดอร์ backend + ระบุ -c: ใช้ backend/wrangler.toml + backend/.dev.vars
// (ไม่ระบุ wrangler จะไปเจอ wrangler.jsonc ของเว็บจริงที่รากก่อน)
run('api', '35', 'npx', ['wrangler', 'dev', '-c', 'wrangler.toml', '--port', String(API_PORT)], { quiet: true, cwd: path.join(root, 'backend') })
// VITE_API_URL ว่าง = หน้าเว็บเรียก /api โดเมนเดียวกัน แล้ว Vite ส่งต่อให้ backend (คนที่เปิดผ่านลิงก์จึงใช้ API ได้)
run('web', '36', 'npm', ['--prefix', 'frontend', 'run', 'dev', '--', '--port', String(WEB_PORT), '--strictPort'], {
  quiet: true,
  env: { VITE_API_URL: '', API_PROXY_TARGET: `http://localhost:${API_PORT}` },
})

try {
  await Promise.all([waitFor(`http://localhost:${API_PORT}/api/openapi.json`, 'backend'), waitFor(`http://localhost:${WEB_PORT}/`, 'หน้าเว็บ')])
} catch (e) {
  console.error(String(e.message ?? e))
  stop(1)
}
console.log('backend และหน้าเว็บพร้อมแล้ว กำลังสร้างลิงก์สาธารณะ...')

const tunnel = run('tunnel', '33', 'cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${WEB_PORT}`], { quiet: true })
let shown = false
const onTunnel = async (buf) => {
  const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
  if (!m || shown) return
  shown = true
  const url = m[0]
  // รอ DNS ของลิงก์ใหม่พร้อม (ปกติไม่กี่วินาที)
  await waitFor(url, 'ลิงก์', 60_000).catch(() => {})
  let qr = ''
  try {
    const QR = createRequire(path.join(root, 'frontend', 'package.json'))('qrcode')
    qr = await QR.toString(url, { type: 'terminal', small: true })
  } catch {
    // ไม่มี qrcode: แสดงแค่ลิงก์
  }
  const line = '═'.repeat(url.length + 4)
  console.log(`\n\x1b[32m╔${line}╗\n║  ${url}  ║\n╚${line}╝\x1b[0m`)
  console.log(`ลิงก์สาธารณะชั่วคราว: เปิดได้จากทุกที่ · ในเครื่องนี้: http://localhost:${WEB_PORT}`)
  if (qr) console.log('\nสแกนเปิดบนมือถือ/iPad:\n' + qr)
  console.log('กด Ctrl+C เพื่อปิด (ลิงก์จะใช้ไม่ได้ทันที · รันใหม่ได้ลิงก์ใหม่)\n')
}
tunnel.stdout.on('data', onTunnel)
tunnel.stderr.on('data', onTunnel)
