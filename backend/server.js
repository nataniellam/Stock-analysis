require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');

const app = express();
// In production, set CORS_ORIGIN to your deployed frontend's stable production URL
// (e.g. https://your-app.vercel.app). Left unset, it allows any origin - fine for personal
// use, but tighten it if you ever share the URL publicly.
//
// Vercel also generates a new "preview" URL (a random hash) on every push, distinct from the
// stable production URL - this always allows those too (matched by project name pattern), so
// opening a preview deployment link doesn't get blocked just because CORS_ORIGIN only names
// the production one.
const CORS_ORIGIN = process.env.CORS_ORIGIN;
const VERCEL_PREVIEW_PATTERN = /^https:\/\/stock-analysis(-[a-z0-9]+)*\.vercel\.app$/i;

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true); // non-browser requests (curl, health checks)
      if (!CORS_ORIGIN || origin === CORS_ORIGIN || VERCEL_PREVIEW_PATTERN.test(origin)) {
        return callback(null, true);
      }
      callback(null, false);
    },
  })
);
app.use(express.json());

app.get('/', (req, res) => res.send('Stockwise API is running.'));

// --- Market data: Twelve Data, with an in-memory cache -----------------------------------------
// Twelve Data's free tier (800 requests/day, 8/min) is far more generous than Alpha Vantage's,
// so quotes are cached for just 5 minutes (fresher data); charts/fundamentals still cache for
// 24 hours since daily bars and company fundamentals don't need finer granularity. This keeps
// normal polling (watchlist/portfolio/alerts) comfortably under budget for personal use.
const TWELVE_DATA_KEY = process.env.TWELVE_DATA_API_KEY;
const TD_BASE = 'https://api.twelvedata.com';

const TTL = {
  quote: 5 * 60 * 1000, // 5 min
  chart: 24 * 60 * 60 * 1000, // 24 hr
  fundamentals: 24 * 60 * 60 * 1000, // 24 hr
  search: 60 * 60 * 1000, // 1 hr
  deepDive: 24 * 60 * 60 * 1000, // 24 hr - also keeps Gemini's free-tier quota comfortably safe
};

const cache = new Map();

async function cached(key, ttlMs, fetcher) {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.data;
  const data = await fetcher();
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  return data;
}

