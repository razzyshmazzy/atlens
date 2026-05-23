// Fully client-side analysis pipeline — no backend. Runs in the browser:
//   GitHub API (fetch repo) → summarize context → local Transformers.js model.
import { validateGitHubUrl, fetchRepo } from '../lib/analysis/github'
import { summarize } from '../lib/analysis/summarizer'
import { analyzeRepo as runAnalysis, preloadModel } from '../lib/analysis/analyzer'

export { preloadModel }

/**
 * Analyze a public GitHub repository entirely in the browser.
 * @param {string} repoUrl
 * @returns {Promise<object>} { ok, repoName, analysis, fileTree, fileCount, skippedFiles }
 * @throws {Error} with a user-facing .message (and optional .code) on failure
 */
export async function analyzeRepo(repoUrl) {
  // Validate first so a bad URL fails fast with a clear message.
  const { repoName } = validateGitHubUrl(repoUrl)

  const { files, tree, fileCount, skippedFiles } = await fetchRepo(repoUrl)
  const context = summarize(files)
  const analysis = await runAnalysis(context, repoName, files)

  return {
    ok: true,
    repoName,
    analysis,
    fileTree: tree,
    fileCount,
    skippedFiles,
  }
}
