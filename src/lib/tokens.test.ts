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

import { describe, expect, it } from 'vitest'
import { CATEGORY_TONES, STATUS_TONES } from './tokens'
import type { Category, FileStatus } from '@/types'

const ALL_CATEGORIES: Category[] = ['image', 'video', 'pdf', 'document', 'other']
const ALL_STATUSES: FileStatus[] = [
  'pending', 'compressing', 'done', 'best_effort',
  'failed', 'cancelled', 'unsupported', 'already_under_target',
]

describe('CATEGORY_TONES', () => {
  it('covers every category', () => {
    for (const c of ALL_CATEGORIES) {
      expect(CATEGORY_TONES[c]).toBeDefined()
      expect(CATEGORY_TONES[c].tint).toMatch(/^bg-/)
      expect(CATEGORY_TONES[c].text).toMatch(/^text-/)
      expect(CATEGORY_TONES[c].border).toMatch(/^border-/)
      expect(CATEGORY_TONES[c].accent).toMatch(/^bg-/)
    }
  })
  it('maps image=blue, video=violet, pdf=destructive, document=amber, other=muted', () => {
    expect(CATEGORY_TONES.image.text).toContain('blue')
    expect(CATEGORY_TONES.video.text).toContain('violet')
    expect(CATEGORY_TONES.pdf.text).toBe('text-destructive')
    expect(CATEGORY_TONES.document.text).toContain('amber')
    expect(CATEGORY_TONES.other.text).toBe('text-muted-foreground')
  })
})

describe('STATUS_TONES', () => {
  it('covers every status', () => {
    for (const s of ALL_STATUSES) expect(STATUS_TONES[s]).toBeDefined()
  })
  it('maps done/already_under_target/compressing=primary, best_effort=amber, failed=destructive, cancelled/pending/unsupported=muted', () => {
    expect(STATUS_TONES.done.text).toBe('text-primary')
    expect(STATUS_TONES.already_under_target.text).toBe('text-primary')
    expect(STATUS_TONES.compressing.text).toBe('text-primary')
    expect(STATUS_TONES.best_effort.text).toContain('amber')
    expect(STATUS_TONES.failed.text).toBe('text-destructive')
    expect(STATUS_TONES.cancelled.text).toBe('text-muted-foreground')
    expect(STATUS_TONES.pending.text).toBe('text-muted-foreground')
    expect(STATUS_TONES.unsupported.text).toBe('text-muted-foreground')
  })
  it('status tone non-text fields are asserted', () => {
    expect(STATUS_TONES.done.tint).toContain('primary/15')
    expect(STATUS_TONES.done.border).toContain('border-primary/30')
    expect(STATUS_TONES.done.accent).toBe('bg-primary')
    expect(STATUS_TONES.best_effort.tint).toContain('amber')
    expect(STATUS_TONES.best_effort.border).toContain('amber')
    expect(STATUS_TONES.best_effort.accent).toBe('bg-amber-500')
    expect(STATUS_TONES.failed.tint).toContain('destructive')
    expect(STATUS_TONES.failed.border).toContain('destructive')
    expect(STATUS_TONES.failed.accent).toBe('bg-destructive')
  })
})
