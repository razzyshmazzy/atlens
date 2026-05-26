// Compresses fetched file contents into a single context string for the model.
// Priority files (README, manifests, entry points) come first, then source in
// the repo's primary language(s), then the rest, capped at MAX_TOTAL_CHARS. Sent
// to the proxy, which forwards to Groq.

const PRIORITY_LINES = 100
const SRC_LINES = 50
const OTHER_LINES = 25
// ~4.7K input tokens at the ~3.8 chars/token that source code averages. Halved
// from the old 36K-char budget to stretch Groq's free-tier ~100K tokens/day
// quota across roughly twice as many analyses (each call ≈ context + ~600 tok
// system + ~800 tok completion). Still comfortably under the 12K tokens/minute
// ceiling, so a single request is never rejected outright (HTTP 413).
const MAX_TOTAL_CHARS = 18_000

const basename = (p) => p.split('/').pop()

// Conservative cleanup applied before truncation: collapse long blank-line runs
// and drop a leading license/copyright banner. We deliberately KEEP imports —
// they are the main signal the model uses to detect frameworks for techStack.
function stripNoise(content) {
  const collapsed = content.replace(/\n{3,}/g, '\n\n')
  const deLicensed = collapsed.replace(
    /^\s*(\/\*[\s\S]*?\*\/|(?:\/\/.*\n)+|(?:#.*\n)+)/,
    (block) => (/copyright|licen[sc]e|spdx|permission is hereby granted/i.test(block) ? '' : block),
  )
  return deLicensed.trimStart()
}

function truncate(content, maxLines) {
  const lines = content.split('\n')
  if (lines.length <= maxLines) return content
  return `${lines.slice(0, maxLines).join('\n')}\n[... ${lines.length - maxLines} more lines not shown ...]`
}

function lineLimit(file) {
  if (
    /readme/i.test(file.path) ||
    /^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|requirements\.txt|dockerfile|docker-compose\.ya?ml|makefile)$/i.test(
      basename(file.path),
    )
  ) {
    return PRIORITY_LINES
  }
  if (file.primaryLang) return SRC_LINES
  return OTHER_LINES
}

function fileBlock(file) {
  return `=== ${file.path} ===\n${truncate(stripNoise(file.content), lineLimit(file))}\n`
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
    if (a.primaryLang !== b.primaryLang) return a.primaryLang ? -1 : 1
    const depth = a.path.split('/').length - b.path.split('/').length
    return depth !== 0 ? depth : a.path.localeCompare(b.path)
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
    const block = fileBlock(file)
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
