import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import RepoInput from '../components/RepoInput'
import LoadingState from '../components/LoadingState'
import { analyzeRepo, preloadModel } from '../services/api'

export default function Home() {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingStep, setLoadingStep] = useState(0)
  const [error, setError] = useState(null)
  const navigate = useNavigate()
  const timersRef = useRef([])

  // Warm the summarization model in the background while the user types the URL,
  // so the first analysis doesn't wait on the ~120MB model download.
  useEffect(() => {
    preloadModel()
  }, [])

  function clearTimers() {
    timersRef.current.forEach(clearTimeout)
    timersRef.current = []
  }

  async function handleAnalyze() {
    if (loading) return
    setError(null)
    setLoading(true)
    setLoadingStep(1)

    timersRef.current.push(setTimeout(() => setLoadingStep(2), 3000))
    timersRef.current.push(setTimeout(() => setLoadingStep(3), 8000))

    try {
      const data = await analyzeRepo(url)
      clearTimers()
      sessionStorage.setItem('atlens_result', JSON.stringify(data))
      navigate('/results')
    } catch (err) {
      clearTimers()
      setLoading(false)
      setLoadingStep(0)
      setError(err.message ?? 'Something went wrong. Please try again.')
    }
  }

  return (
    <main className="page--centered">
      <section className="home-hero">
        <h1 className="home-title">Atlens</h1>
        <p className="home-subtitle">
          Into the artifice of eternity.
        </p>

        <RepoInput
          url={url}
          onChange={setUrl}
          loading={loading}
          onSubmit={handleAnalyze}
        />

        <LoadingState step={loadingStep} visible={loading} />

        {error && (
          <p className="error-message" role="alert">{error}</p>
        )}
      </section>
    </main>
  )
}
