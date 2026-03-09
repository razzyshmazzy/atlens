import {
  InfoCircledIcon,
  StackIcon,
  ComponentInstanceIcon,
  EnterIcon,
  FileIcon,
  GearIcon,
  QuestionMarkCircledIcon,
} from '@radix-ui/react-icons'
import { cn } from '@/lib/utils'
import { BentoGrid } from './ui/bento-grid'

// A result card that mirrors BentoCard styling but shows all content inline
function ResultCard({ Icon, name, children, className, gradient }) {
  return (
    <div
      className={cn(
        'relative col-span-3 flex flex-col overflow-hidden rounded-2xl',
        'bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm',
        '[box-shadow:0_0_0_1px_rgba(255,255,255,0.04)_inset]',
        className,
      )}
    >
      {/* Gradient accent in the top-left corner */}
      <div className={cn('pointer-events-none absolute inset-0', gradient)} />

      <div className="relative z-10 flex flex-col gap-4 p-6">
        {/* Card header */}
        <div className="flex items-center gap-2">
          <Icon className="h-5 w-5 shrink-0 text-neutral-500" />
          <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
            {name}
          </h3>
        </div>

        {/* Card content */}
        <div className="text-neutral-200">{children}</div>
      </div>
    </div>
  )
}

export default function RepoOverview({ analysis }) {
  if (!analysis) return null

  const {
    purpose,
    techStack,
    architecture,
    entryPoints,
    keyFiles,
    setupInstructions,
    openQuestions,
  } = analysis

  return (
    <BentoGrid className="auto-rows-auto lg:grid-cols-3 mb-4">
      {/* ── Purpose ─────────────────────────────────────────── */}
      {purpose && (
        <ResultCard
          Icon={InfoCircledIcon}
          name="What it does"
          gradient="bg-gradient-to-br from-blue-600/20 via-indigo-500/10 to-transparent"
          className="lg:col-span-2"
        >
          <p className="leading-relaxed text-base">{purpose}</p>
        </ResultCard>
      )}

      {/* ── Tech Stack ──────────────────────────────────────── */}
      {techStack && (
        <ResultCard
          Icon={StackIcon}
          name="Tech Stack"
          gradient="bg-gradient-to-br from-violet-600/20 via-purple-500/10 to-transparent"
          className="lg:col-span-1"
        >
          <div className="flex flex-col gap-3">
            {techStack.languages?.length > 0 && (
              <div>
                <p className="mb-1 text-xs uppercase tracking-wider text-neutral-400 text-neutral-600">
                  Languages
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {techStack.languages.map((l) => (
                    <span key={l} className="tech-tag">{l}</span>
                  ))}
                </div>
              </div>
            )}
            {techStack.frameworks?.length > 0 && (
              <div>
                <p className="mb-1 text-xs uppercase tracking-wider text-neutral-400 text-neutral-600">
                  Frameworks
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {techStack.frameworks.map((f) => (
                    <span key={f} className="tech-tag">{f}</span>
                  ))}
                </div>
              </div>
            )}
            {techStack.tools?.length > 0 && (
              <div>
                <p className="mb-1 text-xs uppercase tracking-wider text-neutral-400 text-neutral-600">
                  Tools
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {techStack.tools.map((t) => (
                    <span key={t} className="tech-tag">{t}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </ResultCard>
      )}

      {/* ── Architecture ─────────────────────────────────────── */}
      {architecture && (
        <ResultCard
          Icon={ComponentInstanceIcon}
          name="Architecture"
          gradient="bg-gradient-to-br from-teal-500/20 via-cyan-400/10 to-transparent"
          className="lg:col-span-3"
        >
          <p className="leading-relaxed text-base">{architecture}</p>
        </ResultCard>
      )}

      {/* ── Entry Points ─────────────────────────────────────── */}
      {entryPoints?.length > 0 && (
        <ResultCard
          Icon={EnterIcon}
          name="Entry Points"
          gradient="bg-gradient-to-br from-emerald-500/20 via-green-400/10 to-transparent"
          className="lg:col-span-1"
        >
          <ul className="flex flex-col gap-1.5">
            {entryPoints.map((ep) => (
              <li key={ep}>
                <code className="text-[0.82em] text-[var(--color-accent)]">{ep}</code>
              </li>
            ))}
          </ul>
        </ResultCard>
      )}

      {/* ── Key Files ────────────────────────────────────────── */}
      {keyFiles?.length > 0 && (
        <ResultCard
          Icon={FileIcon}
          name="Key Files"
          gradient="bg-gradient-to-br from-orange-500/20 via-amber-400/10 to-transparent"
          className={entryPoints?.length > 0 ? 'lg:col-span-2' : 'lg:col-span-3'}
        >
          <div className="flex flex-col gap-2">
            {keyFiles.map((f) => (
              <div key={f.path} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
                <code className="shrink-0 text-[0.82em] text-[var(--color-accent)] sm:w-48 truncate">
                  {f.path}
                </code>
                <span className="text-sm text-neutral-500 text-neutral-400">{f.role}</span>
              </div>
            ))}
          </div>
        </ResultCard>
      )}

      {/* ── Setup ────────────────────────────────────────────── */}
      {setupInstructions && (
        <ResultCard
          Icon={GearIcon}
          name="Setup"
          gradient="bg-gradient-to-br from-pink-500/20 via-rose-400/10 to-transparent"
          className={openQuestions?.length > 0 ? 'lg:col-span-2' : 'lg:col-span-3'}
        >
          <pre className="setup overflow-x-auto text-sm leading-relaxed whitespace-pre-wrap">
            {setupInstructions}
          </pre>
        </ResultCard>
      )}

      {/* ── Open Questions ───────────────────────────────────── */}
      {openQuestions?.length > 0 && (
        <ResultCard
          Icon={QuestionMarkCircledIcon}
          name="Worth Investigating"
          gradient="bg-gradient-to-br from-yellow-500/20 via-amber-400/10 to-transparent"
          className={setupInstructions ? 'lg:col-span-1' : 'lg:col-span-3'}
        >
          <ul className="flex flex-col gap-2">
            {openQuestions.map((q, i) => (
              <li key={i} className="flex gap-2 text-sm leading-snug">
                <span className="mt-0.5 text-neutral-400">→</span>
                <span>{q}</span>
              </li>
            ))}
          </ul>
        </ResultCard>
      )}
    </BentoGrid>
  )
}
