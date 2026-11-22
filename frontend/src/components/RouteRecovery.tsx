import { translateUi } from "../lib/uiText"
import { Component, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (!this.state.failed) return this.props.children
    return <main className="page-narrow"><div role="alert" className="card"><h1 className="page-title">{translateUi("เปิดหน้านี้ไม่ได้")}</h1><p>{translateUi("ตรวจการเชื่อมต่อแล้วลองโหลดหน้าใหม่")}</p><button className="btn btn-primary" onClick={() => window.location.reload()}>{translateUi("ลองใหม่")}</button><Link className="btn btn-secondary" to="/">{translateUi("กลับหน้าแรก")}</Link></div></main>
  }
}
export default function RouteRecovery({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  return <Boundary key={pathname}>{children}</Boundary>
}
