import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts'
import { api } from '../api.js'

const RANGES = ['1mo', '3mo', '6mo', '1y', '5y']

export default function StockAnalysis() {
  const { symbol: routeSymbol } = useParams()
  const navigate = useNavigate()
  const symbol = routeSymbol?.toUpperCase()

  const [quote, setQuote] = useState(null)
  const [chartData, setChartData] = useState([])
  const [analysis, setAnalysis] = useState(null)
  const [range, setRange] = useState('3mo')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [inWatchlist, setInWatchlist] = useState(false)
  const [deepDive, setDeepDive] = useState(null)
  const [deepDiveLoading, setDeepDiveLoading] = useState(false)
  const [deepDiveError, setDeepDiveError] = useState(null)

  useEffect(() => {
    setDeepDive(null)
    setDeepDiveError(null)
  }, [symbol])

  useEffect(() => {
    if (!symbol) return
    setLoading(true)
    setError(null)
    Promise.all([
      api.quote(symbol),
      api.chart(symbol, range),
      api.analysis(symbol),
      api.watchlist.list(),
    ])
      .then(([q, chart, a, watchlist]) => {
        setQuote(q)
        setChartData(chart)
        setAnalysis(a)
        setInWatchlist(watchlist.map((s) => s.toUpperCase()).includes(symbol))
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [symbol, range])

  async function runDeepDive() {
    setDeepDiveLoading(true)
    setDeepDiveError(null)
    try {
      setDeepDive(await api.deepDive(symbol))
    } catch (err) {
      setDeepDiveError(err.message)
    } finally {
      setDeepDiveLoading(false)
    }
  }

  async function toggleWatchlist() {
    if (inWatchlist) {
      await api.watchlist.remove(symbol)
      setInWatchlist(false)
    } else {
      await api.watchlist.add(symbol)
      setInWatchlist(true)
    }
  }

  if (!symbol) {
    return (
      <div className="page">
        <h1>Stock Analysis</h1>
        <p className="muted">Search for a ticker above to see live price, chart, and fundamentals.</p>
        <div className="quick-picks">
          {['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL'].map((s) => (
            <button key={s} className="chip" onClick={() => navigate(`/analysis/${s}`)}>
              {s}
            </button>
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="page">
        <p className="error">Couldn't load {symbol}: {error}</p>
      </div>
    )
  }

  const price = quote?.regularMarketPrice
  const change = quote?.regularMarketChange
  const changePct = quote?.regularMarketChangePercent
  const positive = change >= 0
  const stats = analysis?.summaryDetail || {}
  const keyStats = analysis?.defaultKeyStatistics || {}
  const financial = analysis?.financialData || {}
  const profile = analysis?.assetProfile || {}

  return (
    <div className="page">
      {loading && !quote ? (
        <p className="muted">Loading {symbol}...</p>
      ) : (
        <>
          <div className="analysis-header">
            <div>
              <h1>
                {quote?.longName || quote?.shortName || symbol}{' '}
                <span className="ticker-badge">{symbol}</span>
              </h1>
              <div className="price-row">
                <span className="price">${price?.toFixed(2)}</span>
                <span className={positive ? 'change up' : 'change down'}>
                  {positive ? '▲' : '▼'} {change?.toFixed(2)} (
                  {changePct?.toFixed(2)}%)
                </span>
              </div>
              <p className="muted small">
                {profile.sector ? `${profile.sector} · ${profile.industry}` : ''}
              </p>
            </div>
            <button className={inWatchlist ? 'btn btn-outline' : 'btn btn-primary'} onClick={toggleWatchlist}>
              {inWatchlist ? '★ In Watchlist' : '☆ Add to Watchlist'}
            </button>
          </div>

          <div className="card">
            <div className="range-tabs">
              {RANGES.map((r) => (
                <button
                  key={r}
                  className={'range-tab' + (r === range ? ' active' : '')}
                  onClick={() => setRange(r)}
                >
                  {r}
                </button>
              ))}
            </div>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(d) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  minTickGap={40}
                  stroke="var(--muted)"
                  fontSize={12}
                />
                <YAxis domain={['auto', 'auto']} stroke="var(--muted)" fontSize={12} width={60} />
                <Tooltip
                  labelFormatter={(d) => new Date(d).toLocaleDateString()}
                  formatter={(v) => [`$${Number(v).toFixed(2)}`, 'Close']}
                />
                <Area type="monotone" dataKey="close" stroke="var(--accent)" fill="url(#priceFill)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="stats-grid">
            <StatCard label="Market Cap" value={formatLarge(stats.marketCap)} />
            <StatCard label="P/E Ratio" value={formatNum(stats.trailingPE)} />
            <StatCard label="EPS (TTM)" value={formatNum(keyStats.trailingEps)} />
            <StatCard label="52wk Range" value={`${formatNum(stats.fiftyTwoWeekLow)} - ${formatNum(stats.fiftyTwoWeekHigh)}`} />
            <StatCard label="Volume" value={formatLarge(quote?.regularMarketVolume)} />
            <StatCard label="Avg Volume" value={formatLarge(stats.averageVolume)} />
            <StatCard label="Dividend Yield" value={stats.dividendYield ? `${(stats.dividendYield * 100).toFixed(2)}%` : '—'} />
            <StatCard label="Beta" value={formatNum(stats.beta)} />
            <StatCard label="Analyst Target" value={formatNum(financial.targetMeanPrice)} />
            <StatCard label="Profit Margin" value={financial.profitMargins ? `${(financial.profitMargins * 100).toFixed(2)}%` : '—'} />
            <StatCard label="Revenue (TTM)" value={formatLarge(financial.totalRevenue)} />
            <StatCard label="Debt / Equity" value={formatNum(financial.debtToEquity)} />
          </div>

          {profile.longBusinessSummary && (
            <div className="card">
              <h3>About</h3>
              <p className="muted">{profile.longBusinessSummary}</p>
            </div>
          )}

          <div className="card">
            <div className="deepdive-header">
              <h3>Deep Dive</h3>
              <button className="btn btn-outline" onClick={runDeepDive} disabled={deepDiveLoading}>
                {deepDiveLoading ? 'Generating…' : deepDive ? 'Regenerate' : 'Generate'}
              </button>
            </div>
            {!deepDive && !deepDiveLoading && !deepDiveError && (
              <p className="muted small">
                AI-generated bull/bear read on growth, moat, management, margins, cash, risk, and
                timing — grounded in the data above, not financial advice.
              </p>
            )}
            {deepDiveError && <p className="error small">{deepDiveError}</p>}
            {deepDive && (
              <div className="deepdive-list">
                {deepDive.questions.map((q, i) => (
                  <div key={i} className="deepdive-question">
                    <h4>
                      {i + 1}. {q.title}
                    </h4>
                    <p>
                      <strong className="up">Bull case: </strong>
                      {q.bullCase}
                    </p>
                    <p>
                      <strong className="down">Bear case: </strong>
                      {q.bearCase}
                    </p>
                    <p className="muted small">{q.dataBasis}</p>
                  </div>
                ))}
                <div className="deepdive-open">
                  <strong>Open question: </strong>
                  {deepDive.openQuestion}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function StatCard({ label, value }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value ?? '—'}</div>
    </div>
  )
}

function formatNum(n) {
  if (n == null || Number.isNaN(n)) return '—'
  return Number(n).toFixed(2)
}

function formatLarge(n) {
  if (n == null || Number.isNaN(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`
  return n.toString()
}
