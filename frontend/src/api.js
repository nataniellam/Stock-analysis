// In local dev, VITE_API_URL is unset, so this stays "/api" and Vite's dev-server proxy
// (see vite.config.js) forwards it to the backend on localhost:3001.
// In production (e.g. Vercel), set VITE_API_URL to your deployed backend's URL
// (e.g. https://stockwise-backend.onrender.com) so the frontend calls it directly.
const BASE = `${import.meta.env.VITE_API_URL || ''}/api`;

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

export const api = {
  search: (q) => get(`/search?q=${encodeURIComponent(q)}`),
  quote: (symbol) => get(`/quote/${encodeURIComponent(symbol)}`),
  quotes: (symbols) => get(`/quotes?symbols=${encodeURIComponent(symbols.join(','))}`),
  chart: (symbol, range = '3mo') => get(`/chart/${encodeURIComponent(symbol)}?range=${range}`),
  analysis: (symbol) => get(`/analysis/${encodeURIComponent(symbol)}`),
  watchlist: {
    list: () => get('/watchlist'),
    add: async (symbol) => {
      const res = await fetch(`${BASE}/watchlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      });
      return res.json();
    },
    remove: async (symbol) => {
      const res = await fetch(`${BASE}/watchlist/${encodeURIComponent(symbol)}`, {
        method: 'DELETE',
      });
      return res.json();
    },
  },
  portfolio: {
    list: () => get('/portfolio'),
    add: async (holding) => {
      const res = await fetch(`${BASE}/portfolio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(holding),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to add holding');
      return res.json();
    },
    update: async (id, fields) => {
      const res = await fetch(`${BASE}/portfolio/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      return res.json();
    },
    remove: async (id) => {
      const res = await fetch(`${BASE}/portfolio/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      return res.json();
    },
  },
  alerts: {
    list: () => get('/alerts'),
    add: async (alert) => {
      const res = await fetch(`${BASE}/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alert),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to create alert');
      return res.json();
    },
    rearm: async (id) => {
      const res = await fetch(`${BASE}/alerts/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rearm: true }),
      });
      return res.json();
    },
    remove: async (id) => {
      const res = await fetch(`${BASE}/alerts/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      return res.json();
    },
  },
};
