import { useEffect, useRef } from 'react'
import { HashRouter, Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import Results from './pages/Results'
import './App.css'

export default function App() {
  const streakRef = useRef(null)

  useEffect(() => {
    const handleMouseMove = (e) => {
      const el = streakRef.current
      if (!el) return
      const offsetX = (e.clientX / window.innerWidth  - 0.5) *  8
      const offsetY = (e.clientY / window.innerHeight - 0.5) * 24
      el.style.transform = `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px))`
    }
    window.addEventListener('mousemove', handleMouseMove)
    return () => window.removeEventListener('mousemove', handleMouseMove)
  }, [])

  return (
    <>
      {/* Animated event horizon background — fixed, behind all content */}
      <div className="scene-bg" aria-hidden="true">
        <div className="scene-glow" />
        <div className="scene-streak" ref={streakRef} />
        <div className="scene-floor" />
      </div>

      <HashRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/results" element={<Results />} />
        </Routes>
      </HashRouter>
    </>
  )
}
