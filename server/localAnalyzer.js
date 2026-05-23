import path from 'path'
import { pipeline, env } from '@huggingface/transformers'

// Cache downloaded models on disk so we only fetch them once.
env.cacheDir = path.resolve('.cache/transformers')

// A small distilled summarization model (~120 MB quantized). Trained on news
// summarization (CNN/DailyMail) but good enough to compress README prose into a
// one-liner. Runs locally on CPU — no API key, no network after the first load.
const SUMMARY_MODEL = 'Xenova/distilbart-cnn-6-6'

// Lazily-initialized singleton pipeline. The first call downloads + loads the
// model (slow); subsequent calls reuse it.
let _summarizer = null
async function getSummarizer() {
  if (!_summarizer) {
    console.log(`[localAnalyzer] loading summarization model ${SUMMARY_MODEL} (first run downloads it)...`)
    _summarizer = await pipeline('summarization', SUMMARY_MODEL)
    console.log('[localAnalyzer] model ready')
  }
  return _summarizer
}

/**
 * Eagerly load the model so the first /analyze request doesn't pay the cold-load
 * cost. Safe to call at server boot; errors are logged and swallowed so a model
 * download hiccup never crashes the server (analyzeRepo falls back at call time).
 */
export async function preloadModel() {
  try {
    await getSummarizer()
  } catch (err) {
    console.warn('[localAnalyzer] model preload failed (will retry on first request):', err.message)
  }
}

// ---------------------------------------------------------------------------
// Heuristic structured extraction (replaces the JSON the LLM used to produce)
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

// Map dependency names to a human-friendly framework/library label.
const KNOWN_FRAMEWORKS = {
  react: 'React', 'react-dom': 'React', next: 'Next.js', vue: 'Vue', nuxt: 'Nuxt',
  svelte: 'Svelte', '@angular/core': 'Angular', solid: 'SolidJS', preact: 'Preact',
  express: 'Express', fastify: 'Fastify', koa: 'Koa', '@nestjs/core': 'NestJS',
  'react-router-dom': 'React Router', redux: 'Redux', zustand: 'Zustand',
  tailwindcss: 'Tailwind CSS', '@radix-ui/react-slot': 'Radix UI',
  django: 'Django', flask: 'Flask', fastapi: 'FastAPI', numpy: 'NumPy',
  pandas: 'pandas', torch: 'PyTorch', tensorflow: 'TensorFlow',
  rails: 'Rails', sinatra: 'Sinatra', gin: 'Gin', actix: 'Actix',
  '@huggingface/transformers': 'Transformers.js',
}

// Map dependency names to a tooling label (build tools, linters, test runners).
const KNOWN_TOOLS = {
  vite: 'Vite', webpack: 'webpack', rollup: 'Rollup', esbuild: 'esbuild', parcel: 'Parcel',
  eslint: 'ESLint', prettier: 'Prettier', typescript: 'TypeScript',
  jest: 'Jest', vitest: 'Vitest', mocha: 'Mocha', cypress: 'Cypress', playwright: 'Playwright',
  nodemon: 'nodemon', concurrently: 'concurrently', 'gh-pages': 'gh-pages',
  postcss: 'PostCSS', autoprefixer: 'Autoprefixer', babel: 'Babel', '@babel/core': 'Babel',
  pytest: 'pytest', black: 'Black', ruff: 'Ruff', poetry: 'Poetry',
}

function findFile(files, predicate) {
  return files.find((f) => !f.skipped && f.content && predicate(f))
}

function basename(p) {
  return path.basename(p)
}

/** Detect programming languages by counting source files per extension. */
function detectLanguages(files) {
  const counts = {}
  for (const f of files) {
    const ext = path.extname(f.path).toLowerCase()
    const lang = LANG_BY_EXT[ext]
    if (lang) counts[lang] = (counts[lang] ?? 0) + 1
  }
  // Sort by frequency, keep meaningful ones.
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([lang]) => lang)
}

