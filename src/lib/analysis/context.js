// Compresses fetched file contents into a single context string for the model.
// Priority files (README, manifests, entry points) come first, then source, then
// the rest, capped at MAX_TOTAL_CHARS. Sent to the proxy, which forwards to Gemini.

const PRIORITY_LINES = 150
const SRC_LINES = 80
const OTHER_LINES = 40
const MAX_TOTAL_CHARS = 100_000

const basename = (p) => p.split('/').pop()

function truncate(content, maxLines) {
  const lines = content.split('\n')
  if (lines.length <= maxLines) return content
  return `${lines.slice(0, maxLines).join('\n')}\n[... ${lines.length - maxLines} more lines not shown ...]`
}

function lineLimit(filePath) {
  if (
    /readme/i.test(filePath) ||
    /^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|requirements\.txt|dockerfile|docker-compose\.ya?ml|makefile)$/i.test(
      basename(filePath),
    )
  ) {
    return PRIORITY_LINES
  }
  if (/\/(src|lib|app|server|api|pages|components|routes|controllers|models|views|utils|hooks)\//i.test('/' + filePath.toLowerCase())) {
    return SRC_LINES
  }
  return OTHER_LINES
}

function fileBlock(filePath, content) {
  return `=== ${filePath} ===\n${truncate(content, lineLimit(filePath))}\n`
}

/**
 * @param {object[]} files  FileEntry objects from github.fetchRepo()
 * @returns {string}        Context string ready to embed in the model prompt
 */
export function buildContext(files) {
  const readable = files.filter((f) => !f.skipped && f.content)
  const priority = readable.filter((f) => f.priority)
  const nonPriority = readable.filter((f) => !f.priority)

  nonPriority.sort((a, b) => {
    const aSrc = /\/(src|lib|app|server|api)\//.test('/' + a.path)
    const bSrc = /\/(src|lib|app|server|api)\//.test('/' + b.path)
    if (aSrc !== bSrc) return aSrc ? -1 : 1
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
    context += `\n[Context limit reached. ${dropped.length} additional files were omitted.]\n`
  }
  return context
}
