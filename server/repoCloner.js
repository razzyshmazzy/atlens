import { existsSync } from 'fs'
import path from 'path'
import simpleGit from 'simple-git'

// Matches: https://github.com/owner/repo (with optional .git or trailing slash)
const GITHUB_URL_REGEX = /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(\.git)?\/?$/

/**
 * Validate a GitHub URL and extract owner/repo parts.
 * @param {string} url
 * @returns {{ owner: string, repo: string, repoName: string }}
 * @throws {Error} with message 'invalid_url' if not a valid public GitHub repo URL
 */
export function validateGitHubUrl(url) {
  const match = url.trim().match(GITHUB_URL_REGEX)
  if (!match) {
    throw Object.assign(new Error('URL must be a public GitHub repository (https://github.com/owner/repo)'), {
      code: 'invalid_url',
    })
  }
  const [, owner, repo] = match
  return { owner, repo, repoName: `${owner}-${repo}` }
}

/**
 * Clone a GitHub repo to /tmp/repos/<owner>-<repo> using a shallow clone.
 * If the directory already exists, skip cloning (treat cached as valid).
 * @param {string} repoUrl
 * @returns {Promise<string>} absolute path to the cloned repo
 */
export async function cloneOrUpdate(repoUrl) {
  const { repoName } = validateGitHubUrl(repoUrl)
  const clonePath = path.join('/tmp', 'repos', repoName)

  if (existsSync(clonePath)) {
    // Repo already cached — reuse it to avoid re-cloning on repeat requests
    return clonePath
  }

  try {
    // --depth 1 fetches only the latest commit (much faster for large repos)
    await simpleGit().clone(repoUrl, clonePath, ['--depth', '1'])
  } catch (err) {
    throw Object.assign(
      new Error(`Could not clone repository. It may be private or the URL may be incorrect. (${err.message})`),
      { code: 'clone_failed' }
    )
  }

  return clonePath
}
