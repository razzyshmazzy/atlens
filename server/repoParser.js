import fs from 'fs/promises'
import path from 'path'

const MAX_FILES = 200
const MAX_FILE_BYTES = 100 * 1024 // 100 KB

// Directories to skip entirely
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  '.cache', 'coverage', '.nyc_output', 'vendor', '.venv', 'venv',
  '.tox', 'target', 'out', '.gradle', '.idea', '.vscode',
])

// File extensions to skip (binary, generated, lock files)
const IGNORED_EXTENSIONS = new Set([
  '.min.js', '.min.css', '.map', '.lock',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.avif',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib',
  '.db', '.sqlite', '.sqlite3',
  '.pyc', '.pyo', '.class',
])

// Lock file names (independent of extension)
const IGNORED_FILENAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Pipfile.lock',
  'Gemfile.lock', 'poetry.lock', 'composer.lock',
])

// Priority files: always included if under size limit
const PRIORITY_FILENAMES = new Set([
  'README.md', 'README.rst', 'README.txt', 'README',
  'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod',
  'requirements.txt', 'Pipfile', 'Gemfile',
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  '.env.example', '.env.sample',
  'Makefile', 'CMakeLists.txt',
])

// Source entry point patterns (matched against basename)
const PRIORITY_PATTERNS = [
  /^(index|main|app|server|client|entry)\.(jsx?|tsx?|py|go|rs|rb|php|java|cs)$/i,
  /^App\.(jsx?|tsx?)$/i,
]

/**
 * Check if a file is a priority file worth always reading.
 */
function isPriority(filePath) {
  const base = path.basename(filePath)
  if (PRIORITY_FILENAMES.has(base)) return true
  if (PRIORITY_PATTERNS.some((re) => re.test(base))) return true
  // Files directly inside src/, lib/, app/ directories
  const parts = filePath.split(path.sep)
  const srcIdx = parts.findIndex((p) => ['src', 'lib', 'app', 'server', 'api'].includes(p))
  if (srcIdx !== -1 && parts.length - srcIdx <= 3) return true
  return false
}

/**
 * Recursively traverse a directory, building a tree and collecting file contents.
 * @param {string} dirPath  Absolute path to traverse
 * @param {string} rootPath Absolute path to repo root (for relative path calculations)
 * @param {{ count: number }} counter Mutable counter to track total files seen
 * @returns {Promise<{ tree: object[], files: object[] }>}
 */
async function traverse(dirPath, rootPath, counter) {
  const tree = []
  const files = []

  let entries
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true })
  } catch {
    return { tree, files }
  }

  // Sort: directories first, then files alphabetically
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    const relPath = path.relative(rootPath, fullPath)

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      const { tree: childTree, files: childFiles } = await traverse(fullPath, rootPath, counter)
      tree.push({ name: entry.name, path: relPath, type: 'dir', children: childTree })
      files.push(...childFiles)
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (IGNORED_EXTENSIONS.has(ext)) continue
      if (IGNORED_FILENAMES.has(entry.name)) continue

      tree.push({ name: entry.name, path: relPath, type: 'file' })

      // Stop reading file content after MAX_FILES, but keep building the tree
      if (counter.count >= MAX_FILES) continue
      counter.count++

      let stat
      try {
        stat = await fs.stat(fullPath)
      } catch {
        continue
      }

      if (stat.size > MAX_FILE_BYTES) {
        files.push({ path: relPath, content: null, sizeBytes: stat.size, skipped: true, reason: 'too_large' })
        continue
      }

      let content
      try {
        content = await fs.readFile(fullPath, 'utf8')
      } catch {
        // Likely a binary file with a text extension — skip
        files.push({ path: relPath, content: null, sizeBytes: stat.size, skipped: true, reason: 'read_error' })
        continue
      }

      files.push({
        path: relPath,
        content,
        sizeBytes: stat.size,
        skipped: false,
        priority: isPriority(relPath),
      })
    }
  }

  return { tree, files }
}

/**
 * Parse a cloned repository directory.
 * @param {string} clonePath  Absolute path to the repo root
 * @returns {Promise<{ tree: object[], files: object[], fileCount: number, skippedFiles: number }>}
 */
export async function parseRepo(clonePath) {
  const counter = { count: 0 }
  const { tree, files } = await traverse(clonePath, clonePath, counter)

  const skippedFiles = files.filter((f) => f.skipped).length

  return { tree, files, fileCount: files.length, skippedFiles }
}
