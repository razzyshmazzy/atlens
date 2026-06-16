import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { analyzeRepo, getRepoPurpose, summarizeUser } from '../services/api'
import LoadingState from '../components/LoadingState'

const MAX_SUMMARIZE_REPOS = 5

function formatSize(kb) {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`
  return `${kb} KB`
}

export default function UserRepos() {
  const { username } = useParams()
  const navigate = useNavigate()

  const [repos, setRepos] = useState([])
  const [loadingRepos, setLoadingRepos] = useState(true)
  const [reposError, setReposError] = useState(null)

  const [analyzing, setAnalyzing] = useState(null)
  const [analyzeStep, setAnalyzeStep] = useState(0)
  const [analyzeError, setAnalyzeError] = useState(null)
  const timersRef = useRef([])

  const [summarizing, setSummarizing] = useState(false)
  const [summarizeStatus, setSummarizeStatus] = useState(null)
  const [summary, setSummary] = useState(null)
  const [summarizeError, setSummarizeError] = useState(null)

  const [lastRepo] = useState(() => sessionStorage.getItem('atlens_last_repo'))

  useEffect(() => {
    async function load() {
      setLoadingRepos(true)
      setReposError(null)
      try {
        let all = []
        for (let page = 1; page <= 3; page++) {
          const res = await fetch(
            `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&type=public&page=${page}`
          )
          if (res.status === 404) throw new Error(`User "${username}" not found.`)
          if (res.status === 403 || res.status === 429) throw new Error('GitHub rate limit reached. Try again in a moment.')
          if (!res.ok) throw new Error(`GitHub error (${res.status}).`)
          const data = await res.json()
          if (!Array.isArray(data) || data.length === 0) break
          all = all.concat(data)
          if (data.length < 100) break
        }
        setRepos(all.sort((a, b) => (b.size ?? 0) - (a.size ?? 0)))
      } catch (err) {
        setReposError(err.message ?? 'Could not load repositories.')
      } finally {
        setLoadingRepos(false)
      }
    }
    load()
  }, [username])

  function clearTimers() {
    timersRef.current.forEach(clearTimeout)
    timersRef.current = []
  }

  async function handleAtlens(repo) {
    if (analyzing || summarizing) return
    setAnalyzeError(null)
    setAnalyzing(repo.full_name)
    setAnalyzeStep(1)
    timersRef.current.push(setTimeout(() => setAnalyzeStep(2), 3000))
    timersRef.current.push(setTimeout(() => setAnalyzeStep(3), 8000))
    try {
      const data = await analyzeRepo(`https://github.com/${repo.full_name}`)
      clearTimers()
      sessionStorage.setItem('atlens_result', JSON.stringify(data))
      sessionStorage.setItem('atlens_from_user', username)
      sessionStorage.setItem('atlens_last_repo', repo.full_name)
      navigate('/results')
    } catch (err) {
      clearTimers()
      setAnalyzing(null)
      setAnalyzeStep(0)
      setAnalyzeError(err.message ?? 'Something went wrong. Please try again.')
    }
  }

  async function handleSummarize() {
    if (analyzing || summarizing) return
    setSummarizing(true)
    setSummary(null)
    setSummarizeError(null)

    const toAnalyze = repos.slice(0, MAX_SUMMARIZE_REPOS)
    const purposes = []

    for (let i = 0; i < toAnalyze.length; i++) {
      const repo = toAnalyze[i]
      setSummarizeStatus({ current: i + 1, total: toAnalyze.length, repoName: repo.name })
      const result = await getRepoPurpose(`https://github.com/${repo.full_name}`, repo.default_branch)
      if (result?.purpose) {
        purposes.push({ name: repo.name, purpose: result.purpose })
      } else if (repo.description) {
        purposes.push({ name: repo.name, purpose: repo.description })
      }
    }

    if (purposes.length === 0) {
      setSummarizeError('Could not gather enough information from the repositories.')
      setSummarizing(false)
      setSummarizeStatus(null)
      return
    }

    setSummarizeStatus({ generating: true })

    try {
      const text = await summarizeUser(username, purposes)
      setSummary(text)
    } catch (err) {
      setSummarizeError(err.message ?? 'Could not generate summary.')
    } finally {
      setSummarizing(false)
      setSummarizeStatus(null)
    }
  }

  function handleSeeAgain() {
    sessionStorage.setItem('atlens_from_user', username)
    navigate('/results')
  }

  if (analyzing) {
    return (
      <main className="page--centered">
        <section className="home-hero">
          <p className="home-subtitle" style={{ wordBreak: 'break-all' }}>{analyzing}</p>
          <LoadingState step={analyzeStep} visible={true} />
        </section>
      </main>
    )
  }

  return (
    <main className="page">
      <header className="user-repos-header">
        <button className="btn-secondary" onClick={() => navigate('/')}>← Home</button>
        <h1 className="user-repos-title">{username}</h1>
        <button
          className="btn-secondary"
          onClick={handleSummarize}
          disabled={summarizing || repos.length === 0 || loadingRepos}
        >
          {summarizing ? 'Summarizing…' : 'Summarize'}
        </button>
      </header>

      {summarizing && summarizeStatus && (
        <div className="summarize-progress">
          <span className="loading-spinner" aria-hidden="true" />
          {summarizeStatus.generating
            ? 'Generating coder profile…'
            : `Atlensing ${summarizeStatus.current} of ${summarizeStatus.total}: ${summarizeStatus.repoName}`}
        </div>
      )}

      {summarizeError && (
        <p className="error-message" style={{ marginBottom: '1.5rem' }}>{summarizeError}</p>
      )}

      {summary && (
        <div className="summary-card">
          <div className="summary-card-header">
            <span className="summary-card-label">Coder profile — {username}</span>
            <button className="btn-secondary" style={{ fontSize: '0.75em', padding: '0.3em 0.75em' }} onClick={() => setSummary(null)}>✕</button>
          </div>
          <p className="summary-card-text">{summary}</p>
        </div>
      )}

      {analyzeError && (
        <p className="error-message" style={{ marginBottom: '1.5rem' }}>{analyzeError}</p>
      )}

      {loadingRepos && (
        <div className="loading-state">
          <span className="loading-spinner" aria-hidden="true" />
          Loading repositories…
        </div>
      )}

      {reposError && <p className="error-message">{reposError}</p>}

      {!loadingRepos && !reposError && repos.length === 0 && (
        <p className="home-subtitle">No public repositories found.</p>
      )}

      <ul className="user-repos-list">
        {repos.map((repo) => {
          const isSeen = lastRepo === repo.full_name
          return (
            <li key={repo.id} className={`repo-card${isSeen ? ' repo-card--seen' : ''}`}>
              <div className="repo-card-body">
                <div className="repo-card-name">
                  {repo.name}
                  {repo.fork && <span className="repo-fork-tag">fork</span>}
                </div>
                {repo.description && <p className="repo-card-desc">{repo.description}</p>}
                <div className="repo-card-meta">
                  {repo.language && <span className="meta-tag">{repo.language}</span>}
                  <span className="meta-tag">{formatSize(repo.size)}</span>
                  {repo.stargazers_count > 0 && (
                    <span className="meta-tag">★ {repo.stargazers_count.toLocaleString()}</span>
                  )}
                </div>
              </div>
              <div className="repo-card-actions">
                {isSeen && (
                  <button className="btn-see-again" onClick={handleSeeAgain}>
                    see again
                  </button>
                )}
                <button
                  className="btn-atlens"
                  onClick={() => handleAtlens(repo)}
                  disabled={summarizing}
                >
                  Atlens
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </main>
  )
}
