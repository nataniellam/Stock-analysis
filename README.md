# Stockwise

A stock analysis app: live quotes and fundamentals, a portfolio tracker, a watchlist, and
price/volume alerts. Backend is a small Express API (Alpha Vantage for market data);
frontend is React (Vite).

## Run it locally

Market data requires a free Alpha Vantage API key (even for local dev) — sign up at
[alphavantage.co](https://www.alphavantage.co/support/#api-key) (just an email, instant),
then put it in `backend/.env` (copy `backend/.env.example`):

```
ALPHA_VANTAGE_API_KEY=your-key-here
```

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

**Alpha Vantage's free tier is capped at 25 requests/day, 5/min.** The backend caches
aggressively to make this workable — quotes for 30 minutes, charts/fundamentals for 24
hours — so prices refresh roughly every half hour rather than truly live, and repeated
polling (watchlist, portfolio, alerts) mostly hits the cache instead of the API. Checking
many different new symbols in a single day can still burn through the daily quota; when
that happens, requests return a clear "rate limit" error rather than failing silently.

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
   - `ALPHA_VANTAGE_API_KEY` — your key from [alphavantage.co](https://www.alphavantage.co/support/#api-key) (required — the backend can't fetch any market data without it).
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
the backend only accept requests from your frontend instead of any origin — worth doing if
you ever share the link.

**Get this value exactly right** — it must be the full origin, protocol included, no
trailing slash, and it must be your stable production URL, not a one-off preview deployment
URL (Vercel generates a new preview URL on every push; your production domain, shown at the
top of the project's Vercel dashboard, stays constant):

```
https://stockwise-yourname.vercel.app
```

A missing `https://`, a trailing slash, or a preview URL there will make every request fail
with a CORS error in the browser console ("Failed to fetch" on the page) even though the
backend itself is up and healthy — check this env var first if that happens.

## Notes / limitations

- No authentication — anyone with the URL can view/edit your watchlist, portfolio, and
  alerts. Fine as long as you don't share the link.
- See "Run it locally" above for the Alpha Vantage free-tier rate limit (25 requests/day)
  and how caching works around it.
