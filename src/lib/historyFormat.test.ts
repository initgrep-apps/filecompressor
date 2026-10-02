import { describe, it, expect } from 'vitest'
import { formatDuration, presetSinceMs, dayLabel, dayKey } from '@/lib/historyFormat'

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
    const spanning = new Date(2026, 9, 25, 15, 0)
    expect(presetSinceMs('last7', spanning)).toBe(new Date(2026, 9, 19).getTime())
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
