require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');

const app = express();
// In production, set CORS_ORIGIN to your deployed frontend's URL (e.g. https://your-app.vercel.app).
// Left unset (or "*"), it allows any origin - fine for personal use, but tighten it if you ever
// share the URL publicly.
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

app.get('/', (req, res) => res.send('Stockwise API is running.'));

// --- Market data: Alpha Vantage, with an in-memory cache -------------------------------------
// Alpha Vantage's free tier is capped at 25 requests/day total, so every call type is cached
// (quotes for 30 min, search/chart/fundamentals for much longer - they change slowly). This
// means the frontend's periodic polling mostly hits this cache instead of Alpha Vantage, and
// stays well under budget for personal use. Data is "fresh as of last cache refresh", not truly
// real-time, which is the tradeoff for a free, cloud-hosting-friendly data source.
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_API_KEY;
const AV_BASE = 'https://www.alphavantage.co/query';

const TTL = {
  quote: 30 * 60 * 1000, // 30 min
  chart: 24 * 60 * 60 * 1000, // 24 hr
  overview: 24 * 60 * 60 * 1000, // 24 hr
  search: 60 * 60 * 1000, // 1 hr
};

const cache = new Map();

async function cached(key, ttlMs, fetcher) {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.data;
  const data = await fetcher();
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  return data;
}

async function avFetch(params) {
  if (!ALPHA_VANTAGE_KEY) {
    throw new Error('ALPHA_VANTAGE_API_KEY is not set on the server');
  }
  const url = `${AV_BASE}?${new URLSearchParams({ ...params, apikey: ALPHA_VANTAGE_KEY })}`;
  const res = await fetch(url);
  const data = await res.json();
  const message = data.Note || data.Information || data['Error Message'];
  if (message) {
    const err = new Error(message);
    err.rateLimited = /rate limit|frequency|per day|premium/i.test(message);
    throw err;
  }
  return data;
}

