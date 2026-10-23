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

import { describe, it, expect } from 'vitest'
import {
  batchLabel,
  countOutcome,
  describeSince,
  fileCountLabel,
  formatDuration,
  presetSinceMs,
  dayLabel,
  dayKey,
  savedLabel,
  savedPercent,
} from '@/lib/historyFormat'
import type { HistoryFile, SessionOutcome } from '@/types'

describe('historyFormat', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('—')
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(102_000)).toBe('1m 42s')
    expect(formatDuration(7_500_000)).toBe('2h 05m')
  })

  it('maps presets to local midnights', () => {
    const now = new Date(2026, 9, 2, 14, 30)
    const today = new Date(2026, 9, 2).getTime()
    expect(presetSinceMs('today', now)).toBe(today)
    expect(presetSinceMs('last7', now)).toBe(new Date(2026, 8, 26).getTime())
    expect(presetSinceMs('last30', now)).toBe(new Date(2026, 8, 3).getTime())
    expect(presetSinceMs('all', now)).toBeUndefined()
  })

  it('labels today and yesterday', () => {
    const now = new Date(2026, 9, 2, 14, 30)
    expect(dayLabel(new Date(2026, 9, 2, 9, 0).getTime(), now)).toBe('Today')
    expect(dayLabel(new Date(2026, 9, 1, 9, 0).getTime(), now)).toBe('Yesterday')
    const sep = dayLabel(new Date(2026, 8, 20).getTime(), now)
    expect(sep).toMatch(/Sep/)
    expect(sep).not.toMatch(/2026/)
    expect(dayLabel(new Date(2025, 8, 20).getTime(), now)).toMatch(/2025/)
  })

  it('pins DST transition midnights and year rollover', () => {
    const spring = new Date(2026, 2, 8, 15, 0)
    expect(presetSinceMs('today', spring)).toBe(new Date(2026, 2, 8).getTime())
    const fall = new Date(2026, 10, 1, 15, 0)
    expect(presetSinceMs('today', fall)).toBe(new Date(2026, 10, 1).getTime())
    const euSpring = new Date(2026, 2, 29, 15, 0)
    expect(presetSinceMs('today', euSpring)).toBe(new Date(2026, 2, 29).getTime())
    const euFall = new Date(2026, 9, 25, 15, 0)
    expect(presetSinceMs('today', euFall)).toBe(new Date(2026, 9, 25).getTime())
    const rollover = new Date(2027, 0, 1, 1, 0)
    expect(presetSinceMs('last7', rollover)).toBe(new Date(2026, 11, 26).getTime())
    const spanning = new Date(2026, 9, 26, 15, 0)
    expect(presetSinceMs('last7', spanning)).toBe(new Date(2026, 9, 20).getTime())
  })

  it('keys days by local calendar date', () => {
    const morning = new Date(2026, 9, 2, 9, 0).getTime()
    const night = new Date(2026, 9, 2, 23, 59).getTime()
    const nextDay = new Date(2026, 9, 3, 0, 1).getTime()
    expect(dayKey(morning)).toBe(dayKey(night))
    expect(dayKey(morning)).not.toBe(dayKey(nextDay))
  })

  it('formats duration boundaries', () => {
    expect(formatDuration(-5)).toBe('—')
    expect(formatDuration(999)).toBe('1s')
    expect(formatDuration(1_000)).toBe('1s')
    expect(formatDuration(59_999)).toBe('59s')
    expect(formatDuration(60_000)).toBe('1m 00s')
    expect(formatDuration(3_599_999)).toBe('59m 59s')
    expect(formatDuration(3_600_000)).toBe('1h 00m')
  })

  it('labels yesterday across year boundary', () => {
    const now = new Date(2027, 0, 1, 3, 0)
    expect(dayLabel(new Date(2026, 11, 31, 20, 0).getTime(), now)).toBe('Yesterday')
  })
})

const timeLabel = (ms: number): string =>
  new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(ms)
  )

describe('batchLabel', () => {
  const now = new Date(2026, 9, 23, 15, 0)

  it('labels today, yesterday and other days with the batch time', () => {
    const today = new Date(2026, 9, 23, 14, 31).getTime()
    const yesterday = new Date(2026, 9, 22, 18, 20).getTime()
    const other = new Date(2026, 9, 20, 16, 48).getTime()
    expect(batchLabel(today, now)).toBe(`Today · ${timeLabel(today)}`)
    expect(batchLabel(yesterday, now)).toBe(`Yesterday · ${timeLabel(yesterday)}`)
    expect(batchLabel(other, now)).toBe(`${dayLabel(other, now)} · ${timeLabel(other)}`)
  })
})

describe('describeSince', () => {
  const now = new Date(2026, 9, 23, 15, 0)

  it('names the presets', () => {
    expect(describeSince(undefined, now)).toBe('All time')
    expect(describeSince(presetSinceMs('today', now), now)).toBe('Today')
    expect(describeSince(presetSinceMs('last7', now), now)).toBe('Last 7 days')
    expect(describeSince(presetSinceMs('last30', now), now)).toBe('Last 30 days')
    expect(describeSince(new Date(2026, 9, 1).getTime(), now)).toBe('This month')
  })

  it('falls back to the calendar date for a custom start', () => {
    const custom = new Date(2026, 8, 20).getTime()
    expect(describeSince(custom, now)).toBe(dayLabel(custom, now))
    expect(describeSince(custom, now)).toMatch(/20/)
    expect(describeSince(new Date(2025, 8, 20).getTime(), now)).toMatch(/2025/)
  })
})

const fileWithStatus = (status: HistoryFile['status']): HistoryFile => ({
  name: `${status}.bin`,
  path: `/tmp/${status}.bin`,
  outputPath: null,
  category: 'other',
  targetBytes: 100,
  originalSize: 200,
  compressedSize: null,
  status,
  qualityUsed: null,
  strategyUsed: null,
  error: null,
  durationMs: 10,
  completedAt: 0,
})

describe('history aggregates', () => {
  it('formats saved bytes and file counts', () => {
    expect(savedLabel(0)).toBe('0 B')
    expect(savedLabel(1536)).toBe('2 KB')
    expect(fileCountLabel(0)).toBe('0 files')
    expect(fileCountLabel(1)).toBe('1 file')
    expect(fileCountLabel(12)).toBe('12 files')
  })

  it('computes the saved percentage', () => {
    expect(savedPercent(0, 0)).toBe(0)
    expect(savedPercent(100, 25)).toBe(75)
    expect(savedPercent(3, 2)).toBe(33)
    expect(savedPercent(100, 150)).toBe(0)
  })

  it('counts session outcomes', () => {
    const expected: SessionOutcome = {
      done: 2,
      bestEffort: 1,
      failed: 1,
      cancelled: 0,
      unsupported: 1,
      alreadyUnderTarget: 1,
    }
    expect(
      countOutcome([
        fileWithStatus('done'),
        fileWithStatus('done'),
        fileWithStatus('best_effort'),
        fileWithStatus('failed'),
        fileWithStatus('unsupported'),
        fileWithStatus('already_under_target'),
        fileWithStatus('pending'),
      ])
    ).toEqual(expected)
  })
})
