import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { has, peek, put } from './cache'
export function useCachedState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>, boolean] {
  const [snapshot, setSnapshot] = useState(() => ({ key, value: has(key) ? peek<T>(key)! : initial }))
  const current = useRef(key)
  current.current = key
  const set = useCallback<Dispatch<SetStateAction<T>>>((value) => {
    if (current.current !== key) return
    setSnapshot((previous) => {
      if (current.current !== key) return previous
      const base = previous.key === key ? previous.value : (peek<T>(key) ?? initial)
      const next = typeof value === 'function' ? (value as (p: T) => T)(base) : value
      put(key, next)
      return { key, value: next }
    })
  }, [key])
  return [snapshot.key === key ? snapshot.value : (peek<T>(key) ?? initial), set, has(key)]
}
