// In dev, Vite proxies /api/* → http://localhost:3001.
// In production, set VITE_API_URL to the deployed server base URL.
const BASE = import.meta.env.DEV
  ? '/api'
  : (import.meta.env.VITE_API_URL ?? '/api')

/**
 * POST /analyze — analyze a GitHub repository URL.
 * @param {string} repoUrl
 * @returns {Promise<object>} { ok, repoName, analysis, fileTree, fileCount, skippedFiles }
 * @throws {Error} with .message from the server on non-OK responses
 */
export async function analyzeRepo(repoUrl) {
  const res = await fetch(`${BASE}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoUrl }),
  })

  const data = await res.json()

  if (!res.ok) {
    throw Object.assign(new Error(data.message ?? 'Analysis failed.'), { code: data.error })
  }

  return data
}
