// Browser-side repo fetcher. Replaces the server's git clone + filesystem parse.
// Strategy: one call to the GitHub git-trees API for the full file list (CORS-
// enabled), then file contents from raw.githubusercontent.com (CORS-enabled and
// NOT subject to the API rate limit). No backend required.

const GITHUB_URL_REGEX = /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(\.git)?\/?$/

const MAX_FILES = 200
const MAX_FILE_BYTES = 100 * 1024 // 100 KB
const FETCH_CONCURRENCY = 10

// Directories to skip entirely (matched against any path segment).
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  '.cache', 'coverage', '.nyc_output', 'vendor', '.venv', 'venv',
  '.tox', 'target', 'out', '.gradle', '.idea', '.vscode',
])

// File suffixes to skip (binary, generated, lock files). Matched via endsWith.
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

// GitHub paths always use '/'; this helper avoids pulling in node:path.
const basename = (p) => p.split('/').pop()

/**
 * Validate a GitHub URL and extract owner/repo parts.
 * @throws {Error} with code 'invalid_url' if not a valid public GitHub repo URL
 */
export function validateGitHubUrl(url) {
  const match = (url ?? '').trim().match(GITHUB_URL_REGEX)
  if (!match) {
    throw Object.assign(new Error('URL must be a public GitHub repository (https://github.com/owner/repo)'), {
      code: 'invalid_url',
    })
  }
  const [, owner, repo] = match
  return { owner, repo, repoName: `${owner}-${repo}` }
}

function isIgnoredPath(p, isDir) {
  const segments = p.split('/')
  if (segments.some((s) => IGNORED_DIRS.has(s))) return true
  if (isDir) return false
  const base = basename(p)
  if (IGNORED_FILENAMES.has(base)) return true
  if (IGNORED_SUFFIXES.some((suf) => base.toLowerCase().endsWith(suf))) return true
  return false
}

function isPriority(p) {
  const base = basename(p)
  if (PRIORITY_FILENAMES.has(base)) return true
  if (PRIORITY_PATTERNS.some((re) => re.test(base))) return true
  const parts = p.split('/')
  const srcIdx = parts.findIndex((s) => ['src', 'lib', 'app', 'server', 'api'].includes(s))
  if (srcIdx !== -1 && parts.length - srcIdx <= 3) return true
  return false
}

// Maps a file extension to a coarse language "family". Web languages are grouped
// because a JS/TS project's HTML and CSS are part of the same story — treating
// them as rivals would starve the markup/styles that explain the app. Same logic
// keeps C headers with C sources.
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

// extension (with leading dot, lowercased) -> family
const EXT_TO_FAMILY = new Map(
  Object.entries(LANGUAGE_FAMILIES).flatMap(([family, exts]) => exts.map((e) => [e, family])),
)

function extOf(p) {
  const base = basename(p)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

function familyOf(p) {
  return EXT_TO_FAMILY.get(extOf(p)) ?? null
}

/**
 * The repo's primary language families, by file count: the smallest set of
 * families covering >= 80% of all classified files (always at least one). Drives
 * which files get budget — a Python repo spends it on .py, a React repo on its
 * web files. Count, not bytes, so one big generated/data file can't skew it.
 */
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

/** Build the nested {name, path, type, children} tree the UI renders. */
function buildTree(entries) {
  const root = []
  const dirChildren = new Map([['', root]])
  // Shallow paths first so a parent dir node exists before its children.
  const sorted = [...entries].sort((a, b) => a.path.split('/').length - b.path.split('/').length)

  for (const e of sorted) {
    const parts = e.path.split('/')
    const name = parts.pop()
    const parent = dirChildren.get(parts.join('/')) ?? root
    const node = { name, path: e.path, type: e.type }
    if (e.type === 'dir') {
      node.children = []
      dirChildren.set(e.path, node.children)
    }
    parent.push(node)
  }

  const sortLevel = (arr) => {
    arr.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)))
    arr.forEach((n) => n.children && sortLevel(n.children))
  }
  sortLevel(root)
  return root
}

