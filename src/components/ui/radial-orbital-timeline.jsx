import { useState, useEffect, useRef, useCallback } from 'react'
import { ArrowRight, Link, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default function RadialOrbitalTimeline({ timelineData }) {
  const [expandedItems, setExpandedItems] = useState({})
  const [pulseEffect, setPulseEffect] = useState({})
  const [activeNodeId, setActiveNodeId] = useState(null)
  // rotationAngle as ref so rAF can read/write without triggering re-renders
  const angleRef = useRef(0)
  // Separate state only for forcing re-renders on each frame
  const [renderAngle, setRenderAngle] = useState(0)
  const autoRotateRef = useRef(true)
  const rafRef = useRef(null)
  const lastTimeRef = useRef(null)
  const containerRef = useRef(null)
  const orbitRef = useRef(null)
  const nodeRefs = useRef({})

  // rAF-driven rotation — 60fps, time-based so speed is framerate-independent
  useEffect(() => {
    const step = (timestamp) => {
      if (autoRotateRef.current) {
        if (lastTimeRef.current !== null) {
          const dt = timestamp - lastTimeRef.current
          angleRef.current = (angleRef.current + dt * 0.006) % 360
          setRenderAngle(angleRef.current)
        }
        lastTimeRef.current = timestamp
      } else {
        lastTimeRef.current = null
      }
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  const handleContainerClick = (e) => {
    if (e.target === containerRef.current || e.target === orbitRef.current) {
      setExpandedItems({})
      setActiveNodeId(null)
      setPulseEffect({})
      autoRotateRef.current = true
    }
  }

  const getRelatedItems = useCallback((itemId) => {
    const current = timelineData.find((item) => item.id === itemId)
    return current ? current.relatedIds : []
  }, [timelineData])

  const centerViewOnNode = useCallback((nodeId) => {
    const nodeIndex = timelineData.findIndex((item) => item.id === nodeId)
    const totalNodes = timelineData.length
    const targetAngle = (nodeIndex / totalNodes) * 360
    angleRef.current = (270 - targetAngle + 360) % 360
    setRenderAngle(angleRef.current)
  }, [timelineData])

  const toggleItem = (id) => {
    setExpandedItems((prev) => {
      const newState = { ...prev }
      Object.keys(newState).forEach((key) => {
        if (parseInt(key) !== id) newState[parseInt(key)] = false
      })
      newState[id] = !prev[id]

      if (!prev[id]) {
        setActiveNodeId(id)
        autoRotateRef.current = false
        const relatedItems = getRelatedItems(id)
        const newPulseEffect = {}
        relatedItems.forEach((relId) => { newPulseEffect[relId] = true })
        setPulseEffect(newPulseEffect)
        centerViewOnNode(id)
      } else {
        setActiveNodeId(null)
        autoRotateRef.current = true
        setPulseEffect({})
      }

      return newState
    })
  }

  const calculateNodePosition = (index, total) => {
    const angle = ((index / total) * 360 + renderAngle) % 360
    const radius = 210
    const radian = (angle * Math.PI) / 180
    const x = radius * Math.cos(radian)
    const y = radius * Math.sin(radian)
    const zIndex = Math.round(100 + 50 * Math.cos(radian))
    const opacity = Math.max(0.35, Math.min(1, 0.35 + 0.65 * ((1 + Math.sin(radian)) / 2)))
    return { x, y, zIndex, opacity }
  }

  const isRelatedToActive = (itemId) => {
    if (!activeNodeId) return false
    return getRelatedItems(activeNodeId).includes(itemId)
  }

  return (
    <div
      className="w-full h-full flex flex-col items-center justify-center bg-transparent overflow-hidden"
      ref={containerRef}
      onClick={handleContainerClick}
    >
      <div className="relative w-full max-w-4xl h-full flex items-center justify-center">
        <div
          className="absolute w-full h-full flex items-center justify-center"
          ref={orbitRef}
        >
          {/* Centre orb */}
          <div className="absolute w-16 h-16 rounded-full bg-gradient-to-br from-purple-500 via-blue-500 to-teal-500 animate-pulse flex items-center justify-center z-10">
            <div className="absolute w-20 h-20 rounded-full border border-white/20 animate-ping opacity-70" />
            <div
              className="absolute w-24 h-24 rounded-full border border-white/10 animate-ping opacity-50"
              style={{ animationDelay: '0.5s' }}
            />
            <div className="w-8 h-8 rounded-full bg-white/80 backdrop-blur-md" />
          </div>

          {/* Orbit ring — matches radius=210 → diameter 420 */}
          <div className="absolute rounded-full border border-white/10" style={{ width: 420, height: 420 }} />

          {/* Nodes */}
          {timelineData.map((item, index) => {
            const position = calculateNodePosition(index, timelineData.length)
            const isExpanded = expandedItems[item.id]
            const isRelated = isRelatedToActive(item.id)
            const isPulsing = pulseEffect[item.id]
            const Icon = item.icon

            return (
              <div
                key={item.id}
                ref={(el) => (nodeRefs.current[item.id] = el)}
                className="absolute cursor-pointer group"
                style={{
                  // No CSS transition on position — rAF handles the smoothness
                  transform: `translate(${position.x}px, ${position.y}px)`,
                  zIndex: isExpanded ? 200 : position.zIndex,
                  transition: 'opacity 0.4s ease, z-index 0s',
                  opacity: isExpanded ? 1 : position.opacity,
                }}
                onClick={(e) => { e.stopPropagation(); toggleItem(item.id) }}
              >
                {/* Energy halo */}
                <div
                  className={`absolute rounded-full ${isPulsing ? 'animate-pulse' : ''}`}
                  style={{
                    background: 'radial-gradient(circle, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0) 70%)',
                    width: `${item.energy * 0.55 + 56}px`,
                    height: `${item.energy * 0.55 + 56}px`,
                    left: `-${(item.energy * 0.55 + 56 - 56) / 2}px`,
                    top: `-${(item.energy * 0.55 + 56 - 56) / 2}px`,
                  }}
                />

                {/* Node circle — bigger: w-14 h-14 */}
                <div
                  className={[
                    'w-14 h-14 rounded-full flex items-center justify-center border-2 transition-all duration-200 ease-out transform',
                    isExpanded
                      ? 'bg-white text-black border-white shadow-lg shadow-white/30 scale-125'
                      : isRelated
                      ? 'bg-white/50 text-black border-white animate-pulse'
                      : 'bg-black text-white border-white/40 group-hover:border-white/80 group-hover:bg-white/10 group-hover:scale-110 group-hover:shadow-md group-hover:shadow-white/20',
                  ].join(' ')}
                >
                  <Icon size={20} />
                </div>

                {/* Label */}
                <div
                  className={[
                    'absolute top-16 whitespace-nowrap text-xs font-semibold tracking-wider transition-all duration-200',
                    isExpanded ? 'text-white' : 'text-white/65',
                  ].join(' ')}
                  style={{ transform: 'translateX(-50%)', left: '50%' }}
                >
                  {item.title}
                </div>

                {/* Expanded card */}
                {isExpanded && (
                  <Card className="absolute top-[76px] left-1/2 -translate-x-1/2 w-64 bg-black/90 backdrop-blur-lg border-white/30 shadow-xl shadow-white/10 overflow-visible">
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2 w-px h-3 bg-white/50" />
                    <CardHeader className="pb-2">
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-mono text-white/40">{item.date}</span>
                      </div>
                      <CardTitle className="text-sm mt-1 text-white">{item.title}</CardTitle>
                    </CardHeader>
                    <CardContent className="text-xs text-white/80">
                      <p className="leading-relaxed">{item.content}</p>

                      <div className="mt-4 pt-3 border-t border-white/10">
                        <div className="flex justify-between items-center text-xs mb-1">
                          <span className="flex items-center gap-1">
                            <Zap size={10} />
                            Relevance
                          </span>
                          <span className="font-mono">{item.energy}%</span>
                        </div>
                        <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-gradient-to-r from-blue-500 to-purple-500"
                            style={{ width: `${item.energy}%` }}
                          />
                        </div>
                      </div>

                      {item.relatedIds.length > 0 && (
                        <div className="mt-4 pt-3 border-t border-white/10">
                          <div className="flex items-center mb-2 gap-1">
                            <Link size={10} className="text-white/70" />
                            <h4 className="text-xs uppercase tracking-wider font-medium text-white/70">
                              Connected
                            </h4>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {item.relatedIds.map((relatedId) => {
                              const relatedItem = timelineData.find((i) => i.id === relatedId)
                              return (
                                <Button
                                  key={relatedId}
                                  variant="outline"
                                  size="sm"
                                  className="flex items-center h-6 px-2 py-0 text-xs rounded-none border-white/20 bg-transparent hover:bg-white/20 hover:border-white/50 text-white/70 hover:text-white hover:scale-105 transition-all duration-200 ease-out"
                                  onClick={(e) => { e.stopPropagation(); toggleItem(relatedId) }}
                                >
                                  {relatedItem?.title}
                                  <ArrowRight size={8} className="ml-1 text-white/60" />
                                </Button>
                              )
                            })}
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
