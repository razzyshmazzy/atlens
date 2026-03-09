import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import RepoOverview from '../components/RepoOverview'
import FileTree from '../components/FileTree'

export default function Results() {
  const [data, setData] = useState(null)
  const navigate = useNavigate()

  useEffect(() => {
    const raw = sessionStorage.getItem('atlens_result')
    if (!raw) {
      navigate('/')
      return
    }
    try {
      setData(JSON.parse(raw))
    } catch {
      navigate('/')
    }
  }, [navigate])

  if (!data) return null

  return (
    <main className="page">
      <header className="results-header">
        <div>
          <h1 className="results-title gradient-text">{data.analysis?.repoName ?? data.repoName}</h1>
          <p className="results-meta">
            {data.fileCount} files analysed
            {data.skippedFiles > 0 && ` · ${data.skippedFiles} skipped`}
          </p>
        </div>
        <button className="btn-secondary" onClick={() => navigate('/')}>
          ← Analyze another
        </button>
      </header>

      <RepoOverview analysis={data.analysis} />
      <FileTree nodes={data.fileTree} />
    </main>
  )
}
