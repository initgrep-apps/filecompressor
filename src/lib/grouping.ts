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

export const LANE_ORDER = ['image', 'video', 'pdf', 'document', 'other'] as const satisfies readonly Category[]

export interface CategoryLane {
  category: Category
  files: FileEntry[]
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

type CountBucket = 'processing' | 'complete' | 'belowTarget' | 'failed' | 'queued'

const STATUS_BUCKETS: Record<FileStatus, CountBucket | 'processedOnly' | 'unsupported'> = {
  pending: 'queued',
  compressing: 'processing',
  done: 'complete',
  best_effort: 'complete',
  failed: 'failed',
  cancelled: 'processedOnly',
  unsupported: 'unsupported',
  already_under_target: 'belowTarget',
}

export function isTerminal(status: FileStatus): boolean {
  const bucket = STATUS_BUCKETS[status]
  return bucket !== 'unsupported' && bucket !== 'processing' && bucket !== 'queued'
}

function laneRank(status: FileStatus): number {
  if (status === 'compressing') return 0
  if (isTerminal(status)) return 1
  return 2
}

export function groupByCategory(files: FileEntry[]): Array<CategoryLane> {
  const lanes = new Map<Category, FileEntry[]>()
  for (const file of files) {
    if (STATUS_BUCKETS[file.status] === 'unsupported') continue
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
    const bucket = STATUS_BUCKETS[file.status]
    if (bucket === 'unsupported') continue
    counts.all += 1
    if (bucket !== 'processing' && bucket !== 'queued') counts.processed += 1
    if (bucket !== 'processedOnly') counts[bucket] += 1
  }
  return counts
}

export function laneDonePill(files: FileEntry[]): { done: number; total: number } {
  const inLane = files.filter((file) => STATUS_BUCKETS[file.status] !== 'unsupported')
  const done = inLane.filter((file) => isTerminal(file.status)).length
  return { done, total: inLane.length }
}

const FILTER_PREDICATES: Record<Exclude<StatusFilter, 'all'>, (status: FileStatus) => boolean> = {
  compressing: (status) => STATUS_BUCKETS[status] === 'processing',
  complete: (status) => STATUS_BUCKETS[status] === 'complete',
  below_target: (status) => STATUS_BUCKETS[status] === 'belowTarget',
  failed: (status) => STATUS_BUCKETS[status] === 'failed',
  queued: (status) => STATUS_BUCKETS[status] === 'queued',
}

export function filterFiles(files: FileEntry[], filter: StatusFilter): FileEntry[] {
  if (filter === 'all') return files.slice()
  const predicate = FILTER_PREDICATES[filter]
  return files.filter((file) => predicate(file.status))
}
