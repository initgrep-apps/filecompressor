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
import { formatSize, reductionPercentOrZero, reductionPercentOrNull } from '@/lib/sizeFormat'
import type { FileEntry } from '@/types'

function makeFile(patch: Partial<FileEntry> = {}): FileEntry {
  return {
    id: 'f1',
    name: 'IMG_5647.MOV',
    path: '/tmp/IMG_5647.MOV',
    category: 'video',
    targetBytes: 8_388_608,
    originalSize: 1_100_000,
    status: 'done',
    compressedSize: 700_000,
    outputPath: '/out/IMG_5647.MOV',
    error: null,
    strategyUsed: 'crf=24',
    qualityUsed: null,
    ...patch,
  }
}

describe('formatSize', () => {
  it('renders em dash for zero bytes', () => {
    expect(formatSize(0)).toBe('—')
  })

  it('renders bytes below 1 KB without rounding', () => {
    expect(formatSize(500)).toBe('500 B')
    expect(formatSize(1023)).toBe('1023 B')
  })

  it('renders KB rounded to whole units', () => {
    expect(formatSize(1024)).toBe('1 KB')
    expect(formatSize(1536)).toBe('2 KB')
  })

  it('renders MB with one decimal', () => {
    expect(formatSize(1_048_576)).toBe('1.0 MB')
    expect(formatSize(1_200_000)).toBe('1.1 MB')
  })

  it('renders GB with two decimals', () => {
    expect(formatSize(1_073_741_824)).toBe('1.00 GB')
    expect(formatSize(1_500_000_000)).toBe('1.40 GB')
  })
})

describe('reductionPercentOrZero', () => {
  it('returns 0 when originalSize is 0', () => {
    expect(reductionPercentOrZero(makeFile({ originalSize: 0 }))).toBe(0)
  })

  it('returns 0 when compressedSize is null', () => {
    expect(reductionPercentOrZero(makeFile({ compressedSize: null }))).toBe(0)
  })

  it('returns rounded reduction for a normal file', () => {
    expect(reductionPercentOrZero(makeFile())).toBe(36)
  })

  it('returns 0 when compressedSize exceeds originalSize', () => {
    expect(reductionPercentOrZero(makeFile({ originalSize: 100, compressedSize: 200 }))).toBe(0)
  })

  it('returns 0 for identical sizes', () => {
    expect(reductionPercentOrZero(makeFile({ originalSize: 512, compressedSize: 512 }))).toBe(0)
  })
})

describe('reductionPercentOrNull', () => {
  it('returns null when originalSize is 0', () => {
    expect(reductionPercentOrNull(makeFile({ originalSize: 0 }))).toBeNull()
  })

  it('returns null when compressedSize is null', () => {
    expect(reductionPercentOrNull(makeFile({ compressedSize: null }))).toBeNull()
  })

  it('returns rounded reduction for a normal file', () => {
    expect(reductionPercentOrNull(makeFile())).toBe(36)
  })

  it('clamps to 0 when compressedSize exceeds originalSize', () => {
    expect(reductionPercentOrNull(makeFile({ originalSize: 100, compressedSize: 200 }))).toBe(0)
  })

  it('returns 0 for identical sizes', () => {
    expect(reductionPercentOrNull(makeFile({ originalSize: 512, compressedSize: 512 }))).toBe(0)
  })
})
