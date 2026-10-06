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
import { CATEGORY_TONES, STATUS_TONES } from '@/lib/tokens'
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
  it('key set matches every Category value', () => {
    expect(Object.keys(CATEGORY_TONES).sort()).toEqual([...ALL_CATEGORIES].sort())
  })
  it('maps image=blue, video=violet, pdf=destructive, document=amber, other=muted', () => {
    expect(CATEGORY_TONES.image.text).toBe('text-blue-600')
    expect(CATEGORY_TONES.video.text).toBe('text-violet-600')
    expect(CATEGORY_TONES.pdf.text).toBe('text-destructive')
    expect(CATEGORY_TONES.document.text).toBe('text-amber-600')
    expect(CATEGORY_TONES.other.text).toBe('text-muted-foreground')
  })
  it('image/document/other carry expected tint, border and accent classes', () => {
    expect(CATEGORY_TONES.image.tint).toBe('bg-blue-500/12')
    expect(CATEGORY_TONES.image.border).toBe('border-blue-500/30')
    expect(CATEGORY_TONES.image.accent).toBe('bg-blue-500')
    expect(CATEGORY_TONES.document.tint).toBe('bg-amber-500/12')
    expect(CATEGORY_TONES.document.border).toBe('border-amber-500/30')
    expect(CATEGORY_TONES.document.accent).toBe('bg-amber-500')
    expect(CATEGORY_TONES.other.tint).toBe('bg-muted')
    expect(CATEGORY_TONES.other.border).toBe('border-border')
    expect(CATEGORY_TONES.other.accent).toBe('bg-muted-foreground')
  })
})

describe('STATUS_TONES', () => {
  it('covers every status', () => {
    for (const s of ALL_STATUSES) expect(STATUS_TONES[s]).toBeDefined()
  })
  it('key set matches every FileStatus value', () => {
    expect(Object.keys(STATUS_TONES).sort()).toEqual([...ALL_STATUSES].sort())
  })
  it('maps done/already_under_target/compressing=primary, best_effort=amber, failed=destructive, cancelled/pending/unsupported=muted', () => {
    expect(STATUS_TONES.done.text).toBe('text-primary')
    expect(STATUS_TONES.already_under_target.text).toBe('text-primary')
    expect(STATUS_TONES.compressing.text).toBe('text-primary')
    expect(STATUS_TONES.best_effort.text).toBe('text-amber-600')
    expect(STATUS_TONES.failed.text).toBe('text-destructive')
    expect(STATUS_TONES.cancelled.text).toBe('text-muted-foreground')
    expect(STATUS_TONES.pending.text).toBe('text-muted-foreground')
    expect(STATUS_TONES.unsupported.text).toBe('text-muted-foreground')
  })
  it('done/best_effort/failed carry expected tint, border and accent classes', () => {
    expect(STATUS_TONES.done.tint).toBe('bg-primary/15')
    expect(STATUS_TONES.done.border).toBe('border-primary/30')
    expect(STATUS_TONES.done.accent).toBe('bg-primary')
    expect(STATUS_TONES.best_effort.tint).toBe('bg-amber-500/12')
    expect(STATUS_TONES.best_effort.border).toBe('border-amber-500/30')
    expect(STATUS_TONES.best_effort.accent).toBe('bg-amber-500')
    expect(STATUS_TONES.failed.tint).toBe('bg-destructive/15')
    expect(STATUS_TONES.failed.border).toBe('border-destructive/35')
    expect(STATUS_TONES.failed.accent).toBe('bg-destructive')
  })
})

describe('translucency contract', () => {
  it('alpha-composed tints stay between /10 and /15', () => {
    expect(CATEGORY_TONES.image.tint).toMatch(/^bg-blue-500\/1[0-5]$/)
    expect(CATEGORY_TONES.video.tint).toMatch(/^bg-violet-500\/1[0-5]$/)
    expect(CATEGORY_TONES.document.tint).toMatch(/^bg-amber-500\/1[0-5]$/)
    expect(CATEGORY_TONES.pdf.tint).toMatch(/^bg-destructive\/1[0-5]$/)
    expect(STATUS_TONES.compressing.tint).toMatch(/^bg-primary\/1[0-5]$/)
    expect(STATUS_TONES.done.tint).toMatch(/^bg-primary\/1[0-5]$/)
    expect(STATUS_TONES.already_under_target.tint).toMatch(/^bg-primary\/1[0-5]$/)
    expect(STATUS_TONES.best_effort.tint).toMatch(/^bg-amber-500\/1[0-5]$/)
    expect(STATUS_TONES.failed.tint).toMatch(/^bg-destructive\/1[0-5]$/)
  })
  it('alpha-composed borders stay between /25 and /35', () => {
    expect(CATEGORY_TONES.image.border).toMatch(/^border-blue-500\/(2[5-9]|3[0-5])$/)
    expect(CATEGORY_TONES.video.border).toMatch(/^border-violet-500\/(2[5-9]|3[0-5])$/)
    expect(CATEGORY_TONES.document.border).toMatch(/^border-amber-500\/(2[5-9]|3[0-5])$/)
    expect(CATEGORY_TONES.pdf.border).toMatch(/^border-destructive\/(2[5-9]|3[0-5])$/)
    expect(STATUS_TONES.compressing.border).toMatch(/^border-primary\/(2[5-9]|3[0-5])$/)
    expect(STATUS_TONES.done.border).toMatch(/^border-primary\/(2[5-9]|3[0-5])$/)
    expect(STATUS_TONES.already_under_target.border).toMatch(/^border-primary\/(2[5-9]|3[0-5])$/)
    expect(STATUS_TONES.best_effort.border).toMatch(/^border-amber-500\/(2[5-9]|3[0-5])$/)
    expect(STATUS_TONES.failed.border).toMatch(/^border-destructive\/(2[5-9]|3[0-5])$/)
  })
})