async function ghJson(url) {
  let res
  try {
    res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } })
  } catch {
    throw Object.assign(new Error('Could not reach GitHub. Check your network connection.'), { code: 'network_error' })
  }
  if (res.status === 404) {
    throw Object.assign(new Error('Repository not found. It may be private or the URL may be incorrect.'), { code: 'clone_failed' })
  }
  if (res.status === 403 || res.status === 429) {
    throw Object.assign(new Error('GitHub API rate limit reached. Please try again in a little while.'), { code: 'rate_limited' })
  }
  if (!res.ok) {
    throw Object.assign(new Error(`GitHub request failed (${res.status}).`), { code: 'clone_failed' })
  }
  return res.json()
}

/** Run async tasks with a bounded concurrency pool. */
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

/**
 * Fetch a public GitHub repo entirely from the browser.
 * @param {string} repoUrl
 * @returns {Promise<{files: object[], tree: object[], fileCount: number, skippedFiles: number}>}
 *   `files` entries match the old server shape: { path, content, sizeBytes, skipped, reason?, priority }
 */
export async function fetchRepo(repoUrl) {
  const { owner, repo } = validateGitHubUrl(repoUrl)

  // 1) Resolve the default branch.
  const meta = await ghJson(`https://api.github.com/repos/${owner}/${repo}`)
  const branch = meta.default_branch ?? 'main'

  // 2) One recursive tree call lists every blob/tree in the repo.
  const treeData = await ghJson(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  )
  const rawEntries = Array.isArray(treeData.tree) ? treeData.tree : []

  // Entries (blobs + dirs) that survive the ignore filters — used for the UI tree.
  const treeEntries = []
  const blobs = []
  for (const entry of rawEntries) {
    const isDir = entry.type === 'tree'
    const isFile = entry.type === 'blob'
    if (!isDir && !isFile) continue
    if (isIgnoredPath(entry.path, isDir)) continue
    treeEntries.push({ path: entry.path, type: isDir ? 'dir' : 'file' })
    if (isFile) blobs.push({ path: entry.path, size: entry.size ?? 0 })
  }

  const tree = buildTree(treeEntries)

  // 3) Choose which blobs to download content for, capped at MAX_FILES. Three
  //    tiers: priority files (README/manifests/entry points), then source in the
  //    repo's primary language(s), then everything else. Within a tier, shallow
  //    paths first, then alphabetical.
  const primary = primaryFamilies(blobs)
  const isPrimaryLang = (p) => {
    const fam = familyOf(p)
    return fam !== null && primary.has(fam)
  }
  const tierOf = (x) => (x.priority ? 0 : x.primaryLang ? 1 : 2)
  const ranked = blobs
    .map((b) => ({ ...b, priority: isPriority(b.path), primaryLang: isPrimaryLang(b.path) }))
    .sort((a, b) => {
      if (tierOf(a) !== tierOf(b)) return tierOf(a) - tierOf(b)
      const depth = a.path.split('/').length - b.path.split('/').length
      return depth !== 0 ? depth : a.path.localeCompare(b.path)
    })
  const selected = ranked.slice(0, MAX_FILES)

  // 4) Pull contents from raw.githubusercontent.com (CORS-friendly, un-throttled).
  const files = await pooled(selected, FETCH_CONCURRENCY, async (b) => {
    if (b.size > MAX_FILE_BYTES) {
      return { path: b.path, content: null, sizeBytes: b.size, skipped: true, reason: 'too_large' }
    }
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${b.path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`
    try {
      const res = await fetch(url)
      if (!res.ok) {
        return { path: b.path, content: null, sizeBytes: b.size, skipped: true, reason: 'read_error' }
      }
      const content = await res.text()
      // Heuristic binary check — a NUL byte means it isn't text.
      if (content.includes('\u0000')) {
        return { path: b.path, content: null, sizeBytes: b.size, skipped: true, reason: 'binary' }
      }
      return { path: b.path, content, sizeBytes: b.size, skipped: false, priority: b.priority, primaryLang: b.primaryLang }
    } catch {
      return { path: b.path, content: null, sizeBytes: b.size, skipped: true, reason: 'read_error' }
    }
  })

  const skippedFiles = files.filter((f) => f.skipped).length
  return { files, tree, fileCount: files.length, skippedFiles }
}
