// Analysis pipeline: the browser fetches the public repo and builds a context
// string, then POSTs it to the Atlens proxy (a Cloudflare Worker) which holds
// the Gemini API key and returns the structured analysis. The key never touches
// the client.
import { validateGitHubUrl, fetchRepo } from '../lib/analysis/github'
import { buildContext } from '../lib/analysis/context'

// Proxy base URL. In dev, defaults to a local `wrangler dev`. In production,
// set VITE_API_URL to the deployed Worker URL at build time.
const PROXY_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'

/**
 * Analyze a public GitHub repository.
 * @param {string} repoUrl
 * @returns {Promise<object>} { ok, repoName, analysis, fileTree, fileCount, skippedFiles }
 * @throws {Error} with a user-facing .message (and optional .code) on failure
 */
export async function analyzeRepo(repoUrl) {
  // Validate first so a bad URL fails fast with a clear message.
  const { repoName } = validateGitHubUrl(repoUrl)

  const { files, tree, fileCount, skippedFiles } = await fetchRepo(repoUrl)
  const context = buildContext(files)

  let res
  try {
    res = await fetch(`${PROXY_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoName, context }),
    })
  } catch {
    throw new Error('Could not reach the analysis service. Please try again.')
  }

  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.message ?? 'Analysis failed. Please try again.')
  }

  return {
    ok: true,
    repoName,
    analysis: data.analysis,
    fileTree: tree,
    fileCount,
    skippedFiles,
  }
}
