# Stockwise

A stock analysis app: live quotes and fundamentals, a portfolio tracker, a watchlist, and
price/volume alerts. Backend is a small Express API (Yahoo Finance, no API key needed);
frontend is React (Vite).

## Run it locally

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

Your watchlist, portfolio, and alerts are stored in `backend/*.json` files (gitignored) —
they persist across restarts as long as those files stick around on the machine running
the backend.

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
3. It'll ask you to fill in the `CORS_ORIGIN` env var — leave it blank for now (you'll set
   it after step 3, once you know your Vercel URL). You can also just leave it unset
   permanently; the backend defaults to allowing any origin, which is fine for personal use.
4. Deploy. Note the URL Render gives you, e.g. `https://stockwise-backend.onrender.com`.

**Free tier note:** the free plan spins the service down after ~15 minutes of no traffic.
The next request wakes it up but takes 30–60 seconds. Fine for personal use; upgrade to a
paid instance (~$7/mo) if that delay bothers you.

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

## Notes / limitations

- Watchlist/portfolio/alerts data lives in JSON files on the backend's disk. Render's free
  tier disk is not guaranteed to persist across redeploys (pushing new code can reset it).
  Fine for casual personal use; if you want data to reliably survive redeploys, that'd mean
  swapping the JSON files for a real database (e.g. Render's free Postgres) — ask if you
  want that done.
- No authentication — anyone with the URL can view/edit your watchlist, portfolio, and
  alerts. Fine as long as you don't share the link.
