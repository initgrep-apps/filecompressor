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

import type { Category, FileEntry, FileStatus } from '@/types'

export type StatusFilter = 'all' | 'compressing' | 'complete' | 'below_target' | 'failed' | 'queued'

export const LANE_ORDER: Category[] = ['image', 'video', 'pdf', 'document', 'other']

const TERMINAL_STATUSES: FileStatus[] = ['done', 'best_effort', 'already_under_target', 'failed', 'cancelled']

export function isTerminal(status: FileStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

function laneRank(status: FileStatus): number {
  if (status === 'compressing') return 0
  if (isTerminal(status)) return 1
  return 2
}

export function groupByCategory(files: FileEntry[]): Array<{ category: Category; files: FileEntry[] }> {
  const lanes = new Map<Category, FileEntry[]>()
  for (const file of files) {
    if (file.status === 'unsupported') continue
    const lane = lanes.get(file.category)
    if (lane) {
      lane.push(file)
    } else {
      lanes.set(file.category, [file])
    }
  }
  return LANE_ORDER.flatMap((category) => {
    const lane = lanes.get(category)
    return lane
      ? [{ category, files: lane.slice().sort((a, b) => laneRank(a.status) - laneRank(b.status)) }]
      : []
  })
}

export interface BatchCounts {
  all: number
  processing: number
  complete: number
  belowTarget: number
  failed: number
  queued: number
  processed: number
}

export function batchCounts(files: FileEntry[]): BatchCounts {
  const counts: BatchCounts = {
    all: 0,
    processing: 0,
    complete: 0,
    belowTarget: 0,
    failed: 0,
    queued: 0,
    processed: 0,
  }
  for (const file of files) {
    if (file.status === 'unsupported') continue
    counts.all += 1
    switch (file.status) {
      case 'compressing':
        counts.processing += 1
        break
      case 'done':
      case 'best_effort':
        counts.complete += 1
        counts.processed += 1
        break
      case 'already_under_target':
        counts.belowTarget += 1
        counts.processed += 1
        break
      case 'failed':
        counts.failed += 1
        counts.processed += 1
        break
      case 'cancelled':
        counts.processed += 1
        break
      case 'pending':
        counts.queued += 1
        break
    }
  }
  return counts
}

export function laneDonePill(files: FileEntry[]): { done: number; total: number } {
  const inLane = files.filter((file) => file.status !== 'unsupported')
  const done = inLane.filter((file) => isTerminal(file.status)).length
  return { done, total: inLane.length }
}

const FILTER_PREDICATES: Record<Exclude<StatusFilter, 'all'>, (status: FileStatus) => boolean> = {
  compressing: (status) => status === 'compressing',
  complete: (status) => status === 'done' || status === 'best_effort',
  below_target: (status) => status === 'already_under_target',
  failed: (status) => status === 'failed',
  queued: (status) => status === 'pending',
}

export function filterFiles(files: FileEntry[], filter: StatusFilter): FileEntry[] {
  if (filter === 'all') return files
  const predicate = FILTER_PREDICATES[filter]
  return files.filter((file) => predicate(file.status))
}
