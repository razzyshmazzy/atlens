// Atlens analysis proxy — a Cloudflare Worker that holds the Groq API key and
// turns a repository context into a structured analysis. The browser never sees
// the key. Deploy:
//   cd worker && npx wrangler secret put GROQ_API_KEY && npx wrangler deploy

const MODEL = 'llama-3.3-70b-versatile'

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

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (request.method !== 'POST') return json({ ok: false, message: 'Method not allowed.' }, 405, cors)

    // Server-side origin gate: reject callers outside the allowlist (blocks
    // cross-site browser abuse, not just CORS-denies it).
    if (!originAllowed(origin, env)) return json({ ok: false, message: 'Origin not allowed.' }, 403, cors)

    // Rate limiting: per-IP first (stops one source hammering), then a global
    // cap (protects the shared free-tier quota from bursts).
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    if (env.IP_LIMITER) {
      const { success } = await env.IP_LIMITER.limit({ key: ip })
      if (!success) return json({ ok: false, message: 'Too many requests — please slow down and try again in a minute.' }, 429, cors)
    }
    if (env.GLOBAL_LIMITER) {
      const { success } = await env.GLOBAL_LIMITER.limit({ key: 'global' })
      if (!success) return json({ ok: false, message: 'The service is busy right now. Please try again shortly.' }, 429, cors)
    }

    if (!env.GROQ_API_KEY) return json({ ok: false, message: 'Server is missing GROQ_API_KEY.' }, 500, cors)

    const pathname = new URL(request.url).pathname

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
