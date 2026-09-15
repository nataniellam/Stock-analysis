import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.js'

const CONDITIONS = [
  { value: 'price_above', label: 'Price rises above', unit: '$' },
  { value: 'price_below', label: 'Price falls below', unit: '$' },
  { value: 'volume_above', label: 'Volume rises above', unit: '' },
]

function conditionLabel(condition) {
  return CONDITIONS.find((c) => c.value === condition)?.label ?? condition
}

function formatTargetValue(condition, value) {
  if (condition === 'volume_above') return Number(value).toLocaleString()
  return `$${Number(value).toFixed(2)}`
}

export default function Alerts() {
  const navigate = useNavigate()
  const [alerts, setAlerts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [form, setForm] = useState({ symbol: '', condition: 'price_above', targetValue: '' })
  const [formError, setFormError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      setAlerts(await api.alerts.list())
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

  async function handleAdd(e) {
    e.preventDefault()
    setFormError(null)
    const symbol = form.symbol.trim().toUpperCase()
    const targetValue = Number(form.targetValue)
    if (!symbol || !targetValue || targetValue <= 0) {
      setFormError('Enter a symbol and a positive target value.')
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
      await api.alerts.add({ symbol, condition: form.condition, targetValue })
      setForm({ symbol: '', condition: form.condition, targetValue: '' })
      await load()
    } catch (err) {
      setFormError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function rearm(id) {
    await api.alerts.rearm(id)
    await load()
  }

  async function remove(id) {
    await api.alerts.remove(id)
    await load()
  }

  const triggered = alerts.filter((a) => a.triggered)
  const active = alerts.filter((a) => !a.triggered)

  return (
    <div className="page">
      <h1>Advanced Watchlists &amp; Alerts</h1>
      <p className="muted">Get notified when a stock crosses a price or volume threshold.</p>

      <div className="card">
        <h3>Create an alert</h3>
        <form className="holding-form" onSubmit={handleAdd}>
          <input
            type="text"
            placeholder="Symbol (e.g. AAPL)"
            value={form.symbol}
            onChange={(e) => setForm({ ...form, symbol: e.target.value })}
          />
          <select
            className="select"
            value={form.condition}
            onChange={(e) => setForm({ ...form, condition: e.target.value })}
          >
            {CONDITIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <input
            type="number"
            placeholder={form.condition === 'volume_above' ? 'Shares' : 'Price ($)'}
            min="0"
            step="any"
            value={form.targetValue}
            onChange={(e) => setForm({ ...form, targetValue: e.target.value })}
          />
          <button className="btn btn-primary" type="submit" disabled={submitting}>
            {submitting ? 'Creating...' : 'Create alert'}
          </button>
        </form>
        {formError && <p className="error small">{formError}</p>}
      </div>

      {error && <p className="error">{error}</p>}
      {loading && alerts.length === 0 && <p className="muted">Loading...</p>}
      {!loading && alerts.length === 0 && !error && (
        <div className="empty-state">
          <p>No alerts yet. Create one above to get started.</p>
        </div>
      )}

      {triggered.length > 0 && (
        <div className="card">
          <h3>Triggered</h3>
          <div className="alert-list">
            {triggered.map((a) => (
              <div key={a.id} className="alert-row triggered">
                <div className="alert-main">
                  <span className="mono link" onClick={() => navigate(`/analysis/${a.symbol}`)}>
                    {a.symbol}
                  </span>
                  <span>
                    {conditionLabel(a.condition)} {formatTargetValue(a.condition, a.targetValue)}
                  </span>
                  <span className="badge badge-triggered">Triggered</span>
                </div>
                <div className="alert-meta muted small">
                  Hit {formatTargetValue(a.condition, a.triggeredValue)} on{' '}
                  {new Date(a.triggeredAt).toLocaleString()}
                </div>
                <div className="row-actions">
                  <button className="btn btn-outline" onClick={() => rearm(a.id)}>
                    Re-arm
                  </button>
                  <button className="btn-icon" title="Delete" onClick={() => remove(a.id)}>
                    &times;
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {active.length > 0 && (
        <div className="card">
          <h3>Active</h3>
          <div className="alert-list">
            {active.map((a) => (
              <div key={a.id} className="alert-row">
                <div className="alert-main">
                  <span className="mono link" onClick={() => navigate(`/analysis/${a.symbol}`)}>
                    {a.symbol}
                  </span>
                  <span>
                    {conditionLabel(a.condition)} {formatTargetValue(a.condition, a.targetValue)}
                  </span>
                  <span className="badge badge-active">Watching</span>
                </div>
                <div className="alert-meta muted small">
                  Current: {a.condition === 'volume_above'
                    ? a.currentVolume?.toLocaleString()
                    : a.currentPrice != null
                    ? `$${a.currentPrice.toFixed(2)}`
                    : '—'}
                </div>
                <div className="row-actions">
                  <button className="btn-icon" title="Delete" onClick={() => remove(a.id)}>
                    &times;
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
