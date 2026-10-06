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

import type { FileEntry } from '@/types'

export function formatSize(bytes: number): string {
  if (bytes === 0) return '—'
  const KB = 1024
  const MB = 1024 * 1024
  const GB = 1024 * 1024 * 1024
  if (bytes < KB) return `${bytes} B`
  if (bytes < MB) return `${(bytes / KB).toFixed(0)} KB`
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`
  return `${(bytes / GB).toFixed(2)} GB`
}

function percentDelta(originalSize: number, compressedSize: number): number {
  return Math.max(
    0,
    Math.round(((originalSize - compressedSize) / originalSize) * 100)
  )
}

export function reductionPercentOrZero(file: FileEntry): number {
  if (file.originalSize === 0 || file.compressedSize === null) return 0
  return percentDelta(file.originalSize, file.compressedSize)
}

export function reductionPercentOrNull(file: FileEntry): number | null {
  if (file.originalSize === 0 || file.compressedSize === null) return null
  return percentDelta(file.originalSize, file.compressedSize)
}
