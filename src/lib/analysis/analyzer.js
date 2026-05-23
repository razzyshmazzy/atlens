import { pipeline, env } from '@huggingface/transformers'

// Don't look for model files on the local filesystem — always fetch from the
// HuggingFace Hub. (useBrowserCache already defaults to true in browsers, which
// caches the downloaded weights so the model is only fetched once per visitor.)
env.allowLocalModels = false

// Instruction-tuned text2text model. Unlike a news summarizer, it can SYNTHESIZE
// a description from structured evidence (manifest descriptions, API clients,
// routes, module names) rather than just rephrasing a README — which is often
// boilerplate. ~250MB quantized; runs client-side via WASM/WebGPU.
const MODEL = 'Xenova/LaMini-Flan-T5-248M'

let _generator = null
async function getGenerator() {
  if (!_generator) {
    _generator = await pipeline('text2text-generation', MODEL)
  }
  return _generator
}

/** Kick off the model download/load early (e.g. when the page mounts). */
export async function preloadModel() {
  try {
    await getGenerator()
  } catch {
    // Swallow — analyzeRepo falls back to a templated description if loading fails.
  }
}

async function generate(prompt, maxNewTokens = 80) {
  const gen = await getGenerator()
  const [out] = await gen(prompt, {
    max_new_tokens: maxNewTokens,
    do_sample: false,
    repetition_penalty: 1.3,
  })
  return (out?.generated_text ?? '').trim()
}

// GitHub paths use '/'; these helpers avoid node:path in the browser.
const basename = (p) => p.split('/').pop()
const extname = (p) => {
  const b = basename(p)
  const i = b.lastIndexOf('.')
  return i <= 0 ? '' : b.slice(i).toLowerCase()
}
function findFile(files, predicate) {
  return files.find((f) => !f.skipped && f.content && predicate(f))
}

/** Turn a camelCase / kebab / snake identifier into Title Case words. */
function humanize(s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/Pdf/g, 'PDF')
    .replace(/Api/g, 'API')
    .trim()
}

// ---------------------------------------------------------------------------
// Tech stack
// ---------------------------------------------------------------------------

const LANG_BY_EXT = {
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.py': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust',
  '.java': 'Java', '.kt': 'Kotlin', '.cs': 'C#',
  '.cpp': 'C++', '.cc': 'C++', '.cxx': 'C++', '.c': 'C', '.h': 'C/C++', '.hpp': 'C++',
  '.php': 'PHP', '.swift': 'Swift', '.scala': 'Scala', '.sh': 'Shell', '.bash': 'Shell',
  '.css': 'CSS', '.scss': 'SCSS', '.sass': 'SCSS', '.less': 'Less',
  '.html': 'HTML', '.vue': 'Vue', '.svelte': 'Svelte',
  '.sql': 'SQL', '.lua': 'Lua', '.dart': 'Dart', '.ex': 'Elixir', '.exs': 'Elixir',
}

const KNOWN_FRAMEWORKS = {
  react: 'React', 'react-dom': 'React', next: 'Next.js', vue: 'Vue', nuxt: 'Nuxt',
  svelte: 'Svelte', '@angular/core': 'Angular', solid: 'SolidJS', preact: 'Preact',
  express: 'Express', fastify: 'Fastify', koa: 'Koa', '@nestjs/core': 'NestJS',
  'react-router-dom': 'React Router', redux: 'Redux', zustand: 'Zustand',
  tailwindcss: 'Tailwind CSS', '@radix-ui/react-slot': 'Radix UI',
  axios: 'axios', motion: 'Motion', 'framer-motion': 'Framer Motion',
  django: 'Django', flask: 'Flask', fastapi: 'FastAPI', numpy: 'NumPy',
  pandas: 'pandas', torch: 'PyTorch', tensorflow: 'TensorFlow',
  rails: 'Rails', sinatra: 'Sinatra', gin: 'Gin', actix: 'Actix',
  '@huggingface/transformers': 'Transformers.js',
}

