import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts'
import { api } from '../api.js'

const COLORS = ['#58a6ff', '#3fb950', '#f0883e', '#d29922', '#a371f7', '#f85149', '#39c5cf', '#db61a2']

export default function Portfolio() {
  const navigate = useNavigate()
  const [holdings, setHoldings] = useState([])
  const [quotes, setQuotes] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [editValues, setEditValues] = useState({ shares: '', costBasis: '' })
  const [form, setForm] = useState({ symbol: '', shares: '', costBasis: '' })
  const [formError, setFormError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const list = await api.portfolio.list()
      setHoldings(list)
      const symbols = [...new Set(list.map((h) => h.symbol))]
      if (symbols.length > 0) {
        const qs = await api.quotes(symbols)
        const bySymbol = {}
        qs.forEach((q) => {
          bySymbol[q.symbol] = q
        })
        setQuotes(bySymbol)
      } else {
        setQuotes({})
      }
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

  const rows = useMemo(() => {
    return holdings.map((h) => {
      const q = quotes[h.symbol]
      const price = q?.regularMarketPrice ?? null
      const marketValue = price != null ? price * h.shares : null
      const costTotal = h.costBasis * h.shares
      const gain = marketValue != null ? marketValue - costTotal : null
      const gainPct = gain != null && costTotal !== 0 ? (gain / costTotal) * 100 : null
      const dayChange = q?.regularMarketChange != null ? q.regularMarketChange * h.shares : null
      return {
        ...h,
        name: q?.shortName || q?.longName || h.symbol,
        price,
        marketValue,
        costTotal,
        gain,
        gainPct,
        dayChange,
        dayChangePct: q?.regularMarketChangePercent ?? null,
      }
    })
  }, [holdings, quotes])

  const summary = useMemo(() => {
    const totalValue = rows.reduce((sum, r) => sum + (r.marketValue ?? 0), 0)
    const totalCost = rows.reduce((sum, r) => sum + r.costTotal, 0)
    const totalGain = totalValue - totalCost
    const totalGainPct = totalCost !== 0 ? (totalGain / totalCost) * 100 : 0
    const totalDayChange = rows.reduce((sum, r) => sum + (r.dayChange ?? 0), 0)
    const prevValue = totalValue - totalDayChange
    const totalDayChangePct = prevValue !== 0 ? (totalDayChange / prevValue) * 100 : 0
    return { totalValue, totalCost, totalGain, totalGainPct, totalDayChange, totalDayChangePct }
  }, [rows])

  const pieData = useMemo(
    () =>
      rows
        .filter((r) => r.marketValue != null && r.marketValue > 0)
        .map((r) => ({ name: r.symbol, value: r.marketValue })),
    [rows]
  )

  async function handleAdd(e) {
    e.preventDefault()
    setFormError(null)
    const symbol = form.symbol.trim().toUpperCase()
    const shares = Number(form.shares)
    const costBasis = Number(form.costBasis)
    if (!symbol || !shares || shares <= 0 || !costBasis || costBasis <= 0) {
      setFormError('Enter a symbol, a positive share count, and a positive cost basis.')
      return
    }
    setSubmitting(true)
    try {
      await api.quote(symbol)
    } catch {
      setFormError(`"${symbol}" doesn't look like a valid ticker.`)
      setSubmitting(false)
      return
    }
    try {
      await api.portfolio.add({ symbol, shares, costBasis })
      setForm({ symbol: '', shares: '', costBasis: '' })
      await load()
    } catch (err) {
      setFormError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  function startEdit(h) {
    setEditingId(h.id)
    setEditValues({ shares: h.shares, costBasis: h.costBasis })
  }

  async function saveEdit(id) {
    const shares = Number(editValues.shares)
    const costBasis = Number(editValues.costBasis)
    if (shares > 0 && costBasis > 0) {
      await api.portfolio.update(id, { shares, costBasis })
      await load()
    }
    setEditingId(null)
  }

  async function removeHolding(id) {
    await api.portfolio.remove(id)
    await load()
  }

  return (
    <div className="page">
      <h1>Portfolio Management &amp; Tracking</h1>
      <p className="muted">Track your holdings, cost basis, and live performance.</p>

      {holdings.length > 0 && (
        <div className="stats-grid">
          <StatCard label="Total Value" value={`$${summary.totalValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
          <StatCard label="Total Cost Basis" value={`$${summary.totalCost.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
          <StatCard
            label="Total Gain/Loss"
            value={`${summary.totalGain >= 0 ? '+' : ''}$${summary.totalGain.toLocaleString(undefined, { maximumFractionDigits: 2 })} (${summary.totalGainPct.toFixed(2)}%)`}
            tone={summary.totalGain >= 0 ? 'up' : 'down'}
          />
          <StatCard
            label="Today's Change"
            value={`${summary.totalDayChange >= 0 ? '+' : ''}$${summary.totalDayChange.toLocaleString(undefined, { maximumFractionDigits: 2 })} (${summary.totalDayChangePct.toFixed(2)}%)`}
            tone={summary.totalDayChange >= 0 ? 'up' : 'down'}
          />
        </div>
      )}

      <div className="card">
        <h3>Add a holding</h3>
        <form className="holding-form" onSubmit={handleAdd}>
          <input
            type="text"
            placeholder="Symbol (e.g. AAPL)"
            value={form.symbol}
            onChange={(e) => setForm({ ...form, symbol: e.target.value })}
          />
          <input
            type="number"
            placeholder="Shares"
            min="0"
            step="any"
            value={form.shares}
            onChange={(e) => setForm({ ...form, shares: e.target.value })}
          />
          <input
            type="number"
            placeholder="Avg cost / share"
            min="0"
            step="any"
            value={form.costBasis}
            onChange={(e) => setForm({ ...form, costBasis: e.target.value })}
          />
          <button className="btn btn-primary" type="submit" disabled={submitting}>
            {submitting ? 'Adding...' : 'Add holding'}
          </button>
        </form>
        {formError && <p className="error small">{formError}</p>}
      </div>

      {error && <p className="error">{error}</p>}
      {loading && holdings.length === 0 && <p className="muted">Loading...</p>}

      {!loading && holdings.length === 0 && !error && (
        <div className="empty-state">
          <p>No holdings yet. Add your first position above.</p>
        </div>
      )}

      {holdings.length > 0 && (
        <div className="portfolio-layout">
          <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Name</th>
                <th>Shares</th>
                <th>Avg Cost</th>
                <th>Price</th>
                <th>Market Value</th>
                <th>Day Change</th>
                <th>Total Gain/Loss</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isEditing = editingId === r.id
                return (
                  <tr key={r.id}>
                    <td
                      className="mono link"
                      onClick={() => navigate(`/analysis/${r.symbol}`)}
                    >
                      {r.symbol}
                    </td>
                    <td>{r.name}</td>
                    <td>
                      {isEditing ? (
                        <input
                          className="cell-input"
                          type="number"
                          value={editValues.shares}
                          onChange={(e) => setEditValues({ ...editValues, shares: e.target.value })}
                        />
                      ) : (
                        r.shares
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <input
                          className="cell-input"
                          type="number"
                          value={editValues.costBasis}
                          onChange={(e) => setEditValues({ ...editValues, costBasis: e.target.value })}
                        />
                      ) : (
                        `$${r.costBasis.toFixed(2)}`
                      )}
                    </td>
                    <td>{r.price != null ? `$${r.price.toFixed(2)}` : '—'}</td>
                    <td>{r.marketValue != null ? `$${r.marketValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}</td>
                    <td className={r.dayChange >= 0 ? 'up' : 'down'}>
                      {r.dayChange != null ? `${r.dayChange >= 0 ? '+' : ''}$${r.dayChange.toFixed(2)} (${r.dayChangePct?.toFixed(2)}%)` : '—'}
                    </td>
                    <td className={r.gain >= 0 ? 'up' : 'down'}>
                      {r.gain != null ? `${r.gain >= 0 ? '+' : ''}$${r.gain.toLocaleString(undefined, { maximumFractionDigits: 2 })} (${r.gainPct?.toFixed(2)}%)` : '—'}
                    </td>
                    <td className="row-actions">
                      {isEditing ? (
                        <>
                          <button className="btn-icon" title="Save" onClick={() => saveEdit(r.id)}>
                            ✓
                          </button>
                          <button className="btn-icon" title="Cancel" onClick={() => setEditingId(null)}>
                            &times;
                          </button>
                        </>
                      ) : (
                        <>
                          <button className="btn-icon" title="Edit" onClick={() => startEdit(r)}>
                            ✎
                          </button>
                          <button className="btn-icon" title="Remove" onClick={() => removeHolding(r.id)}>
                            &times;
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>

          <div className="card allocation-card">
            <h3>Allocation</h3>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
                  {pieData.map((entry, i) => (
                    <Cell key={entry.name} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
              </PieChart>
            </ResponsiveContainer>
            <ul className="legend">
              {pieData.map((entry, i) => (
                <li key={entry.name}>
                  <span className="legend-swatch" style={{ background: COLORS[i % COLORS.length] }} />
                  {entry.name}
                  <span className="muted">{((entry.value / summary.totalValue) * 100).toFixed(1)}%</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, tone }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className={'stat-value' + (tone ? ` ${tone}` : '')}>{value}</div>
    </div>
  )
}