function numOrNull(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

async function fetchQuote(symbol) {
  return cached(`quote:${symbol}`, TTL.quote, async () => {
    const data = await avFetch({ function: 'GLOBAL_QUOTE', symbol });
    const q = data['Global Quote'];
    if (!q || !q['05. price']) throw new Error(`No quote data for ${symbol}`);
    const overview = cache.get(`overview:${symbol}`)?.data;
    return {
      symbol: q['01. symbol'],
      regularMarketPrice: numOrNull(q['05. price']),
      regularMarketChange: numOrNull(q['09. change']),
      regularMarketChangePercent: numOrNull((q['10. change percent'] || '').replace('%', '')),
      regularMarketVolume: numOrNull(q['06. volume']),
      shortName: overview?.Name,
      longName: overview?.Name,
    };
  });
}

async function fetchSearch(query) {
  return cached(`search:${query.toLowerCase()}`, TTL.search, async () => {
    const data = await avFetch({ function: 'SYMBOL_SEARCH', keywords: query });
    return (data.bestMatches || [])
      .filter((m) => m['3. type'] === 'Equity')
      .slice(0, 8)
      .map((m) => ({ symbol: m['1. symbol'], name: m['2. name'], exchange: m['4. region'] }));
  });
}

async function fetchChartAllHistory(symbol) {
  return cached(`chart:${symbol}`, TTL.chart, async () => {
    const data = await avFetch({ function: 'TIME_SERIES_DAILY', symbol, outputsize: 'full' });
    const series = data['Time Series (Daily)'];
    if (!series) throw new Error(`No chart data for ${symbol}`);
    return Object.entries(series)
      .map(([date, v]) => ({
        date: new Date(date).toISOString(),
        open: numOrNull(v['1. open']),
        high: numOrNull(v['2. high']),
        low: numOrNull(v['3. low']),
        close: numOrNull(v['4. close']),
        volume: numOrNull(v['5. volume']),
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  });
}

async function fetchChart(symbol, range) {
  const points = await fetchChartAllHistory(symbol);
  const days = { '1mo': 30, '3mo': 90, '6mo': 182, '1y': 365, '5y': 1825 }[range] || 90;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return points.filter((p) => new Date(p.date).getTime() >= cutoff);
}

async function fetchOverview(symbol) {
  return cached(`overview:${symbol}`, TTL.overview, async () => {
    const data = await avFetch({ function: 'OVERVIEW', symbol });
    if (!data.Symbol) throw new Error(`No fundamentals for ${symbol}`);
    return data;
  });
}

function shapeAnalysis(o) {
  return {
    summaryDetail: {
      marketCap: numOrNull(o.MarketCapitalization),
      trailingPE: numOrNull(o.PERatio),
      fiftyTwoWeekLow: numOrNull(o['52WeekLow']),
      fiftyTwoWeekHigh: numOrNull(o['52WeekHigh']),
      averageVolume: null,
      dividendYield: numOrNull(o.DividendYield),
      beta: numOrNull(o.Beta),
    },
    defaultKeyStatistics: {
      trailingEps: numOrNull(o.EPS),
    },
    financialData: {
      targetMeanPrice: numOrNull(o.AnalystTargetPrice),
      profitMargins: numOrNull(o.ProfitMargin),
      totalRevenue: numOrNull(o.RevenueTTM),
      debtToEquity: null,
    },
    assetProfile: {
      sector: o.Sector,
      industry: o.Industry,
      longBusinessSummary: o.Description,
      name: o.Name,
    },
  };
}

const WATCHLIST_FILE = path.join(__dirname, 'watchlist.json');
const PORTFOLIO_FILE = path.join(__dirname, 'portfolio.json');
const ALERTS_FILE = path.join(__dirname, 'alerts.json');

// When UPSTASH_REDIS_REST_URL is set (e.g. on Render), data is stored in Upstash Redis so it
// reliably survives redeploys. Without it (e.g. local dev), it falls back to local JSON files -
// no external account needed just to run the app on your machine.
const redis = process.env.UPSTASH_REDIS_REST_URL
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  : null;

async function readStore(key, file) {
  if (redis) return (await redis.get(key)) || [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
}

async function writeStore(key, file, data) {
  if (redis) {
    await redis.set(key, data);
    return;
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const readWatchlist = () => readStore('watchlist', WATCHLIST_FILE);
const writeWatchlist = (data) => writeStore('watchlist', WATCHLIST_FILE, data);
const readPortfolio = () => readStore('portfolio', PORTFOLIO_FILE);
const writePortfolio = (data) => writeStore('portfolio', PORTFOLIO_FILE, data);
const readAlerts = () => readStore('alerts', ALERTS_FILE);
const writeAlerts = (data) => writeStore('alerts', ALERTS_FILE, data);

const CONDITIONS = ['price_above', 'price_below', 'volume_above'];

function conditionMet(condition, targetValue, quote) {
  if (condition === 'price_above') return quote.regularMarketPrice >= targetValue;
  if (condition === 'price_below') return quote.regularMarketPrice <= targetValue;
  if (condition === 'volume_above') return quote.regularMarketVolume >= targetValue;
  return false;
}

function handleMarketDataError(err, res) {
  res.status(err.rateLimited ? 429 : 500).json({ error: err.message });
}

// Search symbols
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  try {
    res.json(await fetchSearch(q));
  } catch (err) {
    handleMarketDataError(err, res);
  }
});

// Quote (current price snapshot)
app.get('/api/quote/:symbol', async (req, res) => {
  try {
    res.json(await fetchQuote(req.params.symbol.toUpperCase()));
  } catch (err) {
    handleMarketDataError(err, res);
  }
});

// Batch quotes (for watchlist)
app.get('/api/quotes', async (req, res) => {
  const symbols = (req.query.symbols || '').split(',').filter(Boolean);
  if (symbols.length === 0) return res.json([]);
  const results = await Promise.all(
    symbols.map((s) => fetchQuote(s.toUpperCase()).catch(() => null))
  );
  res.json(results.filter(Boolean));
});

// Historical chart data
app.get('/api/chart/:symbol', async (req, res) => {
  const { range = '3mo' } = req.query;
  try {
    res.json(await fetchChart(req.params.symbol.toUpperCase(), range));
  } catch (err) {
    handleMarketDataError(err, res);
  }
});

// Deeper fundamentals/analysis
app.get('/api/analysis/:symbol', async (req, res) => {
  try {
    const overview = await fetchOverview(req.params.symbol.toUpperCase());
    res.json(shapeAnalysis(overview));
  } catch (err) {
    handleMarketDataError(err, res);
  }
});

// Watchlist CRUD
app.get('/api/watchlist', async (req, res) => {
  res.json(await readWatchlist());
});

app.post('/api/watchlist', async (req, res) => {
  const { symbol } = req.body;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const list = await readWatchlist();
  const upper = symbol.toUpperCase();
  if (!list.includes(upper)) list.push(upper);
  await writeWatchlist(list);
  res.json(list);
});

app.delete('/api/watchlist/:symbol', async (req, res) => {
  const list = (await readWatchlist()).filter(
    (s) => s.toUpperCase() !== req.params.symbol.toUpperCase()
  );
  await writeWatchlist(list);
  res.json(list);
});

// Portfolio CRUD
app.get('/api/portfolio', async (req, res) => {
  res.json(await readPortfolio());
});

app.post('/api/portfolio', async (req, res) => {
  const { symbol, shares, costBasis, purchaseDate } = req.body;
  if (!symbol || !shares || !costBasis) {
    return res.status(400).json({ error: 'symbol, shares, and costBasis are required' });
  }
  const holdings = await readPortfolio();
  const holding = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    symbol: symbol.toUpperCase(),
    shares: Number(shares),
    costBasis: Number(costBasis),
    purchaseDate: purchaseDate || null,
  };
  holdings.push(holding);
  await writePortfolio(holdings);
  res.json(holdings);
});

app.put('/api/portfolio/:id', async (req, res) => {
  const holdings = await readPortfolio();
  const idx = holdings.findIndex((h) => h.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'holding not found' });
  const { shares, costBasis, purchaseDate } = req.body;
  if (shares != null) holdings[idx].shares = Number(shares);
  if (costBasis != null) holdings[idx].costBasis = Number(costBasis);
  if (purchaseDate !== undefined) holdings[idx].purchaseDate = purchaseDate;
  await writePortfolio(holdings);
  res.json(holdings);
});

app.delete('/api/portfolio/:id', async (req, res) => {
  const holdings = (await readPortfolio()).filter((h) => h.id !== req.params.id);
  await writePortfolio(holdings);
  res.json(holdings);
});

// Alerts: create/list (with live evaluation)/rearm/delete
app.get('/api/alerts', async (req, res) => {
  try {
    const alerts = await readAlerts();
    const symbols = [...new Set(alerts.filter((a) => !a.triggered).map((a) => a.symbol))];
    let quotesBySymbol = {};
    if (symbols.length > 0) {
      const quotes = await Promise.all(symbols.map((s) => fetchQuote(s).catch(() => null)));
      quotes.filter(Boolean).forEach((q) => (quotesBySymbol[q.symbol] = q));
    }

    let changed = false;
    for (const alert of alerts) {
      if (alert.triggered) continue;
      const quote = quotesBySymbol[alert.symbol];
      if (!quote) continue;
      if (conditionMet(alert.condition, alert.targetValue, quote)) {
        alert.triggered = true;
        alert.triggeredAt = new Date().toISOString();
        alert.triggeredValue =
          alert.condition === 'volume_above' ? quote.regularMarketVolume : quote.regularMarketPrice;
        changed = true;
      }
    }
    if (changed) await writeAlerts(alerts);

    // Also fetch current values for already-triggered/all alerts for display
    const allSymbols = [...new Set(alerts.map((a) => a.symbol))].filter((s) => !quotesBySymbol[s]);
    if (allSymbols.length > 0) {
      const quotes = await Promise.all(allSymbols.map((s) => fetchQuote(s).catch(() => null)));
      quotes.filter(Boolean).forEach((q) => (quotesBySymbol[q.symbol] = q));
    }

    const enriched = alerts.map((a) => {
      const quote = quotesBySymbol[a.symbol];
      return {
        ...a,
        currentPrice: quote?.regularMarketPrice ?? null,
        currentVolume: quote?.regularMarketVolume ?? null,
      };
    });
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/alerts', async (req, res) => {
  const { symbol, condition, targetValue } = req.body;
  if (!symbol || !CONDITIONS.includes(condition) || !targetValue) {
    return res.status(400).json({ error: 'symbol, valid condition, and targetValue are required' });
  }
  const alerts = await readAlerts();
  alerts.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    symbol: symbol.toUpperCase(),
    condition,
    targetValue: Number(targetValue),
    createdAt: new Date().toISOString(),
    triggered: false,
    triggeredAt: null,
    triggeredValue: null,
  });
  await writeAlerts(alerts);
  res.json(alerts);
});

app.put('/api/alerts/:id', async (req, res) => {
  const alerts = await readAlerts();
  const idx = alerts.findIndex((a) => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'alert not found' });
  if (req.body.rearm) {
    alerts[idx].triggered = false;
    alerts[idx].triggeredAt = null;
    alerts[idx].triggeredValue = null;
  }
  await writeAlerts(alerts);
  res.json(alerts);
});

app.delete('/api/alerts/:id', async (req, res) => {
  const alerts = (await readAlerts()).filter((a) => a.id !== req.params.id);
  await writeAlerts(alerts);
  res.json(alerts);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
