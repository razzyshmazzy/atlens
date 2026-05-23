import { pipeline, env } from '@huggingface/transformers'

// Browser config: don't look for local model files; cache downloaded weights in
// the browser Cache API so the ~120MB model is only fetched once per visitor.
env.allowLocalModels = false
env.useBrowserCache = true

// Small distilled summarization model. Runs client-side via WASM/WebGPU.
const SUMMARY_MODEL = 'Xenova/distilbart-cnn-6-6'

let _summarizer = null
async function getSummarizer() {
  if (!_summarizer) {
    _summarizer = await pipeline('summarization', SUMMARY_MODEL)
  }
  return _summarizer
}

/** Kick off the model download/load early (e.g. when the page mounts). */
export async function preloadModel() {
  try {
    await getSummarizer()
  } catch {
    // Swallow — analyzeRepo falls back to extractive summaries if loading fails.
  }
}

// GitHub paths use '/'; this helper avoids node:path in the browser.
const basename = (p) => p.split('/').pop()
const extname = (p) => {
  const b = basename(p)
  const i = b.lastIndexOf('.')
  return i <= 0 ? '' : b.slice(i).toLowerCase()
}

// ---------------------------------------------------------------------------
// Heuristic structured extraction
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
  pytest: 'pytest', black: 'Black', ruff: 'Ruff', poetry: 'Poetry',
}

function findFile(files, predicate) {
  return files.find((f) => !f.skipped && f.content && predicate(f))
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

function readPackageJson(files) {
  const pkgFile = findFile(files, (f) => basename(f.path) === 'package.json')
  if (!pkgFile) return null
  try {
    return JSON.parse(pkgFile.content)
  } catch {
    return null
  }
}

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
// Transformer-generated prose
// ---------------------------------------------------------------------------

function cleanText(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function summarizeText(text, { minLength, maxLength }) {
  const clean = cleanText(text)
  if (clean.length < 40) return clean || null
  const input = clean.slice(0, 3000)
  try {
    const summarizer = await getSummarizer()
    const [out] = await summarizer(input, { min_length: minLength, max_length: maxLength, do_sample: false })
    return out?.summary_text?.trim() || null
  } catch {
    // Fallback: extractive first sentence of the cleaned text.
    return clean.slice(0, maxLength * 5).split(/(?<=[.!?])\s/)[0] || null
  }
}

function findReadme(files) {
  return findFile(files, (f) => /^readme/i.test(basename(f.path)))
}

async function generatePurpose(files, repoContext, repoName) {
  const readme = findReadme(files)
  const source = readme?.content ?? repoContext
  const summary = await summarizeText(source, { minLength: 15, maxLength: 60 })
  return summary ?? `${repoName} — purpose could not be determined from the available files.`
}

async function generateArchitecture(files, languages, stack) {
  const dirs = [...new Set(files.map((f) => f.path.split('/')[0]).filter((d) => d && !d.includes('.')))].slice(0, 12)
  const structural =
    `This project is built with ${[...languages, ...stack.frameworks].slice(0, 5).join(', ') || 'no detected stack'}. ` +
    `It is organized into the following top-level directories: ${dirs.join(', ') || 'a flat layout'}. ` +
    `Key tooling includes ${stack.tools.join(', ') || 'no notable tooling detected'}. ` +
    `The codebase contains ${files.filter((f) => !f.skipped).length} analysed files across these areas.`
  if (structural.length < 220) return structural
  const summary = await summarizeText(structural, { minLength: 25, maxLength: 90 })
  return summary ?? structural
}

// ---------------------------------------------------------------------------
// Public API — returns the structured analysis object the frontend consumes.
// ---------------------------------------------------------------------------

/**
 * Analyze a repository in the browser: heuristics for structured fields + a
 * local mini transformer (Transformers.js) for the prose fields.
 *
 * @param {string}   repoContext  Output of summarize() (fallback text source)
 * @param {string}   repoName     Human-readable repo identifier
 * @param {object[]} files        FileEntry objects from github.fetchRepo()
 * @returns {Promise<object>}
 */
export async function analyzeRepo(repoContext, repoName, files) {
  const languages = detectLanguages(files)
  const stack = detectStack(files)

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
