// Atlens analysis proxy — a Cloudflare Worker that holds the Groq API key and
// turns a repository context into a structured analysis. The browser never sees
// the key. Deploy:
//   cd worker && npx wrangler secret put GROQ_API_KEY && npx wrangler deploy

const MODEL = 'llama-3.3-70b-versatile'

// ── Public API ──────────────────────────────────────────────────────────────

const API_SYSTEM_PROMPT = `You analyze GitHub repositories and describe what they do concisely.
Return a JSON object with a single "purpose" field: 1-2 sentences describing what this project does, what it produces or outputs, and who it is for. Be specific, not generic.`

const API_USER_TEMPLATE = (context) =>
  `${context}\n\nReturn JSON with a single "purpose" field describing this repository.`

const API_KEY_FILES = [
  'README.md', 'README.rst', 'README.txt',
  'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'requirements.txt',
]
const MAX_API_CONTEXT = 5000

function parseRepo(input) {
  const trimmed = (input ?? '').trim().replace(/\.git$/, '').replace(/\/$/, '')
  const m = trimmed.match(/(?:https?:\/\/github\.com\/|github\.com\/|^)([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/)
  if (!m) return null
  return { owner: m[1], repo: m[2] }
}

async function fetchRepoContext(owner, repo, githubToken) {
  const token = (githubToken ?? '').trim()
  const ghHeaders = { Accept: 'application/vnd.github+json', 'User-Agent': 'atlens-proxy' }
  if (token) ghHeaders['Authorization'] = `Bearer ${token}`

  const metaRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: ghHeaders })
  if (metaRes.status === 404) throw Object.assign(new Error('Repository not found or is private.'), { status: 404 })
  if (metaRes.status === 403 || metaRes.status === 429) {
    const body = await metaRes.json().catch(() => ({}))
    console.error('[atlens/api] GitHub 403/429:', JSON.stringify(body), 'authenticated:', !!token)
    const msg = body?.message ?? ''
    if (msg.toLowerCase().includes('rate limit')) throw Object.assign(new Error('GitHub rate limit reached. Try again in a moment.'), { status: 429 })
    throw Object.assign(new Error(`GitHub error: ${msg || metaRes.status}`), { status: 403 })
  }
  if (!metaRes.ok) throw Object.assign(new Error(`GitHub error (${metaRes.status}).`), { status: 502 })

  const meta = await metaRes.json()
  const branch = meta.default_branch ?? 'main'

  let context = `Repository: ${owner}/${repo}\n`
  if (meta.description) context += `Description: ${meta.description}\n`
  context += '\n'

  for (const filename of API_KEY_FILES) {
    if (context.length >= MAX_API_CONTEXT) break
    try {
      const res = await fetch(
        `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filename}`,
      )
      if (!res.ok) continue
      const text = await res.text()
      context += `=== ${filename} ===\n${text.slice(0, 2000)}\n\n`
    } catch { /* skip missing files */ }
  }

  return context.slice(0, MAX_API_CONTEXT)
}

// ── App endpoints ───────────────────────────────────────────────────────────

const SUMMARIZE_SYSTEM_PROMPT = `You are profiling a GitHub developer based on their public repositories.
You will receive a list of their repositories and a brief description of what each one does.
Return a JSON object with a single "summary" field containing 2-4 sentences that concretely describe what kind of coder this person is, their interests, their typical project types, and their apparent strengths — inferred from what they actually build. Be specific and concrete, not generic.`

const SUMMARIZE_USER_TEMPLATE = (username, repos) =>
  `GitHub user: ${username}\n\nTheir repositories:\n${repos.map((r, i) => `${i + 1}. ${r.name}: ${r.purpose}`).join('\n')}\n\nReturn a JSON object with a "summary" field describing this developer.`

const SYSTEM_PROMPT = `You are a senior software engineer analyzing a GitHub repository.
You will be given the contents of key files from a repository.
Your task is to produce a structured analysis in valid JSON format.

RULES:
- Base your analysis ONLY on what is present in the provided files.
- Do not invent features, technologies, or capabilities not evidenced in the code.
- Be concise and precise. Use developer-appropriate language.
- For "purpose", describe concretely WHAT the project does and what it produces or outputs — not just its tech stack.
- If a field cannot be determined from the provided context, use null (or an empty array) for that field.`

const USER_TEMPLATE = (repoName, context) => `Repository: ${repoName}

${context}

---

Analyze the repository above and return a JSON object with EXACTLY this structure:

{
  "repoName": "string — the repository name",
  "purpose": "string — 1-2 sentences describing concretely what this project does and what it outputs/produces",
  "techStack": {
    "languages": ["array of programming languages detected"],
    "frameworks": ["array of frameworks/libraries"],
    "tools": ["array of build tools, linters, testing frameworks, CI/CD, etc."]
  },
  "architecture": "string — 2-4 sentences on the high-level architecture and how the main pieces fit together",
  "entryPoints": ["array of file paths that are the main entry points"],
  "keyFiles": [{ "path": "string", "role": "string — what this file does in 1 sentence" }],
  "setupInstructions": "string — how to install and run the project, or null if not determinable",
  "openQuestions": ["array of 2-4 things that are unclear or worth investigating further"]
}`

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function corsHeaders(origin, env) {
  const allow = allowedOrigins(env)
  const allowed = allow.length === 0 || (origin && allow.includes(origin))
  return {
    'Access-Control-Allow-Origin': allowed ? origin || '*' : allow[0] || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  }
}

