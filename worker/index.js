// Atlens analysis proxy — a Cloudflare Worker that holds the Groq API key and
// turns a repository context into a structured analysis. The browser never sees
// the key. Deploy:
//   cd worker && npx wrangler secret put GROQ_API_KEY && npx wrangler deploy

const MODEL = 'llama-3.3-70b-versatile'

// ── Public API — full Atlens analysis with optional field filtering ───────────

const VALID_FIELDS = new Set([
  'purpose', 'techStack', 'architecture', 'entryPoints', 'keyFiles', 'setupInstructions', 'openQuestions',
])

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  '.cache', 'coverage', '.nyc_output', 'vendor', '.venv', 'venv',
  '.tox', 'target', 'out', '.gradle', '.idea', '.vscode',
])

const IGNORED_SUFFIXES = [
  '.min.js', '.min.css', '.map', '.lock',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.avif',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib',
  '.db', '.sqlite', '.sqlite3',
  '.pyc', '.pyo', '.class',
]

const IGNORED_FILENAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Pipfile.lock',
  'Gemfile.lock', 'poetry.lock', 'composer.lock',
])

const PRIORITY_FILENAMES = new Set([
  'README.md', 'README.rst', 'README.txt', 'README',
  'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod',
  'requirements.txt', 'Pipfile', 'Gemfile',
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  '.env.example', '.env.sample',
  'Makefile', 'CMakeLists.txt',
])

const PRIORITY_PATTERNS = [
  /^(index|main|app|server|client|entry)\.(jsx?|tsx?|py|go|rs|rb|php|java|cs)$/i,
  /^(index|main)\.html?$/i,
  /^App\.(jsx?|tsx?)$/i,
  /^__main__\.py$/i,
]

const LANGUAGE_FAMILIES = {
  web: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte', '.astro'],
  python: ['.py', '.pyi', '.pyx'],
  c: ['.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'],
  go: ['.go'],
  rust: ['.rs'],
  ruby: ['.rb', '.erb', '.rake'],
  php: ['.php'],
  jvm: ['.java', '.kt', '.kts', '.scala', '.groovy', '.clj'],
  csharp: ['.cs', '.fs', '.vb'],
  swift: ['.swift'],
  shell: ['.sh', '.bash', '.zsh', '.fish'],
  dart: ['.dart'],
  elixir: ['.ex', '.exs'],
}

const EXT_TO_FAMILY = new Map(
  Object.entries(LANGUAGE_FAMILIES).flatMap(([family, exts]) => exts.map(e => [e, family])),
)

const apiBasename = p => p.split('/').pop()

function isIgnoredPath(p, isDir) {
  const segments = p.split('/')
  if (segments.some(s => IGNORED_DIRS.has(s))) return true
  if (isDir) return false
  const base = apiBasename(p)
  if (IGNORED_FILENAMES.has(base)) return true
  if (IGNORED_SUFFIXES.some(suf => base.toLowerCase().endsWith(suf))) return true
  return false
}

function isPriorityPath(p) {
  const base = apiBasename(p)
  if (PRIORITY_FILENAMES.has(base)) return true
  if (PRIORITY_PATTERNS.some(re => re.test(base))) return true
  const parts = p.split('/')
  const srcIdx = parts.findIndex(s => ['src', 'lib', 'app', 'server', 'api'].includes(s))
  if (srcIdx !== -1 && parts.length - srcIdx <= 3) return true
  return false
}

