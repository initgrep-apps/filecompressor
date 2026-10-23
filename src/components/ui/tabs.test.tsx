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
import { Tabs, TabsList, TabsTrigger } from './tabs'

function renderTablist(orientation?: 'horizontal' | 'vertical') {
  render(
    <Tabs orientation={orientation}>
      <TabsList>
        <TabsTrigger value="general">General</TabsTrigger>
      </TabsList>
    </Tabs>
  )
  return screen.getByRole('tablist')
}

it('forwards vertical orientation to the tablist', () => {
  const tablist = renderTablist('vertical')
  expect(tablist).toHaveAttribute('aria-orientation', 'vertical')
  expect(tablist.closest('[data-slot="tabs"]')).toHaveAttribute('data-orientation', 'vertical')
})

it('defaults to horizontal orientation', () => {
  const tablist = renderTablist()
  expect(tablist).not.toHaveAttribute('aria-orientation')
  expect(tablist.closest('[data-slot="tabs"]')).toHaveAttribute('data-orientation', 'horizontal')
})
