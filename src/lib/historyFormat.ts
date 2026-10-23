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

import { formatSize } from '@/lib/sizeFormat'
import type { FileStatus, HistoryFile, SessionOutcome } from '@/types'

export function savedLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  return bytes === 0 ? '0 B' : formatSize(bytes)
}

export function fileCountLabel(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '—'
  return count === 1 ? '1 file' : `${count} files`
}

export function savedPercent(original: number, compressed: number | null): number | null {
  if (!Number.isFinite(original) || original <= 0) return null
  if (compressed === null || !Number.isFinite(compressed) || compressed < 0) return null
  return Math.max(0, Math.round(((original - compressed) / original) * 100))
}

const OUTCOME_COUNT_KEYS: Record<FileStatus, keyof SessionOutcome | null> = {
  pending: null,
  compressing: null,
  done: 'done',
  best_effort: 'bestEffort',
  failed: 'failed',
  cancelled: 'cancelled',
  unsupported: 'unsupported',
  already_under_target: 'alreadyUnderTarget',
}

export function countOutcome(files: HistoryFile[]): SessionOutcome {
  const counts: SessionOutcome = {
    done: 0,
    bestEffort: 0,
    failed: 0,
    cancelled: 0,
    unsupported: 0,
    alreadyUnderTarget: 0,
  }
  return files.reduce((acc, file) => {
    const key = Object.prototype.hasOwnProperty.call(OUTCOME_COUNT_KEYS, file.status)
      ? OUTCOME_COUNT_KEYS[file.status]
      : null
    if (key != null) acc[key] += 1
    return acc
  }, counts)
}

export function batchLabel(ms: number, now: Date): string {
  if (!Number.isFinite(ms)) return '—'
  const date = new Date(ms)
  if (!Number.isFinite(date.getTime())) return '—'
  const time = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
  return `${dayLabel(ms, now)} · ${time}`
}

export function describeSince(ms: number | undefined, now: Date): string {
  if (ms === undefined) return 'All time'
  if (!Number.isFinite(ms)) return '—'
  if (ms === presetSinceMs('today', now)) return 'Today'
  if (ms === presetSinceMs('last7', now)) return 'Last 7 days'
  if (ms === presetSinceMs('last30', now)) return 'Last 30 days'
  if (ms === new Date(now.getFullYear(), now.getMonth(), 1).getTime()) return 'This month'
  return dayLabel(ms, now)
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.floor(ms / 1_000))
    return `${seconds}s`
  }
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000)
    const seconds = Math.floor((ms % 60_000) / 1_000)
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  }
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  return `${hours}h ${String(minutes).padStart(2, '0')}m`
}

export type DatePreset = 'today' | 'last7' | 'last30' | 'all'

export function presetSinceMs(preset: DatePreset, now: Date): number | undefined {
  if (preset === 'all') return undefined
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (preset === 'today') return start.getTime()
  const days = preset === 'last7' ? 6 : 29
  start.setDate(start.getDate() - days)
  return start.getTime()
}

export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

export function dayLabel(ms: number, now: Date): string {
  const date = new Date(ms)
  if (!Number.isFinite(ms) || !Number.isFinite(date.getTime())) return '—'
  const key = dayKey(ms)
  if (key === dayKey(now.getTime())) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (key === dayKey(yesterday.getTime())) return 'Yesterday'
  const includeYear = date.getFullYear() !== now.getFullYear()
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(includeYear ? { year: 'numeric' } : {}),
  }).format(date)
}
