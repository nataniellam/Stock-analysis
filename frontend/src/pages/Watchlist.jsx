import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.js'

export default function Watchlist() {
  const [quotes, setQuotes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const navigate = useNavigate()

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const symbols = await api.watchlist.list()
      if (symbols.length === 0) {
        setQuotes([])
        return
      }
      const data = await api.quotes(symbols)
      setQuotes(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const interval = setInterval(load, 30000)
    return () => clearInterval(interval)
  }, [])

  async function remove(symbol) {
    await api.watchlist.remove(symbol)
    setQuotes((prev) => prev.filter((q) => q.symbol !== symbol))
  }

  return (
    <div className="page">
      <h1>Watchlist</h1>
      <p className="muted">Live quotes refresh every 30 seconds.</p>

      {loading && quotes.length === 0 && <p className="muted">Loading...</p>}
      {error && <p className="error">{error}</p>}
      {!loading && quotes.length === 0 && !error && (
        <div className="empty-state">
          <p>Your watchlist is empty.</p>
          <button className="btn btn-primary" onClick={() => navigate('/analysis')}>
            Find a stock to add
          </button>
        </div>
      )}

      {quotes.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Name</th>
              <th>Price</th>
              <th>Change</th>
              <th>% Change</th>
              <th>Volume</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {quotes.map((q) => {
              const positive = q.regularMarketChange >= 0
              return (
                <tr key={q.symbol} className="table-row-clickable" onClick={() => navigate(`/analysis/${q.symbol}`)}>
                  <td className="mono">{q.symbol}</td>
                  <td>{q.shortName}</td>
                  <td>${q.regularMarketPrice?.toFixed(2)}</td>
                  <td className={positive ? 'up' : 'down'}>
                    {positive ? '+' : ''}
                    {q.regularMarketChange?.toFixed(2)}
                  </td>
                  <td className={positive ? 'up' : 'down'}>
                    {positive ? '+' : ''}
                    {q.regularMarketChangePercent?.toFixed(2)}%
                  </td>
                  <td>{q.regularMarketVolume?.toLocaleString()}</td>
                  <td>
                    <button
                      className="btn-icon"
                      onClick={(e) => {
                        e.stopPropagation()
                        remove(q.symbol)
                      }}
                      title="Remove from watchlist"
                    >
                      &times;
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
