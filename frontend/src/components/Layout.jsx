import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import SymbolSearch from './SymbolSearch.jsx'
import { api } from '../api.js'

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: '▦' },
  { to: '/analysis', label: 'Stock Analysis', icon: '△' },
  { to: '/watchlist', label: 'Watchlist', icon: '☆' },
  { to: '/portfolio', label: 'Portfolio', icon: '◎' },
  { to: '/alerts', label: 'Alerts', icon: '⚠' },
]

export default function Layout({ children }) {
  const [triggeredCount, setTriggeredCount] = useState(0)

  useEffect(() => {
    function checkAlerts() {
      api.alerts
        .list()
        .then((alerts) => setTriggeredCount(alerts.filter((a) => a.triggered).length))
        .catch(() => {})
    }
    checkAlerts()
    const interval = setInterval(checkAlerts, 30000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span className="brand-name">Stockwise</span>
        </div>
        <nav className="nav">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
              {item.to === '/alerts' && triggeredCount > 0 && (
                <span className="nav-badge">{triggeredCount}</span>
              )}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <SymbolSearch />
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  )
}
