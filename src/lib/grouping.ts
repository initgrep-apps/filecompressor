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

type MissingLanes = Exclude<Category, (typeof LANE_ORDER)[number]>
type AssertNever<T extends never> = T
export type LaneOrderCoverage = AssertNever<MissingLanes>

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
type StatusBucket = CountBucket | 'processedOnly' | 'unsupported'

const STATUS_BUCKETS: Record<FileStatus, StatusBucket> = {
  pending: 'queued',
  compressing: 'processing',
  done: 'complete',
  best_effort: 'complete',
  failed: 'failed',
  cancelled: 'processedOnly',
  unsupported: 'unsupported',
  already_under_target: 'belowTarget',
}

const WARNED = new Set<string>()

function warnOnce(message: string): void {
  if (WARNED.has(message)) return
  WARNED.add(message)
  console.warn(message)
}

function bucketOf(status: FileStatus): StatusBucket {
  const bucket = STATUS_BUCKETS[status]
  if (bucket) return bucket
  warnOnce(`unknown file status "${status}" treated as processed-only`)
  return 'processedOnly'
}

function laneOf(category: Category): Category {
  if (LANE_ORDER.includes(category)) return category
  warnOnce(`unknown file category "${category}" filed under other`)
  return 'other'
}

function countsTowardProcessed(bucket: StatusBucket): boolean {
  return bucket !== 'unsupported' && bucket !== 'processing' && bucket !== 'queued'
}

export function isTerminal(status: FileStatus): boolean {
  return countsTowardProcessed(bucketOf(status))
}

function laneRank(status: FileStatus): number {
  const bucket = bucketOf(status)
  if (bucket === 'processing') return 0
  if (countsTowardProcessed(bucket)) return 1
  return 2
}

export function groupByCategory(files: FileEntry[]): Array<CategoryLane> {
  const lanes = new Map<Category, FileEntry[]>()
  for (const file of files) {
    if (bucketOf(file.status) === 'unsupported') continue
    const category = laneOf(file.category)
    const lane = lanes.get(category)
    if (lane) {
      lane.push(file)
    } else {
      lanes.set(category, [file])
    }
  }
  return LANE_ORDER.flatMap((category) => {
    const lane = lanes.get(category)
    if (!lane) return []
    const ranked = lane.map((file) => ({ file, rank: laneRank(file.status) }))
    ranked.sort((a, b) => a.rank - b.rank)
    return [{ category, files: ranked.map((entry) => entry.file) }]
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
    const bucket = bucketOf(file.status)
    if (bucket === 'unsupported') continue
    counts.all += 1
    if (countsTowardProcessed(bucket)) counts.processed += 1
    if (bucket !== 'processedOnly') counts[bucket] += 1
  }
  return counts
}

export function laneDonePill(files: FileEntry[]): { done: number; total: number } {
  const inLane = files.filter((file) => bucketOf(file.status) !== 'unsupported')
  const done = inLane.filter((file) => countsTowardProcessed(bucketOf(file.status))).length
  return { done, total: inLane.length }
}

const FILTER_PREDICATES: Record<Exclude<StatusFilter, 'all'>, (status: FileStatus) => boolean> = {
  compressing: (status) => bucketOf(status) === 'processing',
  complete: (status) => bucketOf(status) === 'complete',
  below_target: (status) => bucketOf(status) === 'belowTarget',
  failed: (status) => bucketOf(status) === 'failed',
  queued: (status) => bucketOf(status) === 'queued',
}

export function filterFiles(files: FileEntry[], filter: StatusFilter): FileEntry[] {
  if (filter === 'all') return files.slice()
  const predicate = FILTER_PREDICATES[filter]
  return files.filter((file) => predicate(file.status))
}
