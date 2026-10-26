// Yard — offline batch file compression
// Copyright (C) 2026 Yard Contributors
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

import { useRef } from 'react'
import { LayoutGroup, MotionConfig, motion } from 'motion/react'
import { Lane } from '@/components/run/Lane'
import { filterFiles, groupByCategory, type StatusFilter } from '@/lib/grouping'
import type { FileEntry } from '@/types'

export interface KanbanBoardProps {
  roster: FileEntry[]
  statusFilter: StatusFilter
  onFilterChange: (f: StatusFilter) => void
  progress?: Record<string, number>
  onCancel: (fileId: string) => void
  onReveal: (path: string) => void
  onRemove: (fileId: string) => void
  removeDisabled?: boolean
}

const EMPTY_WORDS: Record<Exclude<StatusFilter, 'all'>, string> = {
  compressing: 'processing',
  complete: 'complete',
  below_target: 'below target',
  failed: 'failed',
  queued: 'queued',
}

export function KanbanBoard({
  roster,
  statusFilter,
  onFilterChange,
  progress,
  onCancel,
  onReveal,
  onRemove,
  removeDisabled,
}: KanbanBoardProps) {
  const boardRef = useRef<HTMLDivElement | null>(null)
  const lanes = groupByCategory(filterFiles(roster, statusFilter))

  return (
    <MotionConfig reducedMotion="user">
      <LayoutGroup>
        {lanes.length === 0 ? (
          <div
            data-testid="board-empty"
            className="flex min-h-[240px] flex-col items-center justify-center gap-1.5"
          >
            <p className="text-[13px] text-muted-foreground">
              Nothing {statusFilter === 'all' ? 'here' : EMPTY_WORDS[statusFilter]} right now
            </p>
            <button
              type="button"
              data-testid="show-all"
              className="cursor-pointer text-[12.5px] text-primary underline-offset-2 hover:underline"
              onClick={() => onFilterChange('all')}
            >
              Show all
            </button>
          </div>
        ) : (
          <div
            ref={boardRef}
            data-testid="kanban-board"
            className="flex h-full items-start gap-3 select-none overflow-x-auto pb-3 pr-6"
            onWheel={(event) => {
              if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
                event.currentTarget.scrollLeft += event.deltaY
              }
            }}
          >
            {lanes.map((lane) => (
              <motion.div
                key={lane.category}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="shrink-0 h-full"
              >
                <Lane
                  category={lane.category}
                  files={lane.files}
                  progress={progress}
                  onCancel={onCancel}
                  onReveal={onReveal}
                  onRemove={removeDisabled ? undefined : onRemove}
                />
              </motion.div>
            ))}
          </div>
        )}
      </LayoutGroup>
    </MotionConfig>
  )
}
