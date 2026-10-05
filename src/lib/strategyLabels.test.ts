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
import { strategyLabel } from '@/lib/strategyLabels'

describe('strategyLabel', () => {
  it('maps every known strategy format to its label', () => {
    expect(strategyLabel('two-pass h264 b=1200k scale=720', 'video')).toBe('H.264 two-pass · Lossy')
    expect(strategyLabel('crf=24', 'video')).toBe('H.264 CRF · Lossy')
    expect(strategyLabel('qpdf-lossless', 'pdf')).toBe('QPDF · Lossless')
    expect(strategyLabel('qpdf-image-opt,jpeg-quality=70', 'pdf')).toBe('QPDF image optimize · Lossy')
    expect(strategyLabel('gs-screen', 'pdf')).toBe('Ghostscript · Lossy')
    expect(strategyLabel('gs dpi=300,jpegq=85', 'pdf')).toBe('Ghostscript · Lossy')
    expect(strategyLabel('quality=60', 'document')).toBe('Rebuild · Lossless')
    expect(strategyLabel('quality=80', 'image')).toBe('Re-encode · Lossy')
    expect(strategyLabel('quality=80', 'pdf')).toBe('Ghostscript · Lossy')
  })

  it('strips numeric/format suffixes from the label', () => {
    expect(strategyLabel('quality=80,dims=50%', 'image')).toBe('Re-encode · Lossy')
    expect(strategyLabel('quality=80,dims=50%', 'image')).not.toContain('dims=')
    expect(strategyLabel('two-pass h264 b=1200k scale=720', 'video')).not.toContain('b=')
    expect(strategyLabel('two-pass h264 b=1200k scale=720', 'video')).not.toContain('scale=')
    expect(strategyLabel('two-pass h264 b=1200k scale=720', 'video')).not.toContain('1200')
    expect(strategyLabel('gs dpi=300,jpegq=85', 'pdf')).not.toContain('jpegq=')
    expect(strategyLabel('gs dpi=300,jpegq=85', 'pdf')).not.toContain('dpi=')
    expect(strategyLabel('qpdf-image-opt,jpeg-quality=70', 'pdf')).not.toContain('jpeg-quality=')
    expect(strategyLabel('crf=24', 'video')).not.toContain('crf=')
  })

  it('best-effort suffix wins over the image re-encode fallback', () => {
    expect(strategyLabel('quality=80,best-effort', 'image')).toBe('Best effort')
  })

  it('best-effort rule wins over quality= for document rezip fallback', () => {
    expect(strategyLabel('quality=60,best-effort', 'document')).toBe('Best effort')
    expect(strategyLabel('rezip-deflate9,best-effort', 'document')).toBe('Best effort')
  })

  it('best-effort appended to any processor prefix still maps to Best effort', () => {
    expect(strategyLabel('crf=24,best-effort', 'video')).toBe('Best effort')
    expect(strategyLabel('two-pass h264 b=1200k,best-effort', 'video')).toBe('Best effort')
    expect(strategyLabel('gs-screen,best-effort', 'pdf')).toBe('Best effort')
    expect(strategyLabel('qpdf-lossless,best-effort', 'pdf')).toBe('Best effort')
    expect(strategyLabel('quality=80,best-effort', 'image')).toBe('Best effort')
  })

  it('quality= with unmatched category falls through to the raw string', () => {
    expect(strategyLabel('quality=60', 'video')).toBe('quality=60')
    expect(strategyLabel('quality=60', 'other')).toBe('quality=60')
  })

  it('null returns empty string; unknown passes through raw', () => {
    expect(strategyLabel(null, 'image')).toBe('')
    expect(strategyLabel(null, 'document')).toBe('')
    expect(strategyLabel('already-under-target', 'document')).toBe('already-under-target')
    expect(strategyLabel('already-under-target', 'image')).toBe('already-under-target')
    expect(strategyLabel('some future format', 'pdf')).toBe('some future format')
  })
})
