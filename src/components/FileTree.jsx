import { useState } from 'react'
import { FileTextIcon } from '@radix-ui/react-icons'
import { cn } from '@/lib/utils'

function TreeNode({ node, depth = 0, keyFilesMap, selectedPath, onSelect }) {
  const [open, setOpen] = useState(depth < 2)
  const indent = depth * 16

  if (node.type === 'file') {
    const fileInfo = keyFilesMap?.[node.path]
    const isSelected = selectedPath === node.path

    return (
      <div>
        <div
          className={cn(
            'tree-node tree-node--file',
            fileInfo && 'cursor-pointer transition-colors duration-150 hover:text-white/60',
            isSelected && 'text-white/75',
          )}
          style={{ paddingLeft: indent }}
          onClick={fileInfo ? () => onSelect(isSelected ? null : node.path) : undefined}
          role={fileInfo ? 'button' : undefined}
          tabIndex={fileInfo ? 0 : undefined}
          onKeyDown={fileInfo ? (e) => e.key === 'Enter' && onSelect(isSelected ? null : node.path) : undefined}
        >
          <span className="tree-icon">{fileInfo ? (isSelected ? '🔍' : '✦') : '📄'}</span>
          {node.name}
          {fileInfo && (
            <span className="ml-1.5 text-white/20 text-[0.7em]">·</span>
          )}
        </div>

        {isSelected && fileInfo && (
          <div
            className="text-white/50 text-[0.78em] leading-relaxed py-1.5 pr-3 border-l border-white/10 ml-1"
            style={{ paddingLeft: indent + 20 }}
          >
            {fileInfo.role}
          </div>
        )}
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
        <TreeNode
          key={child.path}
          node={child}
          depth={depth + 1}
          keyFilesMap={keyFilesMap}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}

export default function FileTree({ nodes, keyFiles }) {
  const [selectedPath, setSelectedPath] = useState(null)

  if (!nodes?.length) return null

  // Build a lookup map from path → { role }
  const keyFilesMap = {}
  for (const f of (keyFiles ?? [])) {
    keyFilesMap[f.path] = { role: f.role }
  }

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl mb-8',
        'bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm',
        '[box-shadow:0_0_0_1px_rgba(255,255,255,0.04)_inset]',
      )}
    >
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-slate-500/10 via-neutral-400/5 to-transparent" />

      <div className="relative z-10 flex flex-col gap-4 p-6">
        <div className="flex items-center gap-2">
          <FileTextIcon className="h-5 w-5 shrink-0 text-neutral-500" />
          <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
            File Structure
          </h3>
          {Object.keys(keyFilesMap).length > 0 && (
            <span className="text-[0.7em] text-white/20 ml-auto">✦ click to inspect</span>
          )}
        </div>
        <div className="file-tree">
          {nodes.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              keyFilesMap={keyFilesMap}
              selectedPath={selectedPath}
              onSelect={setSelectedPath}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
