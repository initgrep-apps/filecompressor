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

import { describe, expect, it } from 'vitest'
import type { Modifier, Modifiers } from '@dnd-kit/core'
import type { Transform } from '@dnd-kit/utilities'
import { dragAxisModifiers } from '@/lib/boardModifiers'

const LANES = ['image', 'video', 'pdf']

function run(modifier: Modifier, args: { activeId?: string | null; transform?: Transform; hasTransform?: boolean }): Transform | undefined {
  const transform: Transform | undefined =
    args.hasTransform === false || args.transform === undefined
      ? undefined
      : (args.transform ?? { x: 0, y: 0, scaleX: 1, scaleY: 1 })
  return modifier({
    activatorEvent: null,
    active: args.activeId == null ? null : ({ id: args.activeId } as never),
    activeNodeRect: null,
    draggingNodeRect: null,
    containerNodeRect: null,
    over: null,
    overlayNodeRect: null,
    scrollableAncestors: [],
    scrollableAncestorRects: [],
    transform: transform as Transform,
    windowRect: null,
  }) as Transform | undefined
}

describe('dragAxisModifiers', () => {
  it('a lane-active drag keeps horizontal motion and drops vertical drift', () => {
    const modifiers = dragAxisModifiers((id) => LANES.includes(String(id)))
    const modifier = modifiers[0]
    expect(run(modifier, { activeId: 'video', transform: { x: 268, y: 47, scaleX: 1, scaleY: 1 } })).toEqual({
      x: 268,
      y: 0,
      scaleX: 1,
      scaleY: 1,
    })
  })

  it('a card-active drag keeps vertical motion and drops horizontal wander', () => {
    const modifiers = dragAxisModifiers((id) => LANES.includes(String(id)))
    expect(run(modifiers[0], { activeId: 'v3', transform: { x: 12, y: 100, scaleX: 1, scaleY: 1 } })).toEqual({
      x: 0,
      y: 100,
      scaleX: 1,
      scaleY: 1,
    })
  })

  it('no active id leaves the transform untouched', () => {
    const modifiers: Modifiers = dragAxisModifiers((id) => LANES.includes(String(id)))
    expect(run(modifiers[0], { activeId: null, transform: { x: 5, y: 7, scaleX: 1, scaleY: 1 } })).toEqual({
      x: 5,
      y: 7,
      scaleX: 1,
      scaleY: 1,
    })
  })

  it('a lane id outside the predicate behaves like a card', () => {
    const modifiers = dragAxisModifiers(() => false)
    expect(run(modifiers[0], { activeId: 'anything', transform: { x: 30, y: 40, scaleX: 1, scaleY: 1 } })).toEqual({
      x: 0,
      y: 40,
      scaleX: 1,
      scaleY: 1,
    })
  })

  it('undefined transform passes through untouched', () => {
    const modifiers = dragAxisModifiers(() => true)
    expect(run(modifiers[0], { activeId: 'video', hasTransform: false })).toBeUndefined()
  })
})