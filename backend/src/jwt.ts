// JWT แบบ HS256 ด้วย Web Crypto (ไม่ต้องพึ่งไลบรารี)
// ลงนามด้วย JWT secret ของโปรเจกต์ Supabase: PostgREST / Realtime ยอมรับโทเคนนี้ และ auth.uid() อ่านจาก sub
const enc = new TextEncoder()

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(pad)
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
}

const keyCache = new Map<string, Promise<CryptoKey>>()
function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret)
  if (!k) {
    k = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
    keyCache.set(secret, k)
  }
  return k
}

export interface Claims {
  sub: string
  email?: string
  role: string
  aud: string
  iat: number
  exp: number
  [k: string]: unknown
}

export async function signJwt(claims: Claims, secret: string): Promise<string> {
  const head = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const body = b64url(enc.encode(JSON.stringify(claims)))
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${head}.${body}`))
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`
}

// คืน claims ถ้าลายเซ็นถูก ยังไม่หมดอายุ และเป็นโทเคนผู้ใช้ (aud = authenticated) ไม่งั้นคืน null
export async function verifyJwt(token: string, secret: string, now = Date.now()): Promise<Claims | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const head = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])))
    if (head.alg !== 'HS256') return null
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`))
    if (!ok) return null
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]))) as Claims
    if (typeof claims.sub !== 'string' || claims.aud !== 'authenticated' || claims.role !== 'authenticated') return null
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null
    return claims
  } catch {
    return null
  }
}
