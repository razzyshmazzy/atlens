import { HashRouter, Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import Results from './pages/Results'
import './App.css'

export default function App() {
  return (
    <>
      {/* Animated event horizon background — fixed, behind all content */}
      <div className="scene-bg" aria-hidden="true">
        <div className="scene-glow" />
        <div className="scene-streak" />
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