async function tdFetch(path, params) {
  if (!TWELVE_DATA_KEY) {
    throw new Error('TWELVE_DATA_API_KEY is not set on the server');
  }
  const url = `${TD_BASE}${path}?${new URLSearchParams({ ...params, apikey: TWELVE_DATA_KEY })}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status === 'error' || data.code >= 400) {
    const err = new Error(data.message || 'Twelve Data request failed');
    err.rateLimited = /credit|limit|too many/i.test(data.message || '');
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
    const q = await tdFetch('/quote', { symbol });
    if (!q.close) throw new Error(`No quote data for ${symbol}`);
    return {
      symbol: q.symbol,
      regularMarketPrice: numOrNull(q.close),
      regularMarketChange: numOrNull(q.change),
      regularMarketChangePercent: numOrNull(q.percent_change),
      regularMarketVolume: numOrNull(q.volume),
      shortName: q.name,
      longName: q.name,
    };
  });
}

async function fetchSearch(query) {
  return cached(`search:${query.toLowerCase()}`, TTL.search, async () => {
    const data = await tdFetch('/symbol_search', { symbol: query });
    const matches = (data.data || []).filter((m) => ['Common Stock', 'ETF'].includes(m.instrument_type));
    // Prefer US-listed results (most relevant for this app) but fall back to all matches
    // for symbols that only trade on non-US exchanges.
    const us = matches.filter((m) => m.country === 'United States');
    return (us.length > 0 ? us : matches)
      .slice(0, 8)
      .map((m) => ({ symbol: m.symbol, name: m.instrument_name, exchange: m.exchange }));
  });
}

async function fetchChartAllHistory(symbol) {
  return cached(`chart:${symbol}`, TTL.chart, async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 5 * 365 * 24 * 60 * 60 * 1000);
    const data = await tdFetch('/time_series', {
      symbol,
      interval: '1day',
      start_date: start.toISOString().slice(0, 10),
      end_date: end.toISOString().slice(0, 10),
      outputsize: 5000,
    });
    if (!data.values) throw new Error(`No chart data for ${symbol}`);
    return data.values
      .map((v) => ({
        date: new Date(v.datetime).toISOString(),
        open: numOrNull(v.open),
        high: numOrNull(v.high),
        low: numOrNull(v.low),
        close: numOrNull(v.close),
        volume: numOrNull(v.volume),
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

// Fundamentals come from Financial Modeling Prep instead of Twelve Data - Twelve Data's free
// tier gates /profile and /statistics behind a paid plan for effectively every symbol except
// one demo ticker. FMP's free tier (250 req/day) covers company profile + basic ratios for any
// symbol with no such allowlist.
const FMP_KEY = process.env.FMP_API_KEY;
// FMP retired its old /api/v3/{endpoint}/{symbol} paths for new signups (as of Aug 2025) in
// favor of a "stable" API using ?symbol= query params instead of path params.
const FMP_BASE = 'https://financialmodelingprep.com/stable';

async function fmpFetch(endpoint, symbol) {
  if (!FMP_KEY) throw new Error('FMP_API_KEY is not set on the server');
  const url = `${FMP_BASE}/${endpoint}?${new URLSearchParams({ symbol, apikey: FMP_KEY })}`;
  const res = await fetch(url);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // FMP sometimes returns a plain-text upsell/limit message instead of JSON.
    const err = new Error(text.slice(0, 300) || `FMP request failed (HTTP ${res.status})`);
    err.rateLimited = /premium|limit/i.test(text);
    throw err;
  }
  if (data['Error Message']) {
    const err = new Error(data['Error Message']);
    err.rateLimited = /limit/i.test(data['Error Message']);
    throw err;
  }
  return data;
}

async function fetchFundamentals(symbol) {
  return cached(`fundamentals:${symbol}`, TTL.fundamentals, async () => {
    const [profileRes, quoteRes, ratiosRes] = await Promise.allSettled([
      fmpFetch('profile', symbol),
      fmpFetch('quote', symbol),
      fmpFetch('ratios-ttm', symbol),
    ]);
    if (profileRes.status === 'rejected') console.error(`[fundamentals] profile ${symbol}:`, profileRes.reason?.message);
    if (quoteRes.status === 'rejected') console.error(`[fundamentals] quote ${symbol}:`, quoteRes.reason?.message);
    if (ratiosRes.status === 'rejected') console.error(`[fundamentals] ratios ${symbol}:`, ratiosRes.reason?.message);
    return {
      profile: profileRes.status === 'fulfilled' ? profileRes.value?.[0] : null,
      quote: quoteRes.status === 'fulfilled' ? quoteRes.value?.[0] : null,
      ratios: ratiosRes.status === 'fulfilled' ? ratiosRes.value?.[0] : null,
      _debug: {
        profileError: profileRes.status === 'rejected' ? profileRes.reason?.message : null,
        quoteError: quoteRes.status === 'rejected' ? quoteRes.reason?.message : null,
        ratiosError: ratiosRes.status === 'rejected' ? ratiosRes.reason?.message : null,
      },
    };
  });
}

function shapeAnalysis({ profile, quote, ratios }) {
  // FMP's /ratios-ttm expresses debt/equity as a plain ratio (e.g. 0.78); scaled by 100 to
  // match the percent-style convention shown elsewhere (Yahoo/Twelve Data-style "78.4").
  const debtToEquity = ratios?.debtToEquityRatioTTM != null ? ratios.debtToEquityRatioTTM * 100 : null;
  return {
    summaryDetail: {
      marketCap: numOrNull(quote?.marketCap ?? profile?.marketCap),
      trailingPE: numOrNull(ratios?.priceToEarningsRatioTTM),
      fiftyTwoWeekLow: numOrNull(quote?.yearLow),
      fiftyTwoWeekHigh: numOrNull(quote?.yearHigh),
      averageVolume: numOrNull(profile?.averageVolume),
      dividendYield: numOrNull(ratios?.dividendYieldTTM),
      beta: numOrNull(profile?.beta),
    },
    defaultKeyStatistics: {
      trailingEps: numOrNull(ratios?.netIncomePerShareTTM),
    },
    financialData: {
      targetMeanPrice: null,
      profitMargins: numOrNull(ratios?.netProfitMarginTTM),
      totalRevenue: null,
      debtToEquity,
    },
    assetProfile: {
      sector: profile?.sector,
      industry: profile?.industry,
      longBusinessSummary: profile?.description,
      name: profile?.companyName,
    },
  };
}

// --- Deep Dive: Gemini-generated 7-question analysis ------------------------------------------
// Uses Google Gemini's free API tier (no billing required) to write a bull/bear analysis of a
// stock through a 7-question framework, grounded in the real quote/fundamentals data already
// fetched above. Cached for 24h per symbol - both to respect Gemini's free-tier rate limits and
// because the underlying data doesn't change meaningfully within a day.
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const DEEP_DIVE_QUESTIONS = [
  {
    title: 'Is the business growing?',
    guidance:
      'Revenue trajectory over the last 3-5 years - rate of growth, and whether it is decelerating or accelerating. Flat or declining growth is a real concern worth naming clearly, paired with why (macro cyclicality, market share loss, mature TAM). Note consensus forward growth estimates vs. trailing growth where relevant.',
  },
  {
    title: 'Can they defend their position?',
    guidance:
      'Moat sources - network effects, brand power, switching costs, regulatory/licensing barriers, scale economics. Could a well-capitalized competitor meaningfully take share within ~2 years? Bull case cites the specific moat mechanism and evidence it is holding. Bear case names the plausible disruptor or erosion vector, not a generic "competition risk" hand-wave.',
  },
  {
    title: 'Is management competent?',
    guidance:
      'Capital allocation track record (buybacks vs. dividends vs. reinvestment vs. M&A quality), insider buying/selling patterns, and whether prior guidance has actually been met. Note specific instances rather than a vague competence rating. Flag if there is insufficient public track record to judge yet - that is itself a data point.',
  },
  {
    title: 'Are margins improving or declining?',
    guidance:
      'Gross and operating margin trends over 3+ years, and - importantly - why they are moving (pricing power vs. cost discipline vs. rising competition vs. one-off items). Separate margin compression from rising competitive intensity vs. a temporary input-cost spike vs. an intentional reinvestment phase.',
  },
  {
    title: "What's the cash situation?",
    guidance:
      'Operating cash flow trend and whether it is converting into free cash flow; whether cash flow tracks reported earnings (divergence is a quality-of-earnings flag) or is being propped up by financing activity. State burn rate against cash on hand and what financing risk that implies, if relevant.',
  },
  {
    title: "What's the risk?",
    guidance:
      'Name three concrete risks specific to this company right now - regulatory exposure, competitive entrants, macro/rate sensitivity, debt/refinancing, customer/supplier concentration. "Regulation" alone is not a risk statement; be specific. Give this section real weight - it is where the bear case gets its sharpest teeth.',
  },
  {
    title: 'Is the timing right?',
    guidance:
      'Valuation relative to own history and to peers, recent price action, and upcoming catalysts (earnings date, product launch, regulatory decision, macro event) that could move the thesis near-term. This is explicitly not "should you buy now" - lay out what is priced in already vs. what is not.',
  },
];

const BALANCED_ANALYST_RULES = `Apply a balanced-analyst approach throughout: present the bull case and bear case for each question with equal rigor. Never give a buy/sell verdict or recommendation anywhere in the output. Explicitly flag genuine uncertainty rather than papering over it. In each question's "dataBasis" field, distinguish what is grounded in the real data provided below versus what is your own general knowledge/inference about the company and industry. Where a question surfaces a genuine red flag, state it plainly and weight it appropriately, but frame it as "the bear case's strongest pillar" rather than an automatic disqualification - the reader makes the call.`;

async function geminiGenerate(prompt, schema) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY is not set on the server');
  const url = `${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema },
    }),
  });
  const data = await res.json();
  if (data.error) {
    console.error('[gemini] error response:', JSON.stringify(data.error));
    const detail = data.error.details?.map((d) => d.reason || d['@type']).join(', ');
    const err = new Error(
      `${data.error.message || 'Gemini request failed'} (status: ${data.error.status || res.status}${detail ? `, reason: ${detail}` : ''})`
    );
    err.rateLimited = data.error.code === 429 || /quota|rate/i.test(data.error.message || '');
    throw err;
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no usable content (it may have been blocked by a safety filter)');
  return JSON.parse(text);
}

async function fetchDeepDive(symbol) {
  return cached(`deepdive:${symbol}`, TTL.deepDive, async () => {
    const [quote, fundamentalsRaw] = await Promise.all([
      fetchQuote(symbol).catch(() => null),
      fetchFundamentals(symbol).catch(() => null),
    ]);
    const f = fundamentalsRaw ? shapeAnalysis(fundamentalsRaw) : null;

    const dataSummary = [
      `Company: ${f?.assetProfile?.name || symbol} (${symbol})`,
      `Sector / Industry: ${f?.assetProfile?.sector || 'unknown'} / ${f?.assetProfile?.industry || 'unknown'}`,
      `Current price: ${quote?.regularMarketPrice ?? 'unknown'} (${quote?.regularMarketChangePercent ?? '?'}% today)`,
      `Market cap: ${f?.summaryDetail?.marketCap ?? 'unknown'}`,
      `Trailing P/E: ${f?.summaryDetail?.trailingPE ?? 'unknown'}`,
      `EPS (TTM): ${f?.defaultKeyStatistics?.trailingEps ?? 'unknown'}`,
      `52-week range: ${f?.summaryDetail?.fiftyTwoWeekLow ?? '?'} - ${f?.summaryDetail?.fiftyTwoWeekHigh ?? '?'}`,
      `Beta: ${f?.summaryDetail?.beta ?? 'unknown'}`,
      `Dividend yield: ${f?.summaryDetail?.dividendYield ?? 'unknown'}`,
      `Net profit margin (TTM): ${f?.financialData?.profitMargins ?? 'unknown'}`,
      `Debt/Equity: ${f?.financialData?.debtToEquity ?? 'unknown'}`,
      `Business description: ${f?.assetProfile?.longBusinessSummary || 'not available'}`,
    ].join('\n');

    const questionsBlock = DEEP_DIVE_QUESTIONS.map((q, i) => `${i + 1}. ${q.title}\n   Look at: ${q.guidance}`).join(
      '\n\n'
    );

    const prompt = `You are a balanced equity research analyst. Below is real, current data for one stock, followed by a 7-question evaluation framework. Produce a JSON object analyzing this stock through all 7 questions, in order.

${BALANCED_ANALYST_RULES}

REAL DATA FOR ${symbol}:
${dataSummary}

FRAMEWORK QUESTIONS (answer all 7, in this order):
${questionsBlock}

For each question, write a "bullCase" and "bearCase" of 2-4 sentences each, and a short "dataBasis" note. End with a 1-2 sentence "openQuestion" naming the next dated catalyst or open uncertainty (per question 7's framing), with no buy/sell verdict anywhere in the response.`;

    const schema = {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              bullCase: { type: 'string' },
              bearCase: { type: 'string' },
              dataBasis: { type: 'string' },
            },
            required: ['title', 'bullCase', 'bearCase', 'dataBasis'],
          },
        },
        openQuestion: { type: 'string' },
      },
      required: ['questions', 'openQuestion'],
    };

    const result = await geminiGenerate(prompt, schema);
    return { ...result, generatedAt: new Date().toISOString() };
  });
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
    const fundamentals = await fetchFundamentals(req.params.symbol.toUpperCase());
    res.json(shapeAnalysis(fundamentals));
  } catch (err) {
    handleMarketDataError(err, res);
  }
});

// 7-question Deep Dive (Gemini-generated, cached 24h per symbol)
app.get('/api/deepdive/:symbol', async (req, res) => {
  try {
    res.json(await fetchDeepDive(req.params.symbol.toUpperCase()));
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
