# Stockwise

A stock analysis app: live quotes and fundamentals, a portfolio tracker, a watchlist, and
price/volume alerts. Backend is a small Express API (Twelve Data for quotes/charts/search,
Financial Modeling Prep for fundamentals — see "Why two market-data providers" below);
frontend is React (Vite).

## Run it locally

Market data requires two free API keys (even for local dev) — sign up for both, then put
them in `backend/.env` (copy `backend/.env.example`):

```
TWELVE_DATA_API_KEY=your-key-here
FMP_API_KEY=your-key-here
```

- Twelve Data: sign up at [twelvedata.com](https://twelvedata.com) (key is on your dashboard).
- Financial Modeling Prep: sign up at [site.financialmodelingprep.com/developer/docs](https://site.financialmodelingprep.com/developer/docs).

```bash
# terminal 1
cd backend
npm install
node server.js        # http://localhost:3001

# terminal 2
cd frontend
npm install
npm run dev            # http://localhost:5173
```

Open http://localhost:5173. The frontend's dev server proxies `/api/*` to the backend
automatically (see `frontend/vite.config.js`) — no configuration needed locally.

### Why two market-data providers

Twelve Data's free tier (800 requests/day, 8/min — generous) covers quotes, charts, and
search for any symbol, but its `/profile` and `/statistics` endpoints (fundamentals: market
cap, P/E, sector, description, etc.) are paywalled behind a paid plan for effectively every
symbol except one demo ticker. Financial Modeling Prep's free tier (250 requests/day) covers
fundamentals for any symbol with no such restriction, so it's used for that part instead.
The backend still caches everything (quotes 5 min, charts/fundamentals 24 hr) so normal
personal use — even combined across two providers — stays comfortably within both free
tiers. If a limit is ever hit, requests return a clear "rate limit" error rather than
failing silently.

Your watchlist, portfolio, and alerts are stored in `backend/*.json` files (gitignored) —
they persist across restarts as long as those files stick around on the machine running
the backend. (In production, this is swapped for Upstash Redis — see step 2a below —
so data survives redeploys. Locally, without Upstash env vars set, it just uses these
files, so there's no need to sign up for anything to develop.)

## Deploying it

Two pieces, deployed separately: the backend (Render) and the frontend (Vercel). Both have
free tiers that are enough for personal use.

### 1. Push this repo to GitHub

If you haven't already:

```bash
git init
git add .
git commit -m "Initial commit"
gh repo create stockwise --private --source=. --push
```

(Or create a repo on github.com and `git remote add origin <url> && git push -u origin main`.)

### 2. Deploy the backend to Render

1. Sign up at [render.com](https://render.com) (free).
2. **New +** → **Blueprint**, connect your GitHub repo. Render will pick up `render.yaml`
   at the repo root automatically and configure the service (root dir `backend`, build
   `npm install`, start `node server.js`).
   - No blueprint support? Create a **Web Service** manually instead: root directory
     `backend`, build command `npm install`, start command `node server.js`.
3. It'll ask you to fill in a few env vars:
   - `TWELVE_DATA_API_KEY` — your key from [twelvedata.com](https://twelvedata.com) (required for quotes/charts/search).
   - `FMP_API_KEY` — your key from [Financial Modeling Prep](https://site.financialmodelingprep.com/developer/docs) (required for the fundamentals stats on the Analysis page).
   - `CORS_ORIGIN` — leave blank for now (you'll set it after step 3, once you know your Vercel URL). You can also leave it unset permanently; the backend defaults to allowing any origin, which is fine for personal use.
4. Deploy. Note the URL Render gives you, e.g. `https://stockwise-backend.onrender.com`.

**Free tier note:** the free plan spins the service down after ~15 minutes of no traffic.
The next request wakes it up but takes 30–60 seconds. Fine for personal use; upgrade to a
paid instance (~$7/mo) if that delay bothers you.

### 2a. Set up persistent storage (Upstash Redis)

Render's free-tier disk isn't guaranteed to survive redeploys, so watchlist/portfolio/alerts
data is stored in Upstash Redis instead when these two env vars are set (falls back to local
JSON files when they're not — e.g. in local dev):

1. Sign up at [upstash.com](https://upstash.com) (free).
2. Create a Redis database (any region close to your Render service; free tier is plenty).
3. Open its **Details** page → **REST API** section. Copy the `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN` values shown there.
4. Back in Render, on your service's **Environment** tab, paste those in as
   `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (if you deployed via the
   `render.yaml` blueprint, these rows are already there waiting for values). Save — Render
   redeploys automatically.

That's it — no code changes needed, and this stays on Upstash's free tier for personal use.

### 3. Deploy the frontend to Vercel

1. Sign up at [vercel.com](https://vercel.com) (free).
2. **Add New** → **Project**, import the same GitHub repo.
3. Set **Root Directory** to `frontend` (Vercel auto-detects the Vite framework preset).
4. Add an environment variable: `VITE_API_URL` = your Render URL from step 2
   (e.g. `https://stockwise-backend.onrender.com`, no trailing slash).
5. Deploy. You'll get a URL like `https://stockwise-yourname.vercel.app` — that's your app.

### 4. (Optional) Lock down CORS

Back in Render, set `CORS_ORIGIN` to your Vercel URL from step 3 and redeploy. This makes
the backend only accept requests from your frontend's origin instead of any origin — worth
doing if you ever share the link. Get the value exactly right: full origin, protocol
included, no trailing slash:

```
https://stockwise-yourname.vercel.app
```

Vercel also generates a new "preview" URL (a random hash, e.g.
`stockwise-abc123-yourname.vercel.app`) on every push, separate from the stable production
URL above — the backend always allows those too automatically (matched by project name
pattern), so opening a preview link won't get blocked just because `CORS_ORIGIN` only names
production.

A missing `https://` or a trailing slash on `CORS_ORIGIN` will make every request fail with
a CORS error in the browser console ("Failed to fetch" on the page) even though the backend
itself is up and healthy — check this env var first if that happens.

## Notes / limitations

- No authentication — anyone with the URL can view/edit your watchlist, portfolio, and
  alerts. Fine as long as you don't share the link.
- See "Why two market-data providers" above for why fundamentals use a separate API from
  quotes/charts, and the free-tier limits/caching for both.
- FMP's free tier restricts `/quote` and `/ratios-ttm` to a set of symbols (confirmed via
  their own "not available under your current subscription" error) — most common large-caps
  work fine (AAPL, MSFT, GOOGL, TSLA, NVDA, META, AMZN, COIN, NFLX, PLTR all verified), but a
  few (IBM, RDDT, SNOW in testing) don't. Price and chart are unaffected either way; only the
  fundamentals stat cards fall back to "—" for a restricted symbol.