const KNOWN_TOOLS = {
  vite: 'Vite', webpack: 'webpack', rollup: 'Rollup', esbuild: 'esbuild', parcel: 'Parcel',
  eslint: 'ESLint', prettier: 'Prettier', typescript: 'TypeScript',
  jest: 'Jest', vitest: 'Vitest', mocha: 'Mocha', cypress: 'Cypress', playwright: 'Playwright',
  nodemon: 'nodemon', concurrently: 'concurrently', 'gh-pages': 'gh-pages',
  postcss: 'PostCSS', autoprefixer: 'Autoprefixer', babel: 'Babel', '@babel/core': 'Babel',
  winston: 'Winston', 'node-cache': 'node-cache', 'express-rate-limit': 'rate limiting',
  dotenv: 'dotenv', cors: 'CORS',
  pytest: 'pytest', black: 'Black', ruff: 'Ruff', poetry: 'Poetry',
}

/** Parse every package.json in the repo (monorepos / client+server splits). */
function collectPackageJsons(files) {
  const pkgs = []
  for (const f of files) {
    if (f.skipped || !f.content || basename(f.path) !== 'package.json') continue
    try {
      pkgs.push(JSON.parse(f.content))
    } catch {
      /* ignore malformed */
    }
  }
  return pkgs
}

function detectLanguages(files) {
  const counts = {}
  for (const f of files) {
    const lang = LANG_BY_EXT[extname(f.path)]
    if (lang) counts[lang] = (counts[lang] ?? 0) + 1
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([lang]) => lang)
}

