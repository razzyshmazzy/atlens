const STEPS = [
  null,
  'Cloning repository…',
  'Reading files…',
  'Generating overview…',
]

// Animated multi-step loading indicator
export default function LoadingState({ step, visible }) {
  if (!visible || step === 0) return null

  return (
    <div className="loading-state" aria-live="polite">
      <span className="loading-spinner" aria-hidden="true" />
      <span>{STEPS[step] ?? 'Working…'}</span>
    </div>
  )
}
