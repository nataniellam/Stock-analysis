const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
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

function readWatchlist() {
  try {
    return JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function writeWatchlist(symbols) {
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(symbols, null, 2));
}

function readPortfolio() {
  try {
    return JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function writePortfolio(holdings) {
  fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(holdings, null, 2));
}

function readAlerts() {
  try {
    return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function writeAlerts(alerts) {
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
}

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
app.get('/api/watchlist', (req, res) => {
  res.json(readWatchlist());
});

app.post('/api/watchlist', (req, res) => {
  const { symbol } = req.body;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const list = readWatchlist();
  const upper = symbol.toUpperCase();
  if (!list.includes(upper)) list.push(upper);
  writeWatchlist(list);
  res.json(list);
});

app.delete('/api/watchlist/:symbol', (req, res) => {
  const list = readWatchlist().filter(
    (s) => s.toUpperCase() !== req.params.symbol.toUpperCase()
  );
  writeWatchlist(list);
  res.json(list);
});

// Portfolio CRUD
app.get('/api/portfolio', (req, res) => {
  res.json(readPortfolio());
});

app.post('/api/portfolio', (req, res) => {
  const { symbol, shares, costBasis, purchaseDate } = req.body;
  if (!symbol || !shares || !costBasis) {
    return res.status(400).json({ error: 'symbol, shares, and costBasis are required' });
  }
  const holdings = readPortfolio();
  const holding = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    symbol: symbol.toUpperCase(),
    shares: Number(shares),
    costBasis: Number(costBasis),
    purchaseDate: purchaseDate || null,
  };
  holdings.push(holding);
  writePortfolio(holdings);
  res.json(holdings);
});

app.put('/api/portfolio/:id', (req, res) => {
  const holdings = readPortfolio();
  const idx = holdings.findIndex((h) => h.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'holding not found' });
  const { shares, costBasis, purchaseDate } = req.body;
  if (shares != null) holdings[idx].shares = Number(shares);
  if (costBasis != null) holdings[idx].costBasis = Number(costBasis);
  if (purchaseDate !== undefined) holdings[idx].purchaseDate = purchaseDate;
  writePortfolio(holdings);
  res.json(holdings);
});

app.delete('/api/portfolio/:id', (req, res) => {
  const holdings = readPortfolio().filter((h) => h.id !== req.params.id);
  writePortfolio(holdings);
  res.json(holdings);
});

// Alerts: create/list (with live evaluation)/rearm/delete
app.get('/api/alerts', async (req, res) => {
  try {
    const alerts = readAlerts();
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
    if (changed) writeAlerts(alerts);

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

app.post('/api/alerts', (req, res) => {
  const { symbol, condition, targetValue } = req.body;
  if (!symbol || !CONDITIONS.includes(condition) || !targetValue) {
    return res.status(400).json({ error: 'symbol, valid condition, and targetValue are required' });
  }
  const alerts = readAlerts();
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
  writeAlerts(alerts);
  res.json(alerts);
});

app.put('/api/alerts/:id', (req, res) => {
  const alerts = readAlerts();
  const idx = alerts.findIndex((a) => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'alert not found' });
  if (req.body.rearm) {
    alerts[idx].triggered = false;
    alerts[idx].triggeredAt = null;
    alerts[idx].triggeredValue = null;
  }
  writeAlerts(alerts);
  res.json(alerts);
});

app.delete('/api/alerts/:id', (req, res) => {
  const alerts = readAlerts().filter((a) => a.id !== req.params.id);
  writeAlerts(alerts);
  res.json(alerts);
});

function rangeToPeriod1(range) {
  const now = new Date();
  const days = { '1mo': 30, '3mo': 90, '6mo': 182, '1y': 365, '5y': 1825 }[range] || 90;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
