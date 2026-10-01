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

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HistoryView } from '@/views/HistoryView'

describe('HistoryView', () => {
  it('renders history empty state', () => {
    const { container } = render(<HistoryView />)
    expect(screen.getByText('No history yet').closest('[data-slot="empty"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(1)
  })
})
