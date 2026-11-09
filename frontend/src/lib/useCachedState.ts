import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { has, peek, put } from './cache'

// ใช้แทน useState สำหรับ "ข้อมูลที่โหลดมาจากฐานข้อมูล" ของหน้า
// ค่าถูกจำไว้ในแคชกลาง: ออกจากหน้าแล้วกลับมา เห็นข้อมูลล่าสุดทันที (ไม่ว่างเปล่ารอโหลด)
// หน้ายังโหลดใหม่ตามปกติ แล้วค่าใหม่จะแทนที่เอง · key ต้องไม่ซ้ำกัน (ใส่ restaurantId ด้วย)
export function useCachedState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>, boolean] {
  const [value, setValue] = useState<T>(() => (has(key) ? (peek<T>(key) as T) : initial))
  const keyRef = useRef(key)
  const initialRef = useRef(initial)

  // key เปลี่ยน (เช่น เปลี่ยนวันที่ในรายงาน): ใช้ค่าที่จำไว้ของ key ใหม่ ถ้าไม่มีใช้ค่าเริ่มต้น
  useEffect(() => {
    if (keyRef.current === key) return
    keyRef.current = key
    setValue(has(key) ? (peek<T>(key) as T) : initialRef.current)
  }, [key])

  const set = useCallback<Dispatch<SetStateAction<T>>>((v) => {
    setValue((prev) => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v
      put(keyRef.current, next)
      return next
    })
  }, [])

  return [value, set, has(key)]
}
