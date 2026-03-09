import Anthropic from '@anthropic-ai/sdk'

// Using Haiku for speed and cost efficiency
const MODEL = 'claude-haiku-4-5-20251001'

const SYSTEM_PROMPT = `You are a senior software engineer analyzing a GitHub repository.
You will be given the contents of key files from a repository.
Your task is to produce a structured analysis in valid JSON format.

RULES:
- Base your analysis ONLY on what is present in the provided files.
- Do not invent features, technologies, or capabilities not evidenced in the code.
- Be concise and precise. Use developer-appropriate language.
- Your response MUST be a single valid JSON object — no markdown, no explanation, no code fences.
- If a field cannot be determined from the provided context, use null for that field.`

const USER_PROMPT_TEMPLATE = `Repository: {repoName}

{repoContext}

---

Analyze the repository above and return a JSON object with EXACTLY this structure:

{
  "repoName": "string — the repository name",
  "purpose": "string — 1-2 sentence description of what this project does",
  "techStack": {
    "languages": ["array of programming languages detected"],
    "frameworks": ["array of frameworks/libraries"],
    "tools": ["array of build tools, linters, testing frameworks, CI/CD, etc."]
  },
  "architecture": "string — 2-4 sentences describing the high-level architecture and how the main pieces fit together",
  "entryPoints": ["array of file paths that are the main entry points"],
  "keyFiles": [
    {
      "path": "string",
      "role": "string — what this file does in 1 sentence"
    }
  ],
  "setupInstructions": "string — how to install and run the project based on README or package.json scripts. null if not determinable.",
  "openQuestions": ["array of 2-4 things that are unclear or worth investigating further"]
}`

/**
 * Call Claude Haiku with the repo context and return a parsed analysis object.
 * @param {string} repoContext  Output of summarizer.summarize()
 * @param {string} repoName     Human-readable repo identifier (e.g. "facebook-react")
 * @returns {Promise<object>}   Parsed JSON analysis
 */
export async function analyzeRepo(repoContext, repoName) {
  const client = new Anthropic()  // Uses ANTHROPIC_API_KEY from env

  const userMessage = USER_PROMPT_TEMPLATE
    .replace('{repoName}', repoName)
    .replace('{repoContext}', repoContext)

  let response
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    })
  } catch (err) {
    // Distinguish rate limit errors from other API errors
    if (err.status === 429) {
      throw Object.assign(new Error('The analysis service is temporarily unavailable. Please try again in a moment.'), {
        code: 'rate_limited',
      })
    }
    throw Object.assign(new Error(`AI analysis failed: ${err.message}`), { code: 'llm_error' })
  }

  const rawText = response.content[0]?.text ?? ''

  // Strip accidental markdown code fences if the model wraps the JSON
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()

  try {
    return JSON.parse(cleaned)
  } catch {
    throw Object.assign(
      new Error(`Failed to parse AI response as JSON. Raw response: ${rawText.slice(0, 200)}`),
      { code: 'llm_error' }
    )
  }
}
