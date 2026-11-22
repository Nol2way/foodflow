import { useSyncExternalStore } from 'react'

export type Language = 'th' | 'en'
export type Theme = 'light' | 'dark' | 'system'
type Preferences = { language: Language; theme: Theme }
const KEY = 'plato.preferences'
const listeners = new Set<() => void>()
function read(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return { language: value.language === 'en' ? 'en' : 'th', theme: ['light', 'dark', 'system'].includes(value.theme) ? value.theme : 'system' }
  } catch { return { language: 'th', theme: 'system' } }
}
let current = read()
export const getLanguage = () => current.language
const media = window.matchMedia('(prefers-color-scheme: dark)')
function apply() {
  document.documentElement.lang = current.language
  document.documentElement.classList.toggle('dark', current.theme === 'dark' || (current.theme === 'system' && media.matches))
}
apply()
media.addEventListener('change', apply)
window.addEventListener('storage', event => {
  if (event.key === KEY) { current = read(); apply(); listeners.forEach(fn => fn()) }
})
export function setPreferences(patch: Partial<Preferences>) {
  current = { ...current, ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(current)) } catch { /* usable in memory */ }
  apply(); listeners.forEach(fn => fn())
}
export function usePreferences() {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback) } }, () => current)
}
export function useText() {
  const { language } = usePreferences()
  return (thai: string, english: string) => language === 'en' ? english : thai
}
