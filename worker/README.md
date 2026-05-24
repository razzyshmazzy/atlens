# Atlens proxy (Cloudflare Worker)

Holds the Groq API key and turns a repository context into structured analysis,
so the key never reaches the browser. The frontend (on GitHub Pages) POSTs
`{ repoName, context }` to `/analyze`; this Worker calls Groq (Llama 3.3 70B) and
returns `{ ok, repoName, analysis }`.

## One-time setup

1. Get a free Groq API key (no credit card required): https://console.groq.com/keys
2. Install Wrangler and log in (free Cloudflare account):
   ```bash
   cd worker
   npx wrangler login
   ```
3. Store the key as a secret (never commit it):
   ```bash
   npx wrangler secret put GROQ_API_KEY
   ```
4. Create the KV namespace for the daily-cap counter, then paste the printed id
   into `wrangler.toml` (`[[kv_namespaces]]` → `id`):
   ```bash
   npx wrangler kv namespace create USAGE
   ```
5. (Optional) edit `wrangler.toml` → `ALLOWED_ORIGINS` to lock the proxy to your
   site(s). When set, requests from other origins are rejected with 403. Leave it
   unset to allow any origin.

## Abuse protection

The Worker defends the shared free-tier quota four ways, all configured in
`wrangler.toml` (no extra services needed beyond the KV namespace):

- **Origin gate** — `ALLOWED_ORIGINS` rejects callers outside your site list (403).
- **Per-IP rate limit** — `IP_LIMITER`, default 8 requests/minute per IP (429).
- **Global rate limit** — `GLOBAL_LIMITER`, default 30 requests/minute total (429).
- **Hard daily cap** — `DAILY_LIMIT` (default 1000) counts Gemini calls per UTC day
  in Workers KV and returns 429 once spent. Set it below your Gemini free-tier
  quota. Counters auto-expire after two days.

Tune the rate-limit `limit` values in `wrangler.toml` (the `period` must be 10 or
60) and `DAILY_LIMIT` to taste. The per-minute limits are sliding windows that
throttle bursts; the daily cap is the hard ceiling on total spend.

## Deploy

```bash
cd worker
npx wrangler deploy
```

Wrangler prints the deployed URL, e.g. `https://atlens-proxy.<you>.workers.dev`.
Add that as the `VITE_API_URL` **Actions variable** in the GitHub repo
(Settings → Secrets and variables → Actions → Variables) so the Pages build
points at it. Re-run the Pages deploy.

## Local development

```bash
# worker/.dev.vars  (git-ignored)
echo 'GROQ_API_KEY=your-key-here' > worker/.dev.vars

cd worker && npx wrangler dev   # serves http://localhost:8787
```

In another terminal run the frontend (`npm run dev`). `src/services/api.js`
defaults to `http://localhost:8787` when `VITE_API_URL` is unset, so the two
connect automatically.
