import {
  Info,
  Layers,
  GitBranch,
  LogIn,
  Settings,
  HelpCircle,
} from 'lucide-react'
import RadialOrbitalTimeline from './ui/radial-orbital-timeline'

function buildTimelineItems(analysis) {
  const items = []
  let id = 1

  const clip = (str, max) =>
    str && str.length > max ? str.slice(0, max - 1) + '…' : str

  if (analysis.purpose) {
    items.push({
      id: id++,
      title: 'Overview',
      date: 'Purpose',
      content: clip(analysis.purpose, 120),
      category: 'Overview',
      icon: Info,
      relatedIds: [],
      status: 'completed',
      energy: 100,
    })
  }

  if (analysis.techStack) {
    const all = [
      ...(analysis.techStack.languages ?? []),
      ...(analysis.techStack.frameworks ?? []),
      ...(analysis.techStack.tools ?? []),
    ]
    items.push({
      id: id++,
      title: 'Tech Stack',
      date: all.slice(0, 3).join(' · '),
      content: all.join(', ') || 'No stack detected',
      category: 'Tech',
      icon: Layers,
      relatedIds: [],
      status: 'completed',
      energy: 90,
    })
  }

  if (analysis.architecture) {
    items.push({
      id: id++,
      title: 'Architecture',
      date: 'Structure',
      content: clip(analysis.architecture, 110),
      category: 'Architecture',
      icon: GitBranch,
      relatedIds: [],
      status: 'completed',
      energy: 85,
    })
  }

  if (analysis.entryPoints?.length > 0) {
    items.push({
      id: id++,
      title: 'Entry Points',
      date: `${analysis.entryPoints.length} file${analysis.entryPoints.length > 1 ? 's' : ''}`,
      content: analysis.entryPoints.join('\n'),
      category: 'Entry',
      icon: LogIn,
      relatedIds: [],
      status: 'completed',
      energy: 80,
    })
  }

  if (analysis.setupInstructions) {
    items.push({
      id: id++,
      title: 'Setup',
      date: 'Instructions',
      content: clip(analysis.setupInstructions, 130),
      category: 'Setup',
      icon: Settings,
      relatedIds: [],
      status: 'pending',
      energy: 55,
    })
  }

  if (analysis.openQuestions?.length > 0) {
    items.push({
      id: id++,
      title: 'Questions',
      date: `${analysis.openQuestions.length} open`,
      content: analysis.openQuestions.join(' · '),
      category: 'Questions',
      icon: HelpCircle,
      relatedIds: [],
      status: 'pending',
      energy: 40,
    })
  }

  // Wire up circular connections so every node links to its neighbours
  for (let i = 0; i < items.length; i++) {
    const prev = (i - 1 + items.length) % items.length
    const next = (i + 1) % items.length
    items[i].relatedIds = [items[prev].id, items[next].id]
  }

  return items
}

export default function RepoOrbital({ analysis }) {
  if (!analysis) return null

  const timelineData = buildTimelineItems(analysis)
  if (timelineData.length < 3) return null

  return (
    <div
      className="relative overflow-hidden rounded-2xl mb-8"
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 0 0 1px rgba(255,255,255,0.04) inset',
      }}
    >
      {/* Section label */}
      <div className="absolute top-5 left-6 z-20 flex items-center gap-2">
        <GitBranch className="h-4 w-4 text-neutral-500" />
        <span className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
          Repository Map
        </span>
      </div>

      {/* Orbital canvas */}
      <div style={{ height: '560px' }}>
        <RadialOrbitalTimeline timelineData={timelineData} />
      </div>
    </div>
  )
}
