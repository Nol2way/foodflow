import { supabase } from './supabase'

// รูป/วิดีโอเมนูเก็บใน Supabase Storage bucket 'menu-media' (อ่านได้สาธารณะ) · ดู 0013, 0014
export const MEDIA_BUCKET = 'menu-media'
export const MEDIA_MAX_MB = 50

export function mediaUrl(path: string): string {
  return supabase.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl
}

// ที่อยู่ไฟล์จริงของสื่อ: ไฟล์ที่อัปโหลด หรือ ลิงก์ภายนอก
export function mediaSrc(m: { path: string | null; url: string | null }): string {
  return m.path ? mediaUrl(m.path) : (m.url ?? '')
}

export function mediaTypeOf(file: File): 'image' | 'video' | null {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  return null
}
