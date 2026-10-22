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

import type { Category } from '@/types'

export function strategyLabel(strategy: string | null, category: Category): string {
  if (!strategy) return ''
  if (strategy.includes('best-effort')) return 'Best effort'
  if (strategy.startsWith('palette')) return 'PNG palette · Lossy'
  if (strategy.startsWith('rezip')) return 'Rezip · Lossless'
  if (strategy.startsWith('two-pass h264')) return 'H.264 two-pass · Lossy'
  if (strategy.startsWith('crf=')) return 'H.264 CRF · Lossy'
  if (strategy.startsWith('qpdf-lossless')) return 'QPDF · Lossless'
  if (strategy.startsWith('qpdf-image-opt')) return 'QPDF image optimize · Lossy'
  if (strategy.startsWith('gs')) return 'Ghostscript · Lossy'
  if (strategy.startsWith('quality=')) {
    if (category === 'document') return 'Rebuild · Lossless'
    if (category === 'image') return 'Re-encode · Lossy'
    if (category === 'pdf') return 'Ghostscript · Lossy'
  }
  return strategy
}
