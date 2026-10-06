// File Size Optimizer — offline batch file compression
// Copyright (C) 2026 File Size Optimizer Contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import type { ReactNode } from 'react'
import { AnimatePresence } from 'motion/react'
import { laneDonePill } from '@/lib/grouping'
import { cn } from '@/lib/utils'
import { RunRow, type RunRowProps } from '@/components/run/RunRow'
import type { Category, FileEntry } from '@/types'

export interface LaneProps extends Pick<RunRowProps, 'onCancel' | 'onReveal' | 'onRemove'> {
  category: Category
  files: FileEntry[]
  progress?: Record<string, number>
}

const LANE_META: Record<Category, { label: string; tint: string }> = {
  image: { label: 'Image', tint: 'bg-blue-500/10 text-blue-600' },
  video: { label: 'Video', tint: 'bg-violet-500/10 text-violet-600' },
  pdf: { label: 'PDF', tint: 'bg-destructive/10 text-destructive' },
  document: { label: 'Document', tint: 'bg-amber-500/10 text-amber-600' },
  other: { label: 'Other', tint: 'bg-muted text-muted-foreground' },
}

const DOC_GLYPH_PATHS = (
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </>
)

const GLYPHS: Record<Category, ReactNode> = {
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </>
  ),
  video: (
    <>
      <path d="m22 8-6 4 6 4V8Z" />
      <rect x="2" y="6" width="14" height="12" rx="2" />
    </>
  ),
  pdf: DOC_GLYPH_PATHS,
  document: (
    <>
      {DOC_GLYPH_PATHS}
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </>
  ),
  other: (
    <>
      {DOC_GLYPH_PATHS}
      <line x1="16" y1="13" x2="8" y2="13" />
    </>
  ),
}

export function Lane({ category, files, progress, onCancel, onReveal, onRemove }: LaneProps) {
  const meta = LANE_META[category]
  const pill = laneDonePill(files)
  const live = files.some((file) => file.status === 'compressing')

  return (
    <div className="flex w-[318px] shrink-0 flex-col overflow-hidden rounded-[calc(var(--radius)+4px)] border border-border bg-card">
      <div className="flex items-center gap-[9px] border-b border-border/65 px-3 py-[11px]">
        <div
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-md',
            meta.tint
          )}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {GLYPHS[category]}
          </svg>
        </div>
        <span className="text-[12.5px] font-bold tracking-[0.01em] text-foreground">
          {meta.label}
        </span>
        <span
          data-testid="lane-pill"
          className={cn(
            'ml-auto rounded-full px-2 py-[2.5px] font-mono text-[10px] font-semibold tabular-nums',
            live ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
          )}
        >
          {pill.done}/{pill.total} done
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-[7px] overflow-y-auto p-[9px]">
        <AnimatePresence mode="popLayout">
          {files.map((file) => (
            <RunRow
              key={file.id}
              file={file}
              percent={progress?.[file.id]}
              onCancel={onCancel}
              onReveal={onReveal}
              onRemove={onRemove}
            />
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}
