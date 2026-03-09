import { useState } from 'react'
import { FileTextIcon } from '@radix-ui/react-icons'
import { cn } from '@/lib/utils'

// Recursive collapsible file tree node
function TreeNode({ node, depth = 0 }) {
  const [open, setOpen] = useState(depth < 2)  // Auto-expand first 2 levels

  const indent = depth * 16

  if (node.type === 'file') {
    return (
      <div className="tree-node tree-node--file" style={{ paddingLeft: indent }}>
        <span className="tree-icon">📄</span>
        {node.name}
      </div>
    )
  }

  // Directory
  return (
    <div>
      <div
        className="tree-node tree-node--dir"
        style={{ paddingLeft: indent }}
        onClick={() => setOpen((o) => !o)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="tree-icon">{open ? '📂' : '📁'}</span>
        {node.name}
      </div>
      {open && node.children?.map((child) => (
        <TreeNode key={child.path} node={child} depth={depth + 1} />
      ))}
    </div>
  )
}

// Renders the full file tree returned by the server
export default function FileTree({ nodes }) {
  if (!nodes?.length) return null

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl mb-8',
        'bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm',
        '[box-shadow:0_0_0_1px_rgba(255,255,255,0.04)_inset]',
      )}
    >
      {/* Subtle green gradient accent */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-slate-500/10 via-neutral-400/5 to-transparent" />

      <div className="relative z-10 flex flex-col gap-4 p-6">
        <div className="flex items-center gap-2">
          <FileTextIcon className="h-5 w-5 shrink-0 text-neutral-500" />
          <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
            File Structure
          </h3>
        </div>
        <div className="file-tree">
          {nodes.map((node) => <TreeNode key={node.path} node={node} />)}
        </div>
      </div>
    </div>
  )
}
