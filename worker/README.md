# Atlens proxy (Cloudflare Worker)

Holds the Groq API key and the GitHub token so neither reaches the browser. Two
endpoints, both POST-only:

- **`/api`** — public. Give it a repo, get back a structured analysis. Open to
  any origin, 5 requests/minute per IP.
- **`/summarize`** — used by the Atlens frontend. Gated by `ALLOWED_ORIGINS`.

Both call Groq (`openai/gpt-oss-120b`).

## Public API — `POST /api`

Base URL: `https://atlens-proxy.nzametto.workers.dev`

### Request

`Content-Type: application/json`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `repo` | string | yes | `"owner/repo"` or a full GitHub URL. Public repos only. |
| `fields` | string[] | no | Subset of fields to return. Omit for all of them. |

Valid `fields` values: `purpose`, `techStack`, `architecture`, `entryPoints`,
`keyFiles`, `setupInstructions`, `openQuestions`.

```bash
curl -X POST https://atlens-proxy.nzametto.workers.dev/api \
  -H 'Content-Type: application/json' \
  -d '{"repo": "octocat/Hello-World"}'
```

Only want two fields:

```bash
curl -X POST https://atlens-proxy.nzametto.workers.dev/api \
  -H 'Content-Type: application/json' \
  -d '{"repo": "https://github.com/octocat/Hello-World", "fields": ["purpose", "techStack"]}'
```

### Response

`200` with `ok: true`, the canonical `owner/repo`, and one key per requested
field. Any field the model could not determine is `null`.

```json
{
  "ok": true,
  "repo": "octocat/Hello-World",
  "purpose": "string — 1-2 sentences on what the project does",
  "techStack": {
    "languages": ["..."],
    "frameworks": ["..."],
    "tools": ["..."]
  },
  "architecture": "string — 2-4 sentences on how the pieces fit together",
  "entryPoints": ["path/to/main.js"],
  "keyFiles": [{ "path": "src/index.js", "role": "one sentence on its job" }],
  "setupInstructions": "string, or null if not determinable",
  "openQuestions": ["2-4 things worth investigating"]
}
```

### Errors

Every error is `{ "ok": false, "message": "..." }` with a matching status code.

| Status | Cause |
| --- | --- |
| `400` | Malformed JSON, bad `repo` format, or an unknown name in `fields`. |
| `404` | Repository not found, or it is private. |
| `405` | Any method other than `POST`. |
| `429` | Per-IP limit (5/min), GitHub hourly cap, or the daily analysis cap. |
| `500` | Worker is missing `GROQ_API_KEY`. |
| `502` | GitHub or Groq unreachable, or Groq returned malformed JSON. |

### Behaviour worth knowing

- **Caching.** Results are keyed on the repo's `pushed_at`. Repeat calls for a
  repo with no new commits return the cached analysis without spending a Groq
  call, so they come back much faster.
- **File selection.** At most 45 files are read, ranked by priority path, then
  primary language, then shallowest depth. Files over 100 KB, binaries, and
  common junk directories (`node_modules`, `dist`, lockfiles, images, …) are
  skipped. Large repos are analysed from a sample, not in full.
- **Quotas.** GitHub calls are capped at 4,950/hour and Groq calls at
  `DAILY_LIMIT` (default 1000) per UTC day, both counted in KV.

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
4. Store a GitHub token as a secret. It only lifts the API rate limit from 60 to
   5,000 requests/hour on public data, so it needs **no permissions at all** —
   a fine-grained PAT scoped to "Public repositories (read-only)" with every
   permission left at "No access", or a classic PAT with zero scopes checked.
   Never grant `repo`.
   ```bash
   npx wrangler secret put GITHUB_TOKEN
   ```
5. Create the KV namespace for the daily-cap counter, then paste the printed id
   into `wrangler.toml` (`[[kv_namespaces]]` → `id`). The id is account-specific,
   so a fresh Cloudflare account needs a fresh namespace:
   ```bash
   npx wrangler kv namespace create USAGE
   ```
6. (Optional) edit `wrangler.toml` → `ALLOWED_ORIGINS` to lock the proxy to your
   site(s). When set, requests from other origins are rejected with 403. Leave it
   unset to allow any origin. This gates `/summarize` only — `/api` is public by
   design and relies on its own per-IP limiter.

## Abuse protection

The Worker defends the shared free-tier quota five ways, all configured in
`wrangler.toml` (no extra services needed beyond the KV namespace):

- **Origin gate** — `ALLOWED_ORIGINS` rejects callers outside your site list (403).
  Applies to `/summarize`, not `/api`.
- **Per-IP rate limit** — `IP_LIMITER`, default 8 requests/minute per IP (429).
- **Global rate limit** — `GLOBAL_LIMITER`, default 30 requests/minute total (429).
- **Public API rate limit** — `API_LIMITER`, default 5 requests/minute per IP on
  `/api` (429).
- **Hard daily cap** — `DAILY_LIMIT` (default 1000) counts Groq calls per UTC day
  in Workers KV and returns 429 once spent. Set it below your Groq free-tier
  quota. Counters auto-expire after two days. A separate counter caps GitHub
  calls at 4,950/hour. Cached analyses bypass both.

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
# worker/.dev.vars  (git-ignored) — secrets are NOT shared with the deployed
# Worker, so both keys must be set here too or local requests will fail.
cat > worker/.dev.vars <<'EOF'
GROQ_API_KEY=your-key-here
GITHUB_TOKEN=your-token-here
EOF

cd worker && npx wrangler dev   # serves http://localhost:8787
```

In another terminal run the frontend (`npm run dev`). `src/services/api.js`
defaults to `http://localhost:8787` when `VITE_API_URL` is unset, so the two
connect automatically.
