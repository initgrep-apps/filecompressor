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

import { expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToggleGroup, ToggleGroupItem } from './toggle-group'

function renderGroup(orientation: 'horizontal' | 'vertical') {
  render(
    <ToggleGroup orientation={orientation}>
      <ToggleGroupItem value="a">A</ToggleGroupItem>
      <ToggleGroupItem value="b">B</ToggleGroupItem>
    </ToggleGroup>
  )
  return screen.getByRole('button', { name: 'A' })
}

it('moves focus with ArrowDown in a vertical group', async () => {
  renderGroup('vertical').focus()
  await userEvent.keyboard('{ArrowDown}')
  expect(screen.getByRole('button', { name: 'B' })).toHaveFocus()
})

it('moves focus with ArrowRight in a horizontal group', async () => {
  renderGroup('horizontal').focus()
  await userEvent.keyboard('{ArrowRight}')
  expect(screen.getByRole('button', { name: 'B' })).toHaveFocus()
})
