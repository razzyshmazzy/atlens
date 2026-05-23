// Compresses fetched file contents into a single context string for the model.
// Pure string manipulation — identical logic to the former server/summarizer.js,
// but path handling uses '/' (GitHub paths) instead of node:path.

const PRIORITY_LINES = 150 // README, package.json, entry points
const SRC_LINES = 80 // src/** files
const OTHER_LINES = 40 // everything else

const MAX_TOTAL_CHARS = 100_000

const basename = (p) => p.split('/').pop()

function truncate(content, maxLines) {
  const lines = content.split('\n')
  if (lines.length <= maxLines) return content
  const kept = lines.slice(0, maxLines).join('\n')
  return `${kept}\n[... ${lines.length - maxLines} more lines not shown ...]`
}

function lineLimit(filePath) {
  const lower = filePath.toLowerCase()
  if (
    /readme/i.test(filePath) ||
    /^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|requirements\.txt|dockerfile|docker-compose\.ya?ml|makefile)$/i.test(
      basename(filePath),
    )
  ) {
    return PRIORITY_LINES
  }
  if (/\/(src|lib|app|server|api|pages|components|routes|controllers|models|views|utils|hooks)\//i.test('/' + lower)) {
    return SRC_LINES
  }
  return OTHER_LINES
}

function fileBlock(filePath, content) {
  const body = truncate(content, lineLimit(filePath))
  return `=== ${filePath} ===\n${body}\n`
}

/**
 * Compress file contents into a single context string suitable for the model.
 * @param {object[]} files  FileEntry objects from github.fetchRepo()
 * @returns {string}
 */
export function summarize(files) {
  const readable = files.filter((f) => !f.skipped && f.content)

  const priority = readable.filter((f) => f.priority)
  const nonPriority = readable.filter((f) => !f.priority)

  nonPriority.sort((a, b) => {
    const aIsSrc = /\/(src|lib|app|server|api)\//.test('/' + a.path)
    const bIsSrc = /\/(src|lib|app|server|api)\//.test('/' + b.path)
    if (aIsSrc !== bIsSrc) return aIsSrc ? -1 : 1
    return a.path.localeCompare(b.path)
  })

  const ordered = [...priority, ...nonPriority]
  const skipped = files.filter((f) => f.skipped)

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
