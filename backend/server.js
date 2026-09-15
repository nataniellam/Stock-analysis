require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();

const app = express();
// In production, set CORS_ORIGIN to your deployed frontend's URL (e.g. https://your-app.vercel.app).
// Left unset (or "*"), it allows any origin - fine for personal use, but tighten it if you ever
// share the URL publicly.
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

app.get('/', (req, res) => res.send('Stockwise API is running.'));

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

// Search symbols
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  try {
    const result = await yahooFinance.search(q, { quotesCount: 8, newsCount: 0 });
    const quotes = (result.quotes || [])
      .filter((item) => item.symbol && (item.quoteType === 'EQUITY' || item.quoteType === 'ETF'))
      .map((item) => ({
        symbol: item.symbol,
        name: item.shortname || item.longname || item.symbol,
        exchange: item.exchange,
      }));
    res.json(quotes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Quote (current price snapshot)
app.get('/api/quote/:symbol', async (req, res) => {
  try {
    const quote = await yahooFinance.quote(req.params.symbol);
    res.json(quote);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Batch quotes (for watchlist)
app.get('/api/quotes', async (req, res) => {
  const symbols = (req.query.symbols || '').split(',').filter(Boolean);
  if (symbols.length === 0) return res.json([]);
  try {
    const results = await Promise.all(
      symbols.map((s) => yahooFinance.quote(s).catch(() => null))
    );
    res.json(results.filter(Boolean));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Historical chart data
app.get('/api/chart/:symbol', async (req, res) => {
  const { range = '3mo', interval = '1d' } = req.query;
  try {
    const period1 = rangeToPeriod1(range);
    const result = await yahooFinance.chart(req.params.symbol, {
      period1,
      interval,
    });
    const points = (result.quotes || [])
      .filter((p) => p.close != null)
      .map((p) => ({
        date: p.date,
        close: p.close,
        open: p.open,
        high: p.high,
        low: p.low,
        volume: p.volume,
      }));
    res.json(points);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deeper fundamentals/analysis
app.get('/api/analysis/:symbol', async (req, res) => {
  try {
    const modules = [
      'price',
      'summaryDetail',
      'defaultKeyStatistics',
      'financialData',
      'recommendationTrend',
      'earningsTrend',
      'assetProfile',
    ];
    const result = await yahooFinance.quoteSummary(req.params.symbol, { modules });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
      const quotes = await Promise.all(symbols.map((s) => yahooFinance.quote(s).catch(() => null)));
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
      const quotes = await Promise.all(allSymbols.map((s) => yahooFinance.quote(s).catch(() => null)));
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

function rangeToPeriod1(range) {
  const now = new Date();
  const days = { '1mo': 30, '3mo': 90, '6mo': 182, '1y': 365, '5y': 1825 }[range] || 90;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
