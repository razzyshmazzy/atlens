// Line limits per file category (controls how much context is sent to the LLM)
const PRIORITY_LINES = 150  // README, package.json, entry points
const SRC_LINES = 80        // src/** files
const OTHER_LINES = 40      // everything else

// Hard cap on total context size (well within Haiku's 200K token window)
const MAX_TOTAL_CHARS = 100_000

/**
 * Truncate file content to a maximum number of lines.
 * Appends a marker if lines were omitted.
 */
function truncate(content, maxLines) {
  const lines = content.split('\n')
  if (lines.length <= maxLines) return content
  const kept = lines.slice(0, maxLines).join('\n')
  return `${kept}\n[... ${lines.length - maxLines} more lines not shown ...]`
}

/**
 * Determine the line limit for a given file path.
 */
function lineLimit(filePath) {
  const lower = filePath.toLowerCase()
  // Priority: README, package.json, Dockerfile, etc.
  if (
    /readme/i.test(filePath) ||
    /^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|requirements\.txt|dockerfile|docker-compose\.ya?ml|makefile)$/i.test(
      filePath.split('/').pop()
    )
  ) {
    return PRIORITY_LINES
  }
  // Source directories
  if (/\/(src|lib|app|server|api|pages|components|routes|controllers|models|views|utils|hooks)\//i.test('/' + lower)) {
    return SRC_LINES
  }
  return OTHER_LINES
}

/**
 * Build a formatted block for one file.
 */
function fileBlock(filePath, content) {
  const limit = lineLimit(filePath)
  const body = truncate(content, limit)
  return `=== ${filePath} ===\n${body}\n`
}

/**
 * Compress file contents into a single context string suitable for the LLM.
 * Priority files come first, then source files, then the rest.
 * Total size is capped at MAX_TOTAL_CHARS.
 *
 * @param {object[]} files  Array of FileEntry objects from repoParser
 * @returns {string}        Context string ready to embed in the LLM prompt
 */
export function summarize(files) {
  const readable = files.filter((f) => !f.skipped && f.content)

  // Separate into buckets
  const priority = readable.filter((f) => f.priority)
  const nonPriority = readable.filter((f) => !f.priority)

  // Sort non-priority: src files first, then the rest
  nonPriority.sort((a, b) => {
    const aIsSrc = /\/(src|lib|app|server|api)\//.test('/' + a.path)
    const bIsSrc = /\/(src|lib|app|server|api)\//.test('/' + b.path)
    if (aIsSrc !== bIsSrc) return aIsSrc ? -1 : 1
    return a.path.localeCompare(b.path)
  })

  const ordered = [...priority, ...nonPriority]
  const skipped = files.filter((f) => f.skipped)

  // Build header with stats
  const header = [
    `Repository contains ${files.length} analysed files (${skipped.length} skipped due to size or binary content).`,
    skipped.length > 0
      ? `Skipped files: ${skipped.map((f) => f.path).slice(0, 10).join(', ')}${skipped.length > 10 ? ` ... and ${skipped.length - 10} more` : ''}`
      : null,
    '',
  ]
    .filter((l) => l !== null)
    .join('\n')

  let context = header + '\n'
  const dropped = []

  for (const file of ordered) {
    const block = fileBlock(file.path, file.content)
    if (context.length + block.length > MAX_TOTAL_CHARS) {
      dropped.push(file.path)
      continue
    }
    context += block + '\n'
  }

  if (dropped.length > 0) {
    context += `\n[Context limit reached. ${dropped.length} additional files were omitted: ${dropped.slice(0, 5).join(', ')}${dropped.length > 5 ? '...' : ''}]\n`
  }

  return context
}
