import { translateUi } from "../lib/uiText"
import { setPreferences, usePreferences, useText, type Language, type Theme } from '../lib/preferences'

export default function AppearanceSettings() {
  const preferences = usePreferences()
  const text = useText()
  return <section className="card mb-5 space-y-3">
    <h2 className="section-title">{text('หน้าตาและภาษา', 'Appearance and language')}</h2>
    <label className="flex items-center justify-between gap-3">{text('ธีม', 'Theme')}
      <select className="input" value={preferences.theme} onChange={event => setPreferences({ theme: event.target.value as Theme })}>
        <option value="system">{text('ตามเครื่อง', 'System')}</option><option value="light">{text('สว่าง', 'Light')}</option><option value="dark">{text('มืด', 'Dark')}</option>
      </select>
    </label>
    <label className="flex items-center justify-between gap-3">{text('ภาษา', 'Language')}
      <select className="input" value={preferences.language} onChange={event => setPreferences({ language: event.target.value as Language })}>
        <option value="th">{translateUi("ไทย")}</option><option value="en">English</option>
      </select>
    </label>
  </section>
}