function detectStack(files, pkgs) {
  const frameworks = new Set()
  const tools = new Set()

  for (const pkg of pkgs) {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    for (const name of Object.keys(deps)) {
      if (KNOWN_FRAMEWORKS[name]) frameworks.add(KNOWN_FRAMEWORKS[name])
      if (KNOWN_TOOLS[name]) tools.add(KNOWN_TOOLS[name])
    }
  }

  const reqs = findFile(files, (f) => basename(f.path) === 'requirements.txt')
  if (reqs) {
    for (const line of reqs.content.split('\n')) {
      const name = line.split(/[=<>~![ ]/)[0].trim().toLowerCase()
      if (KNOWN_FRAMEWORKS[name]) frameworks.add(KNOWN_FRAMEWORKS[name])
      if (KNOWN_TOOLS[name]) tools.add(KNOWN_TOOLS[name])
    }
  }

  const has = (name) => files.some((f) => basename(f.path).toLowerCase() === name)
  if (files.some((f) => /eslint\.config\.|\.eslintrc/i.test(basename(f.path)))) tools.add('ESLint')
  if (files.some((f) => /tailwind\.config\./i.test(basename(f.path)))) tools.add('Tailwind CSS')
  if (files.some((f) => /vite\.config\./i.test(basename(f.path)))) tools.add('Vite')
  if (has('dockerfile') || has('docker-compose.yml') || has('docker-compose.yaml')) tools.add('Docker')
  if (has('makefile')) tools.add('Make')
  if (files.some((f) => f.path.includes('.github/workflows/'))) tools.add('GitHub Actions')

  return { frameworks: [...frameworks], tools: [...tools] }
}

// ---------------------------------------------------------------------------
// Evidence extraction — the raw material the model reasons over
// ---------------------------------------------------------------------------

const README_BOILERPLATE = [
  /this template provides a minimal setup to get react working in vite/i,
  /getting started with create react app/i,
  /npm create vite/i,
  /this is a \[next\.js\]\(https:\/\/nextjs\.org\) project bootstrapped/i,
]

/** README content if it actually describes the project (not a starter template). */
function meaningfulReadme(files) {
  const readme = findFile(files, (f) => /^readme/i.test(basename(f.path)))
  if (!readme) return null
  if (README_BOILERPLATE.some((re) => re.test(readme.content))) return null
  return readme.content
}

/** External integrations from service client files named like fooClient.js. */
function detectApiClients(files) {
  return [
    ...new Set(
      files
        .filter((f) => !f.skipped && /(^|\/)services\//.test(f.path) && /client\.(jsx?|tsx?)$/i.test(basename(f.path)))
        .map((f) => humanize(basename(f.path).replace(/Client\.(jsx?|tsx?)$/i, ''))),
    ),
  ]
}

/** HTTP route mount points from express `app.use('/...', ...)`. */
function detectRoutes(files) {
  const routes = new Set()
  for (const f of files) {
    if (f.skipped || !f.content) continue
    for (const m of f.content.matchAll(/app\.use\(\s*['"`]\/(?:api\/)?([a-z0-9_-]+)['"`]/gi)) {
      routes.add(m[1])
    }
  }
  return [...routes]
}

const BORING_MODULE = /^(index|main|app|client|server|config|utils?|types|constants|errorHandler|logger|cors|rateLimiter|middleware|setup|vite|eslint)/i
const FEATURE_DIR = /(^|\/)(pages|views|screens|components|features|services|controllers|handlers|models)\//

/**
 * Distinctive feature/UI module names — the main signal for frontend apps that
 * have no package.json description, API clients, or server routes.
 */
function detectModules(files) {
  return [
    ...new Set(
      files
        .filter((f) => !f.skipped && /\.(jsx?|tsx?)$/i.test(f.path) && FEATURE_DIR.test(f.path) && !/\/ui\//.test(f.path))
        .map((f) => basename(f.path).replace(/\.(jsx?|tsx?)$/i, ''))
        .filter((s) => !BORING_MODULE.test(s) && !/Client$/.test(s))
        .map(humanize),
    ),
  ].slice(0, 10)
}

/** Gather the raw signals used to build prompts and deterministic fallbacks. */
function buildEvidence(files, pkgs) {
  return {
    descriptions: [...new Set(pkgs.map((p) => p.description).filter(Boolean))],
    clients: detectApiClients(files),
    routes: detectRoutes(files),
    modules: detectModules(files),
  }
}

// ---------------------------------------------------------------------------
// Prose generation
// ---------------------------------------------------------------------------

function cleanReadme(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Keep the first 1-2 *complete* sentences and tidy model filler. */
function tidyPurpose(text) {
  let t = text
    .replace(/\s+/g, ' ')
    .replace(/^the software repository\b/i, 'This project')
    .replace(/^this (software )?repository\b/i, 'This project')
    .trim()
  // Only keep sentences the model actually finished (drops truncated tails).
  const complete = t.match(/[^.!?]+[.!?]+/g)
  if (complete) t = complete.slice(0, 2).join(' ').trim()
  // Drop a trailing mechanical "It includes/uses notable modules ..." clause.
  t = t.replace(/\s*It (includes|uses|features) notable modules[^.!?]*[.!?]?$/i, '').trim()
  return t.slice(0, 320)
}

/** Strong evidence string for the purpose prompt (the signals the model handles well). */
function purposeEvidence(evidence) {
  return (
    (evidence.descriptions.length ? `Stated description: ${evidence.descriptions.join('; ')}. ` : '') +
    (evidence.clients.length
      ? `Integrates ${evidence.clients.length} external API client${evidence.clients.length > 1 ? 's' : ''}: ${evidence.clients.join(', ')}. `
      : '') +
    (evidence.routes.length ? `Exposes endpoints for: ${evidence.routes.join(', ')}. ` : '')
  ).trim()
}

const SPA_FRAMEWORKS = ['React', 'Vue', 'Svelte', 'Angular', 'SolidJS', 'Preact', 'Next.js', 'Nuxt']
const BACKEND_FRAMEWORKS = ['Express', 'Fastify', 'Koa', 'NestJS', 'Django', 'Flask', 'FastAPI', 'Rails']

/**
 * Honest, deterministic description for repos with no stated purpose anywhere
 * (no manifest description, no README prose, no API surface). The model only
 * hallucinates generic filler from such thin input, so we state the facts.
 */
function describeFromStructure(languages, stack, evidence) {
  const lang = languages[0] ?? 'software'
  let kind = 'application'
  if (stack.frameworks.some((f) => SPA_FRAMEWORKS.includes(f))) kind = 'single-page web application'
  else if (stack.frameworks.some((f) => BACKEND_FRAMEWORKS.includes(f))) kind = 'backend service'
  let s = `A ${lang} ${kind}`
  if (stack.frameworks.length) s += ` built with ${stack.frameworks.slice(0, 4).join(', ')}`
  if (evidence.modules.length) s += `, whose main parts include ${evidence.modules.slice(0, 6).join(', ')}`
  return s + '.'
}

/** Deterministic one-liner from strong evidence; null if there's nothing to say. */
function fallbackPurpose(evidence) {
  if (evidence.descriptions.length) {
    let s = evidence.descriptions[0]
    if (evidence.clients.length) s += `, integrating ${evidence.clients.join(', ')}`
    return s.endsWith('.') ? s : s + '.'
  }
  if (evidence.clients.length) return `Integrates ${evidence.clients.join(', ')}.`
  return null
}

async function generatePurpose(files, languages, stack, evidence) {
  const readme = meaningfulReadme(files)
  const readmeExcerpt = readme ? cleanReadme(readme).slice(0, 800) : null
  const evidenceText = purposeEvidence(evidence)

  // No stated purpose anywhere → state the facts rather than let the model guess.
  if (!evidenceText && !readmeExcerpt) return describeFromStructure(languages, stack, evidence)

  const prompt =
    `You are summarizing a software repository for a developer. Using only the evidence below, ` +
    `write one clear sentence (max 35 words) describing what the project does and what it is for. ` +
    `Do not list file paths.\n\n` +
    `Evidence: ${evidenceText}` +
    (readmeExcerpt ? `\nREADME excerpt: ${readmeExcerpt}` : '') +
    `\n\nOne-sentence description:`

  try {
    const out = await generate(prompt, 64)
    return tidyPurpose(out) || fallbackPurpose(evidence) || describeFromStructure(languages, stack, evidence)
  } catch {
    return fallbackPurpose(evidence) || describeFromStructure(languages, stack, evidence)
  }
}

/**
 * Architecture is a factual, deterministic sentence — the model produced vague
 * filler here, whereas the structural facts (stack, layout, integrations) are
 * both reliable and more useful.
 */
function describeArchitecture(files, languages, stack, evidence) {
  const dirs = [...new Set(files.map((f) => f.path.split('/')[0]).filter((d) => d && !d.includes('.')))].slice(0, 10)
  const lead = languages[0] ? `A ${languages[0]} project` : 'A multi-language project'
  const parts = [stack.frameworks.length ? `${lead} built with ${stack.frameworks.slice(0, 5).join(', ')}` : lead]
  if (dirs.length) parts.push(`organized into top-level ${dirs.join(', ')}`)
  if (evidence.clients.length) {
    parts.push(`integrating ${evidence.clients.length} external API${evidence.clients.length > 1 ? 's' : ''} (${evidence.clients.join(', ')})`)
  }
  if (evidence.routes.length) parts.push(`with a backend exposing ${evidence.routes.join(', ')} endpoints`)
  return parts.join(', ') + '.'
}

// ---------------------------------------------------------------------------
// Structured field heuristics
// ---------------------------------------------------------------------------

const ENTRY_PATTERNS = [
  /^(index|main|app|server|client|entry)\.(jsx?|tsx?|py|go|rs|rb|php|java|cs)$/i,
  /^App\.(jsx?|tsx?)$/i,
  /^__main__\.py$/i,
]

function detectEntryPoints(files) {
  return files
    .filter((f) => !f.skipped && ENTRY_PATTERNS.some((re) => re.test(basename(f.path))))
    .map((f) => f.path)
    .sort((a, b) => a.split('/').length - b.split('/').length)
    .slice(0, 6)
}

function roleFor(p) {
  const b = basename(p).toLowerCase()
  if (/^readme/.test(b)) return 'Project documentation and overview'
  if (b === 'package.json') return 'Dependency manifest and npm scripts'
  if (b === 'requirements.txt' || b === 'pyproject.toml') return 'Python dependency manifest'
  if (b === 'cargo.toml') return 'Rust package manifest'
  if (b === 'go.mod') return 'Go module definition'
  if (/dockerfile/.test(b)) return 'Container build definition'
  if (/docker-compose/.test(b)) return 'Multi-container service definition'
  if (/^(vite|webpack|rollup)\.config\./.test(b)) return 'Build tool configuration'
  if (/eslint/.test(b)) return 'Linter configuration'
  if (/tailwind\.config/.test(b)) return 'Tailwind CSS configuration'
  if (/client\.(jsx?|tsx?)$/.test(b)) return 'External API client'
  if (/controller\.(jsx?|tsx?)$/.test(b)) return 'Request handler / controller'
  if (/^(main|index)\./.test(b)) return 'Application entry point'
  if (/^app\./.test(b)) return 'Root application component'
  if (/^server\./.test(b)) return 'Server entry point'
  return 'Source file'
}

function detectKeyFiles(files) {
  return files
    .filter((f) => !f.skipped && f.priority)
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length)
    .slice(0, 8)
    .map((f) => ({ path: f.path, role: roleFor(f.path) }))
}

function detectSetup(files, pkgs) {
  const pkg = pkgs.find((p) => p.scripts && Object.keys(p.scripts).length)
  if (pkg) {
    const scripts = Object.keys(pkg.scripts)
    const runScript = scripts.includes('dev') ? 'dev' : scripts.includes('start') ? 'start' : scripts[0]
    const parts = ['Install dependencies with `npm install`.']
    if (runScript) parts.push(`Start the app with \`npm run ${runScript}\`.`)
    if (scripts.includes('build')) parts.push('Build for production with `npm run build`.')
    return parts.join(' ')
  }
  if (findFile(files, (f) => basename(f.path) === 'requirements.txt')) {
    return 'Install dependencies with `pip install -r requirements.txt`, then run the main module.'
  }
  if (findFile(files, (f) => basename(f.path) === 'Cargo.toml')) {
    return 'Build and run with `cargo run` (or `cargo build --release`).'
  }
  if (findFile(files, (f) => basename(f.path) === 'go.mod')) {
    return 'Build and run with `go run .` (or `go build`).'
  }
  return null
}

function detectOpenQuestions(files) {
  const qs = []
  const hasTests = files.some((f) => /(\.test\.|\.spec\.|(^|\/)tests?\/|(^|\/)__tests__\/)/i.test('/' + f.path))
  if (!hasTests) qs.push('No test files were detected — how is correctness verified?')
  const hasCI = files.some((f) => f.path.includes('.github/workflows/'))
  if (!hasCI) qs.push('No CI configuration found — is there an automated build/test pipeline?')
  const hasEnvExample = files.some((f) => /\.env\.(example|sample)$/.test(basename(f.path)))
  const hasEnvUsage = files.some((f) => f.content && /process\.env|os\.environ|dotenv/i.test(f.content))
  if (hasEnvUsage && !hasEnvExample) qs.push('Environment variables are referenced but no .env.example documents them — what config is required?')
  qs.push('What are the primary runtime dependencies and external services this project relies on?')
  return qs.slice(0, 4)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze a repository in the browser: structured heuristics + a local
 * instruction-tuned transformer (Transformers.js) that synthesizes the prose
 * fields from extracted evidence.
 *
 * @param {string}   _repoContext  (unused — kept for call-site compatibility)
 * @param {string}   repoName
 * @param {object[]} files         FileEntry objects from github.fetchRepo()
 * @returns {Promise<object>}
 */
export async function analyzeRepo(_repoContext, repoName, files) {
  const pkgs = collectPackageJsons(files)
  const languages = detectLanguages(files)
  const stack = detectStack(files, pkgs)
  const evidence = buildEvidence(files, pkgs)

  const purpose = await generatePurpose(files, languages, stack, evidence)
  const architecture = describeArchitecture(files, languages, stack, evidence)

  return {
    repoName,
    purpose,
    techStack: {
      languages,
      frameworks: stack.frameworks,
      tools: stack.tools,
    },
    architecture,
    entryPoints: detectEntryPoints(files),
    keyFiles: detectKeyFiles(files),
    setupInstructions: detectSetup(files, pkgs),
    openQuestions: detectOpenQuestions(files),
  }
}