/** True if this request's Origin is permitted (when an allowlist is configured). */
function originAllowed(origin, env) {
  const allow = allowedOrigins(env)
  if (allow.length === 0) return true // no allowlist → open
  return Boolean(origin) && allow.includes(origin)
}

/**
 * Hard daily ceiling on model calls, tracked in Workers KV. Returns false once
 * the day's budget is spent. KV is eventually consistent, so a small overshoot
 * is possible under concurrent bursts — fine for protecting a quota. Skipped if
 * no KV namespace is bound (local dev / tests).
 */
async function withinGitHubHourlyCap(env) {
  if (!env.USAGE_KV) return true
  const key = `github:${new Date().toISOString().slice(0, 13)}` // UTC hour e.g. "2025-06-15T14"
  const current = parseInt((await env.USAGE_KV.get(key)) ?? '0', 10)
  if (current >= 4950) return false
  await env.USAGE_KV.put(key, String(current + 1), { expirationTtl: 7200 })
  return true
}

async function withinDailyCap(env) {
  if (!env.USAGE_KV) return true
  const limit = parseInt(env.DAILY_LIMIT ?? '1000', 10)
  const key = `count:${new Date().toISOString().slice(0, 10)}` // UTC day
  const current = parseInt((await env.USAGE_KV.get(key)) ?? '0', 10)
  if (current >= limit) return false
  // Expire two days out so yesterday's counters clean themselves up.
  await env.USAGE_KV.put(key, String(current + 1), { expirationTtl: 172800 })
  return true
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin')
    const cors = corsHeaders(origin, env)
    const pathname = new URL(request.url).pathname
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (request.method !== 'POST') return json({ ok: false, message: 'Method not allowed.' }, 405, cors)

    // ── Public API: open to any origin, own stricter rate limit ─────────────
    if (pathname === '/api') {
      const apiCors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }

      if (env.API_LIMITER) {
        const { success } = await env.API_LIMITER.limit({ key: ip })
        if (!success) return json({ ok: false, message: 'Rate limit exceeded. Max 5 requests per minute per IP.' }, 429, apiCors)
      }
      if (!env.GROQ_API_KEY) return json({ ok: false, message: 'Server misconfigured.' }, 500, apiCors)
      if (!(await withinDailyCap(env))) return json({ ok: false, message: 'Daily limit reached. Try again tomorrow.' }, 429, apiCors)

      let repoInput
      try {
        ({ repo: repoInput } = await request.json())
      } catch {
        return json({ ok: false, message: 'Invalid request body.' }, 400, apiCors)
      }

      const parsed = parseRepo(repoInput)
      if (!parsed) return json({ ok: false, message: 'Invalid repo. Use "owner/repo" or a full GitHub URL.' }, 400, apiCors)

      const { owner, repo } = parsed
      if (!(await withinGitHubHourlyCap(env))) {
        return json({ ok: false, message: 'GitHub API hourly limit reached. Try again next hour.' }, 429, apiCors)
      }

      let context
      try {
        context = await fetchRepoContext(owner, repo, env.GITHUB_TOKEN)
      } catch (err) {
        return json({ ok: false, message: err.message ?? 'Could not fetch repository.' }, err.status ?? 502, apiCors)
      }

      let aRes
      try {
        aRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GROQ_API_KEY}` },
          body: JSON.stringify({
            model: MODEL,
            temperature: 0.2,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: API_SYSTEM_PROMPT },
              { role: 'user', content: API_USER_TEMPLATE(context) },
            ],
          }),
        })
      } catch {
        return json({ ok: false, message: 'Could not reach the analysis service.' }, 502, apiCors)
      }

      if (!aRes.ok) {
        const detail = await aRes.text().catch(() => '')
        console.error(`[atlens/api] Groq ${aRes.status}:`, detail)
        if (aRes.status === 429) return json({ ok: false, message: 'Rate limit reached. Try again in a moment.' }, 503, apiCors)
        return json({ ok: false, message: `Analysis service error (${aRes.status}).` }, 502, apiCors)
      }

      const aData = await aRes.json()
      const aText = aData?.choices?.[0]?.message?.content
      if (!aText) return json({ ok: false, message: 'Empty response from analysis service.' }, 502, apiCors)

      let result
      try {
        result = JSON.parse(aText)
      } catch {
        return json({ ok: false, message: 'Analysis service returned malformed JSON.' }, 502, apiCors)
      }

      return json({ ok: true, repo: `${owner}/${repo}`, purpose: result.purpose ?? '' }, 200, apiCors)
    }

    // ── App endpoints: gated by allowed origin ───────────────────────────────
    if (!originAllowed(origin, env)) return json({ ok: false, message: 'Origin not allowed.' }, 403, cors)

    if (env.IP_LIMITER) {
      const { success } = await env.IP_LIMITER.limit({ key: ip })
      if (!success) return json({ ok: false, message: 'Too many requests — please slow down and try again in a minute.' }, 429, cors)
    }
    if (env.GLOBAL_LIMITER) {
      const { success } = await env.GLOBAL_LIMITER.limit({ key: 'global' })
      if (!success) return json({ ok: false, message: 'The service is busy right now. Please try again shortly.' }, 429, cors)
    }

    if (!env.GROQ_API_KEY) return json({ ok: false, message: 'Server is missing GROQ_API_KEY.' }, 500, cors)

    if (pathname === '/summarize') {
      let username, repos
      try {
        ({ username, repos } = await request.json())
      } catch {
        return json({ ok: false, message: 'Invalid request body.' }, 400, cors)
      }
      if (!username || !Array.isArray(repos) || repos.length === 0) {
        return json({ ok: false, message: 'username and repos are required.' }, 400, cors)
      }

      if (!(await withinDailyCap(env))) {
        return json({ ok: false, message: 'Daily analysis limit reached. Please try again tomorrow.' }, 429, cors)
      }

      const groqBody = {
        model: MODEL,
        temperature: 0.4,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SUMMARIZE_SYSTEM_PROMPT },
          { role: 'user', content: SUMMARIZE_USER_TEMPLATE(username, repos) },
        ],
      }

      let sRes
      try {
        sRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GROQ_API_KEY}` },
          body: JSON.stringify(groqBody),
        })
      } catch (err) {
        console.error('[atlens] fetch to Groq threw:', err)
        return json({ ok: false, message: 'Could not reach the analysis service.' }, 502, cors)
      }

      if (!sRes.ok) {
        const detail = await sRes.text().catch(() => '')
        console.error(`[atlens] Groq ${sRes.status}:`, detail)
        if (sRes.status === 429) {
          return json({ ok: false, message: 'Rate limit reached. Wait a moment and retry.' }, 503, cors)
        }
        return json({ ok: false, message: `Analysis service error (${sRes.status}).` }, 502, cors)
      }

      const sData = await sRes.json()
      const sText = sData?.choices?.[0]?.message?.content
      if (!sText) {
        console.error('[atlens] Empty Groq response:', JSON.stringify(sData).slice(0, 500))
        return json({ ok: false, message: 'Empty response from the analysis service.' }, 502, cors)
      }

      let sResult
      try {
        sResult = JSON.parse(sText)
      } catch {
        return json({ ok: false, message: 'Analysis service returned malformed JSON.' }, 502, cors)
      }

      return json({ ok: true, summary: sResult.summary ?? '' }, 200, cors)
    }

    // Hard daily ceiling — checked here so only valid, model-bound requests count.
    if (!(await withinDailyCap(env))) {
      return json({ ok: false, message: 'Daily analysis limit reached. Please try again tomorrow.' }, 429, cors)
    }

    let repoName, context
    try {
      ({ repoName, context } = await request.json())
    } catch {
      return json({ ok: false, message: 'Invalid request body.' }, 400, cors)
    }
    if (!repoName || !context) return json({ ok: false, message: 'repoName and context are required.' }, 400, cors)

    // Groq is OpenAI-compatible. response_format json_object forces valid JSON;
    // the schema is described in the prompt (the word "JSON" must appear there).
    const groqBody = {
      model: MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: USER_TEMPLATE(repoName, context) },
      ],
    }

    let res
    try {
      res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: JSON.stringify(groqBody),
      })
    } catch (err) {
      console.error('[atlens] fetch to Groq threw:', err)
      return json({ ok: false, message: 'Could not reach the analysis service.' }, 502, cors)
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`[atlens] Groq ${res.status}:`, detail)
      if (res.status === 429) {
        return json(
          { ok: false, message: 'Rate limit reached. Wait a moment and retry — if it keeps happening you may have hit the daily free-tier quota.' },
          503,
          cors,
        )
      }
      return json({ ok: false, message: `Analysis service error (${res.status}). ${detail.slice(0, 300)}` }, 502, cors)
    }

    const data = await res.json()
    const text = data?.choices?.[0]?.message?.content
    if (!text) {
      console.error('[atlens] Empty Groq response:', JSON.stringify(data).slice(0, 500))
      return json({ ok: false, message: 'Empty response from the analysis service.' }, 502, cors)
    }

    let analysis
    try {
      analysis = JSON.parse(text)
    } catch {
      return json({ ok: false, message: 'Analysis service returned malformed JSON.' }, 502, cors)
    }

    return json({ ok: true, repoName, analysis }, 200, cors)
  },
}