/** Read & parse package.json if present. */
function readPackageJson(files) {
  const pkgFile = findFile(files, (f) => basename(f.path) === 'package.json' && !f.path.includes(path.sep + 'node_modules' + path.sep))
  if (!pkgFile) return null
  try {
    return JSON.parse(pkgFile.content)
  } catch {
    return null
  }
}

/** Derive frameworks + tools from dependency manifests and config files. */
function detectStack(files) {
  const frameworks = new Set()
  const tools = new Set()

  const pkg = readPackageJson(files)
  if (pkg) {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    for (const name of Object.keys(deps)) {
      if (KNOWN_FRAMEWORKS[name]) frameworks.add(KNOWN_FRAMEWORKS[name])
      if (KNOWN_TOOLS[name]) tools.add(KNOWN_TOOLS[name])
    }
  }

  // Python / Rust / Go manifests → list declared dependencies as frameworks.
  const reqs = findFile(files, (f) => basename(f.path) === 'requirements.txt')
  if (reqs) {
    for (const line of reqs.content.split('\n')) {
      const name = line.split(/[=<>~!\[ ]/)[0].trim().toLowerCase()
      if (KNOWN_FRAMEWORKS[name]) frameworks.add(KNOWN_FRAMEWORKS[name])
      if (KNOWN_TOOLS[name]) tools.add(KNOWN_TOOLS[name])
    }
  }

  // Config-file presence → tooling.
  const has = (name) => files.some((f) => basename(f.path).toLowerCase() === name)
  if (files.some((f) => /eslint\.config\.|\.eslintrc/i.test(basename(f.path)))) tools.add('ESLint')
  if (files.some((f) => /tailwind\.config\./i.test(basename(f.path)))) tools.add('Tailwind CSS')
  if (files.some((f) => /vite\.config\./i.test(basename(f.path)))) tools.add('Vite')
  if (has('dockerfile') || has('docker-compose.yml') || has('docker-compose.yaml')) tools.add('Docker')
  if (has('makefile')) tools.add('Make')
  if (files.some((f) => /\.github\/workflows\//.test(f.path.split(path.sep).join('/')))) tools.add('GitHub Actions')

  return { frameworks: [...frameworks], tools: [...tools] }
}

const ENTRY_PATTERNS = [
  /^(index|main|app|server|client|entry)\.(jsx?|tsx?|py|go|rs|rb|php|java|cs)$/i,
  /^App\.(jsx?|tsx?)$/i,
  /^__main__\.py$/i,
]

/** Find likely entry-point files. */
function detectEntryPoints(files) {
  const matches = files
    .filter((f) => !f.skipped && ENTRY_PATTERNS.some((re) => re.test(basename(f.path))))
    .map((f) => f.path)
  // Prefer shallow paths (closer to the root / src root).
  return matches.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length).slice(0, 6)
}

/** Assign a one-line role to a known file. */
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
  if (/^(main|index)\./.test(b)) return 'Application entry point'
  if (/^app\./.test(b)) return 'Root application component'
  if (/^server\./.test(b)) return 'Server entry point'
  return 'Source file'
}

/** Pick the most informative files to surface as "key files". */
function detectKeyFiles(files) {
  const priority = files.filter((f) => !f.skipped && f.priority)
  // De-prioritize generic source files vs. named entry/config files.
  const ranked = priority.sort((a, b) => a.path.split(path.sep).length - b.path.split(path.sep).length)
  return ranked.slice(0, 8).map((f) => ({ path: f.path, role: roleFor(f.path) }))
}

/** Build setup instructions from package.json scripts or common manifests. */
function detectSetup(files) {
  const pkg = readPackageJson(files)
  if (pkg?.scripts) {
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

/** Generate generic-but-grounded "open questions" from what's missing. */
function detectOpenQuestions(files) {
  const qs = []
  const hasTests = files.some((f) => /(\.test\.|\.spec\.|(^|\/)tests?\/|(^|\/)__tests__\/)/i.test('/' + f.path.split(path.sep).join('/')))
  if (!hasTests) qs.push('No test files were detected — how is correctness verified?')
  const hasCI = files.some((f) => /\.github\/workflows\//.test(f.path.split(path.sep).join('/')))
  if (!hasCI) qs.push('No CI configuration found — is there an automated build/test pipeline?')
  const hasEnvExample = files.some((f) => /\.env\.(example|sample)$/.test(basename(f.path)))
  const hasEnvUsage = files.some((f) => f.content && /process\.env|os\.environ|dotenv/i.test(f.content))
  if (hasEnvUsage && !hasEnvExample) qs.push('Environment variables are referenced but no .env.example documents them — what config is required?')
  qs.push('What are the primary runtime dependencies and external services this project relies on?')
  return qs.slice(0, 4)
}

// ---------------------------------------------------------------------------
// Transformer-generated prose
// ---------------------------------------------------------------------------

/** Collapse whitespace and strip markdown noise so the summarizer sees clean prose. */
function cleanText(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')   // drop fenced code blocks
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → link text
    .replace(/[#>*_`|-]+/g, ' ')        // markdown punctuation
    .replace(/\s+/g, ' ')
    .trim()
}

/** Run the summarization model over `text`, with a safe fallback. */
async function summarizeText(text, { minLength, maxLength }) {
  const clean = cleanText(text)
  if (clean.length < 40) return clean || null
  // The model handles ~1024 input tokens; cap chars to stay well under that.
  const input = clean.slice(0, 3000)
  try {
    const summarizer = await getSummarizer()
    const [out] = await summarizer(input, { min_length: minLength, max_length: maxLength, do_sample: false })
    return out?.summary_text?.trim() || null
  } catch (err) {
    console.warn('[localAnalyzer] summarization failed, falling back to first sentence:', err.message)
    // Fallback: first sentence/clause of the cleaned text.
    return clean.slice(0, maxLength * 5).split(/(?<=[.!?])\s/)[0] || null
  }
}

function findReadme(files) {
  return findFile(files, (f) => /^readme/i.test(basename(f.path)))
}

/** Produce the `purpose` field by summarizing the README (or the repo context). */
async function generatePurpose(files, repoContext, repoName) {
  const readme = findReadme(files)
  const source = readme?.content ?? repoContext
  const summary = await summarizeText(source, { minLength: 15, maxLength: 60 })
  return summary ?? `${repoName} — purpose could not be determined from the available files.`
}

/** Produce the `architecture` field by summarizing a structural description. */
async function generateArchitecture(files, languages, stack) {
  const dirs = [...new Set(files.map((f) => f.path.split(path.sep)[0]).filter((d) => d && !d.includes('.')))].slice(0, 12)
  const structural =
    `This project is built with ${[...languages, ...stack.frameworks].slice(0, 5).join(', ') || 'no detected stack'}. ` +
    `It is organized into the following top-level directories: ${dirs.join(', ') || 'a flat layout'}. ` +
    `Key tooling includes ${stack.tools.join(', ') || 'no notable tooling detected'}. ` +
    `The codebase contains ${files.filter((f) => !f.skipped).length} analysed files across these areas.`
  // For short structural text the summarizer adds little; return it directly when brief.
  if (structural.length < 220) return structural
  const summary = await summarizeText(structural, { minLength: 25, maxLength: 90 })
  return summary ?? structural
}

// ---------------------------------------------------------------------------
// Public API — returns the structured analysis object the frontend consumes.
// ---------------------------------------------------------------------------

/**
 * Analyze a repository locally: heuristics for structured fields + a local
 * mini transformer (Transformers.js) for the prose fields. No external API.
 *
 * @param {string}   repoContext  Output of summarizer.summarize() (fallback text source)
 * @param {string}   repoName     Human-readable repo identifier
 * @param {object[]} files        Parsed FileEntry objects from repoParser
 * @returns {Promise<object>}     Analysis object with the same shape as the LLM version
 */
export async function analyzeRepo(repoContext, repoName, files) {
  const languages = detectLanguages(files)
  const stack = detectStack(files)

  // Prose fields run on the transformer (purpose first so the model is warm).
  const purpose = await generatePurpose(files, repoContext, repoName)
  const architecture = await generateArchitecture(files, languages, stack)

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
    setupInstructions: detectSetup(files),
    openQuestions: detectOpenQuestions(files),
  }
}
