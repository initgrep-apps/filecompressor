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

export function formatDuration(ms: number): string {
  if (ms <= 0) return '—'
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
  const key = dayKey(ms)
  if (key === dayKey(now.getTime())) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (key === dayKey(yesterday.getTime())) return 'Yesterday'
  const date = new Date(ms)
  const includeYear = date.getFullYear() !== now.getFullYear()
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(includeYear ? { year: 'numeric' } : {}),
  }).format(date)
}
