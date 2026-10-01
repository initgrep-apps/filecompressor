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
import { Spinner } from '@/components/ui/spinner'

describe('Spinner', () => {
  it('renders as decorative with data-slot marker', () => {
    const { container } = render(<Spinner />)
    const root = container.querySelector('[data-slot="spinner"]')
    expect(root).not.toBeNull()
    expect(root).toHaveAttribute('aria-hidden', 'true')
  })

  it('does not pollute the accessible name of its host button', () => {
    render(
      <button type="button">
        Compress
        <Spinner />
      </button>
    )
    expect(screen.getByRole('button', { name: 'Compress' })).toBeInTheDocument()
  })

  it('keeps aria-hidden when a consumer passes a conflicting value', () => {
    const { container } = render(<Spinner aria-hidden={false} />)
    expect(container.querySelector('[data-slot="spinner"]')).toHaveAttribute(
      'aria-hidden',
      'true'
    )
  })

  it('exposes no status role', () => {
    render(<Spinner />)
    expect(screen.queryByRole('status')).toBeNull()
  })
})
