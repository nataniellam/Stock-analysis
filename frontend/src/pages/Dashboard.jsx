import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.js'

export default function Dashboard() {
  const navigate = useNavigate()
  const [quotes, setQuotes] = useState([])
  const [portfolioSummary, setPortfolioSummary] = useState(null)
  const [alerts, setAlerts] = useState(null)

  useEffect(() => {
    api.watchlist
      .list()
      .then((symbols) => (symbols.length ? api.quotes(symbols) : []))
      .then(setQuotes)
      .catch(() => setQuotes([]))

    api.portfolio
      .list()
      .then(async (holdings) => {
        if (holdings.length === 0) return setPortfolioSummary({ count: 0 })
        const symbols = [...new Set(holdings.map((h) => h.symbol))]
        const qs = await api.quotes(symbols)
        const bySymbol = Object.fromEntries(qs.map((q) => [q.symbol, q]))
        const totalValue = holdings.reduce((sum, h) => sum + (bySymbol[h.symbol]?.regularMarketPrice ?? 0) * h.shares, 0)
        const totalCost = holdings.reduce((sum, h) => sum + h.costBasis * h.shares, 0)
        const totalGain = totalValue - totalCost
        const totalGainPct = totalCost !== 0 ? (totalGain / totalCost) * 100 : 0
        setPortfolioSummary({ count: holdings.length, totalValue, totalGain, totalGainPct })
      })
      .catch(() => setPortfolioSummary(null))

    api.alerts
      .list()
      .then((list) => setAlerts({ total: list.length, triggered: list.filter((a) => a.triggered).length }))
      .catch(() => setAlerts(null))
  }, [])

  return (
    <div className="page">
      <h1>Dashboard</h1>
      <p className="muted">Your starting point across analysis, watchlist, portfolio, and alerts.</p>

      <div className="dash-grid">
        <div className="card">
          <h3>Watchlist snapshot</h3>
          {quotes.length === 0 ? (
            <p className="muted">
              No symbols yet.{' '}
              <a className="link" onClick={() => navigate('/watchlist')}>
                Build your watchlist
              </a>
            </p>
          ) : (
            <ul className="mini-list">
              {quotes.slice(0, 5).map((q) => {
                const positive = q.regularMarketChange >= 0
                return (
                  <li key={q.symbol} onClick={() => navigate(`/analysis/${q.symbol}`)}>
                    <span className="mono">{q.symbol}</span>
                    <span>${q.regularMarketPrice?.toFixed(2)}</span>
                    <span className={positive ? 'up' : 'down'}>
                      {positive ? '+' : ''}
                      {q.regularMarketChangePercent?.toFixed(2)}%
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="card">
          <h3>Portfolio</h3>
          {!portfolioSummary || portfolioSummary.count === 0 ? (
            <p className="muted">
              No holdings yet.{' '}
              <a className="link" onClick={() => navigate('/portfolio')}>
                Add your first position
              </a>
            </p>
          ) : (
            <div onClick={() => navigate('/portfolio')} style={{ cursor: 'pointer' }}>
              <div className="price" style={{ fontSize: 22 }}>
                ${portfolioSummary.totalValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </div>
              <span className={portfolioSummary.totalGain >= 0 ? 'up' : 'down'}>
                {portfolioSummary.totalGain >= 0 ? '+' : ''}
                ${portfolioSummary.totalGain.toLocaleString(undefined, { maximumFractionDigits: 2 })} (
                {portfolioSummary.totalGainPct.toFixed(2)}%)
              </span>
            </div>
          )}
        </div>

        <div className="card">
          <h3>Alerts</h3>
          {!alerts || alerts.total === 0 ? (
            <p className="muted">
              No alerts yet.{' '}
              <a className="link" onClick={() => navigate('/alerts')}>
                Create one
              </a>
            </p>
          ) : (
            <div onClick={() => navigate('/alerts')} style={{ cursor: 'pointer' }}>
              {alerts.triggered > 0 ? (
                <>
                  <div className="price up" style={{ fontSize: 22 }}>
                    {alerts.triggered} triggered
                  </div>
                  <span className="muted">of {alerts.total} total</span>
                </>
              ) : (
                <>
                  <div className="price" style={{ fontSize: 22 }}>
                    {alerts.total}
                  </div>
                  <span className="muted">watching, none triggered</span>
                </>
              )}
            </div>
          )}
        </div>

        <div className="card">
          <h3>Quick Analysis</h3>
          <p className="muted">Search any ticker above, or jump into a popular name:</p>
          <div className="quick-picks">
            {['AAPL', 'MSFT', 'NVDA', 'TSLA'].map((s) => (
              <button key={s} className="chip" onClick={() => navigate(`/analysis/${s}`)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
