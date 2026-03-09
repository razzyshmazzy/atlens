import 'dotenv/config'  // Must be first — loads .env before anything else
import express from 'express'
import cors from 'cors'
import { validateGitHubUrl, cloneOrUpdate } from './repoCloner.js'
import { parseRepo } from './repoParser.js'
import { summarize } from './summarizer.js'
import { analyzeRepo } from './llm.js'

const app = express()
const PORT = process.env.PORT ?? 3001

app.use(cors())
app.use(express.json())

/**
 * POST /analyze
 * Body: { repoUrl: string }
 * Returns: { ok, repoName, analysis, fileTree, fileCount, skippedFiles }
 */
app.post('/analyze', async (req, res, next) => {
  try {
    const { repoUrl } = req.body ?? {}

    if (!repoUrl || typeof repoUrl !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'invalid_url',
        message: 'Request body must include a repoUrl string.',
      })
    }

    // Step 1: Validate URL and derive repo name
    let repoInfo
    try {
      repoInfo = validateGitHubUrl(repoUrl)
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.code ?? 'invalid_url', message: err.message })
    }

    // Step 2: Clone the repository (or use cached copy)
    let clonePath
    try {
      clonePath = await cloneOrUpdate(repoUrl)
    } catch (err) {
      return res.status(422).json({ ok: false, error: err.code ?? 'clone_failed', message: err.message })
    }

    // Step 3: Parse the repository structure and read key files
    const parsed = await parseRepo(clonePath)

    // Step 4: Compress file contents into LLM-sized context
    const context = summarize(parsed.files)

    // Step 5: Call the LLM for analysis
    let analysis
    try {
      analysis = await analyzeRepo(context, repoInfo.repoName)
    } catch (err) {
      const status = err.code === 'rate_limited' ? 503 : 502
      return res.status(status).json({ ok: false, error: err.code ?? 'llm_error', message: err.message })
    }

    return res.json({
      ok: true,
      repoName: repoInfo.repoName,
      analysis,
      fileTree: parsed.tree,
      fileCount: parsed.fileCount,
      skippedFiles: parsed.skippedFiles,
    })
  } catch (err) {
    next(err)
  }
})

// Global error handler — catches any unhandled errors from above
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('[server error]', err)
  res.status(500).json({ ok: false, error: 'internal_error', message: 'An unexpected error occurred.' })
})

app.listen(PORT, () => {
  console.log(`Atlens server running on http://localhost:${PORT}`)
})