function extOf(p) {
  const base = apiBasename(p)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

function familyOf(p) {
  return EXT_TO_FAMILY.get(extOf(p)) ?? null
}

function primaryFamilies(blobs) {
  const counts = new Map()
  let classified = 0
  for (const b of blobs) {
    const fam = familyOf(b.path)
    if (!fam) continue
    counts.set(fam, (counts.get(fam) ?? 0) + 1)
    classified++
  }
  if (classified === 0) return new Set()
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const primary = new Set()
  let cumulative = 0
  for (const [fam, n] of ranked) {
    primary.add(fam)
    cumulative += n
    if (cumulative / classified >= 0.8) break
  }
  return primary
}

async function pooled(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return results
}

const MAX_API_CONTEXT_CHARS = 18_000
const API_PRIORITY_LINES = 100
const API_SRC_LINES = 50
const API_OTHER_LINES = 25

function stripNoise(content) {
  return content
    .replace(/\n{3,}/g, '\n\n')
    .replace(
      /^\s*(\/\*[\s\S]*?\*\/|(?:\/\/.*\n)+|(?:#.*\n)+)/,
      block => (/copyright|licen[sc]e|spdx|permission is hereby granted/i.test(block) ? '' : block),
    )
    .trimStart()
}

function truncateLines(content, maxLines) {
  const lines = content.split('\n')
  if (lines.length <= maxLines) return content
  return `${lines.slice(0, maxLines).join('\n')}\n[... ${lines.length - maxLines} more lines not shown ...]`
}

function apiLineLimit(file) {
  const base = apiBasename(file.path)
  if (/readme/i.test(file.path) ||
    /^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|requirements\.txt|dockerfile|docker-compose\.ya?ml|makefile)$/i.test(base)) {
    return API_PRIORITY_LINES
  }
  return file.primaryLang ? API_SRC_LINES : API_OTHER_LINES
}

function buildFullContext(files) {
  const readable = files.filter(f => !f.skipped && f.content)
  const priority = readable.filter(f => f.priority)
  const nonPriority = readable.filter(f => !f.priority)
  nonPriority.sort((a, b) => {
    if (a.primaryLang !== b.primaryLang) return a.primaryLang ? -1 : 1
    const depth = a.path.split('/').length - b.path.split('/').length
    return depth !== 0 ? depth : a.path.localeCompare(b.path)
  })
  const ordered = [...priority, ...nonPriority]
  const skipped = files.filter(f => f.skipped)
  let context = `Repository contains ${files.length} analysed files (${skipped.length} skipped).\n\n`
  for (const file of ordered) {
    const block = `=== ${file.path} ===\n${truncateLines(stripNoise(file.content), apiLineLimit(file))}\n\n`
    if (context.length + block.length > MAX_API_CONTEXT_CHARS) break
    context += block
  }
  return context
}

function parseRepo(input) {
  const trimmed = (input ?? '').trim().replace(/\.git$/, '').replace(/\/$/, '')
  const m = trimmed.match(/(?:https?:\/\/github\.com\/|github\.com\/|^)([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/)
  if (!m) return null
  return { owner: m[1], repo: m[2] }
}

async function fetchFullRepo(owner, repo, githubToken) {
  const token = (githubToken ?? '').trim()
  const ghHeaders = { Accept: 'application/vnd.github+json', 'User-Agent': 'atlens-proxy' }
  if (token) ghHeaders['Authorization'] = `Bearer ${token}`

  const metaRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: ghHeaders })
  if (metaRes.status === 404) throw Object.assign(new Error('Repository not found or is private.'), { status: 404 })
  if (metaRes.status === 403 || metaRes.status === 429) {
    const body = await metaRes.json().catch(() => ({}))
    const msg = body?.message ?? ''
    if (msg.toLowerCase().includes('rate limit')) throw Object.assign(new Error('GitHub rate limit reached. Try again in a moment.'), { status: 429 })
    throw Object.assign(new Error(`GitHub error: ${msg || metaRes.status}`), { status: 403 })
  }
  if (!metaRes.ok) throw Object.assign(new Error(`GitHub error (${metaRes.status}).`), { status: 502 })

  const meta = await metaRes.json()
  const branch = meta.default_branch ?? 'main'

  const treeRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { headers: ghHeaders },
  )
  if (!treeRes.ok) throw Object.assign(new Error('Could not fetch repository tree.'), { status: 502 })
  const treeData = await treeRes.json()

  const blobs = []
  for (const entry of Array.isArray(treeData.tree) ? treeData.tree : []) {
    if (entry.type !== 'blob') continue
    if (isIgnoredPath(entry.path, false)) continue
    blobs.push({ path: entry.path, size: entry.size ?? 0 })
  }

  const primary = primaryFamilies(blobs)
  const isPrimaryLang = p => { const f = familyOf(p); return f !== null && primary.has(f) }
  const tierOf = x => (x.priority ? 0 : x.primaryLang ? 1 : 2)

  const ranked = blobs
    .map(b => ({ ...b, priority: isPriorityPath(b.path), primaryLang: isPrimaryLang(b.path) }))
    .sort((a, b) => {
      if (tierOf(a) !== tierOf(b)) return tierOf(a) - tierOf(b)
      const depth = a.path.split('/').length - b.path.split('/').length
      return depth !== 0 ? depth : a.path.localeCompare(b.path)
    })
  const selected = ranked.slice(0, 200)

  const files = await pooled(selected, 10, async b => {
    if (b.size > 100 * 1024) return { path: b.path, content: null, skipped: true, reason: 'too_large' }
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${b.path.split('/').map(encodeURIComponent).join('/')}`
    try {
      const res = await fetch(url)
      if (!res.ok) return { path: b.path, content: null, skipped: true, reason: 'read_error' }
      const content = await res.text()
      if (content.includes('\u0000')) return { path: b.path, content: null, skipped: true, reason: 'binary' }
      return { path: b.path, content, sizeBytes: b.size, skipped: false, priority: b.priority, primaryLang: b.primaryLang }
    } catch {
      return { path: b.path, content: null, skipped: true, reason: 'read_error' }
    }
  })

  return { files, repoName: `${owner}-${repo}` }
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
async function withinGitHubHourlyCap(env, count = 1) {
  if (!env.USAGE_KV) return true
  const key = `github:${new Date().toISOString().slice(0, 13)}` // UTC hour e.g. "2025-06-15T14"
  const current = parseInt((await env.USAGE_KV.get(key)) ?? '0', 10)
  if (current + count > 4950) return false
  await env.USAGE_KV.put(key, String(current + count), { expirationTtl: 7200 })
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

      let repoInput, fields
      try {
        ({ repo: repoInput, fields } = await request.json())
      } catch {
        return json({ ok: false, message: 'Invalid request body.' }, 400, apiCors)
      }

      const parsed = parseRepo(repoInput)
      if (!parsed) return json({ ok: false, message: 'Invalid repo. Use "owner/repo" or a full GitHub URL.' }, 400, apiCors)

      if (fields !== undefined) {
        if (!Array.isArray(fields) || fields.length === 0) {
          return json({ ok: false, message: '"fields" must be a non-empty array.' }, 400, apiCors)
        }
        const invalid = fields.filter(f => !VALID_FIELDS.has(f))
        if (invalid.length > 0) {
          return json({
            ok: false,
            message: `Unknown field(s): ${invalid.join(', ')}. Valid fields: ${[...VALID_FIELDS].join(', ')}`,
          }, 400, apiCors)
        }
      }

      const { owner, repo } = parsed
      // Full analysis makes 2 GitHub API calls: metadata + recursive tree
      if (!(await withinGitHubHourlyCap(env, 2))) {
        return json({ ok: false, message: 'GitHub API hourly limit reached. Try again next hour.' }, 429, apiCors)
      }

      let files, repoName
      try {
        ({ files, repoName } = await fetchFullRepo(owner, repo, env.GITHUB_TOKEN))
      } catch (err) {
        return json({ ok: false, message: err.message ?? 'Could not fetch repository.' }, err.status ?? 502, apiCors)
      }

      const context = buildFullContext(files)

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
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: USER_TEMPLATE(repoName, context) },
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

      let analysis
      try {
        analysis = JSON.parse(aText)
      } catch {
        return json({ ok: false, message: 'Analysis service returned malformed JSON.' }, 502, apiCors)
      }

      // Return only requested fields, or all fields if none specified
      const selectedFields = fields ?? [...VALID_FIELDS]
      const result = Object.fromEntries(selectedFields.map(f => [f, analysis[f] ?? null]))

      return json({ ok: true, repo: `${owner}/${repo}`, ...result }, 200, apiCors)
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
