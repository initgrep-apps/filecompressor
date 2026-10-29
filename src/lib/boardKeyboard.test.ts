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
import type { KeyboardCoordinateGetter } from '@dnd-kit/core'
import { laneKeyboardCoordinates } from '@/lib/boardKeyboard'

interface Rect {
  top: number
  left: number
  width: number
  height: number
  right: number
  bottom: number
}

function rect(top: number, left: number, width: number, height: number): Rect {
  return { top, left, width, height, right: left + width, bottom: top + height }
}

const RECTS: Record<string, Rect> = {
  laneA: rect(0, 0, 256, 468),
  laneB: rect(0, 268, 256, 468),
  laneC: rect(0, 536, 256, 468),
  a1: rect(40, 0, 256, 100),
  a2: rect(150, 0, 256, 100),
  a3: rect(260, 0, 256, 100),
  b1: rect(40, 268, 256, 100),
  b2: rect(150, 268, 256, 100),
}

interface FakeEntry {
  id: string
  disabled?: boolean
  data: { current: { sortable?: { containerId: string } } }
  node: { current: unknown }
}

function ctx(
  activeId: string,
  containers: Record<string, string>,
  extras?: { collisionRect?: Rect; over?: { id: string } | null; currentTranslate?: { x: number; y: number } }
) {
  const entries: FakeEntry[] = Object.entries(containers).map(([id, containerId]) => ({
    id,
    data: { current: { sortable: { containerId } } },
    node: { current: { getBoundingClientRect: () => RECTS[id] } },
  }))
  const droppableRects = new Map(Object.entries(RECTS).map(([id, rect]) => [id, rect as unknown as DOMRect]))
  return {
    active: activeId,
    droppableRects,
    droppableContainers: {
      get: (id: string | number) => entries.find((e) => e.id === id),
      getEnabled: () => entries.filter((e) => !e.disabled),
    },
    over: extras?.over ?? null,
    collisionRect: extras?.collisionRect ?? (extras?.currentTranslate ? rect(extras.currentTranslate.y, extras.currentTranslate.x, 256, 468) : RECTS[activeId]),
    scrollableAncestors: [],
  } as never
}

function event(code: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Space'): KeyboardEvent {
  return { code, preventDefault: () => {} } as unknown as KeyboardEvent
}

describe('laneKeyboardCoordinates', () => {
  const lanes = ['laneA', 'laneB', 'laneC']
  const isLane = (id: unknown) => lanes.includes(String(id))
  const getter: KeyboardCoordinateGetter = laneKeyboardCoordinates(isLane, () => lanes)
  const boardOf: Record<string, string> = { laneA: 'board', laneB: 'board', laneC: 'board' }

  it('lane drag + ArrowRight targets the next lane rect only, never a card', () => {
    const next = getter(event('ArrowRight'), {
      active: 'laneA',
      currentCoordinates: { x: 0, y: 0 },
      context: ctx('laneA', { ...boardOf, a1: 'laneA', b1: 'laneB', b2: 'laneB' }),
    })
    expect(next).toEqual({ x: 268, y: 0 })
  })

  it('lane drag + ArrowLeft targets the previous lane only', () => {
    const next = getter(event('ArrowLeft'), {
      active: 'laneB',
      currentCoordinates: { x: 268, y: 0 },
      context: ctx('laneB', { ...boardOf, a1: 'laneA', b1: 'laneB', b2: 'laneB' }),
    })
    expect(next).toEqual({ x: 0, y: 0 })
  })

  it('lane drag + ArrowDown returns no coordinates (lanes move horizontally only)', () => {
    const next = getter(event('ArrowDown'), {
      active: 'laneA',
      currentCoordinates: { x: 0, y: 0 },
      context: ctx('laneA', { ...boardOf, a1: 'laneA', b1: 'laneB' }),
    })
    expect(next).toBeUndefined()
  })

  it('item drag + ArrowDown targets the next item in the same lane', () => {
    const next = getter(event('ArrowDown'), {
      active: 'a1',
      currentCoordinates: { x: 0, y: 0 },
      context: ctx('a1', { ...boardOf, a1: 'laneA', a2: 'laneA', a3: 'laneA', b1: 'laneB', b2: 'laneB' }),
    })
    expect(next).toEqual({ x: 0, y: 150 })
  })

  it('item drag + ArrowDown at the lane end ignores other lanes cards and stays put', () => {
    const next = getter(event('ArrowDown'), {
      active: 'a3',
      currentCoordinates: { x: 0, y: 0 },
      context: ctx('a3', { ...boardOf, a1: 'laneA', a2: 'laneA', a3: 'laneA', b1: 'laneB', b2: 'laneB' }),
    })
    expect(next).toBeUndefined()
  })

  it('item drag + ArrowLeft returns no coordinates', () => {
    const next = getter(event('ArrowLeft'), {
      active: 'a1',
      currentCoordinates: { x: 0, y: 0 },
      context: ctx('a1', { ...boardOf, a1: 'laneA', a2: 'laneA' }),
    })
    expect(next).toBeUndefined()
  })

  it('second ArrowRight press reaches the next lane via the translated collision rect', () => {
    const first = getter(event('ArrowRight'), {
      active: 'laneA',
      currentCoordinates: { x: 0, y: 0 },
      context: ctx('laneA', boardOf),
    })
    expect(first).toEqual({ x: 268, y: 0 })
    const second = getter(event('ArrowRight'), {
      active: 'laneA',
      currentCoordinates: { x: 268, y: 0 },
      context: ctx('laneA', boardOf, { collisionRect: rect(0, 268, 256, 468) }),
    })
    expect(second).toEqual({ x: 536, y: 0 })
  })

  it('non-movement keys are ignored', () => {
    const next = getter(event('Space'), {
      active: 'laneA',
      currentCoordinates: { x: 0, y: 0 },
      context: ctx('laneA', boardOf),
    })
    expect(next).toBeUndefined()
  })

  it('steps to the adjacent lane regardless of the current over target (no skipping)', () => {
    const next = getter(event('ArrowRight'), {
      active: 'laneA',
      currentCoordinates: { x: 268, y: 0 },
      context: ctx('laneA', boardOf, { collisionRect: rect(0, 0, 256, 468), over: { id: 'laneB' } }),
    })
    expect(next).toEqual({ x: 268, y: 0 })
  })

  it('a lane dragged to the last slot walks back through every slot to its original one', () => {
    const stepBackOne = getter(event('ArrowLeft'), {
      active: 'laneA',
      currentCoordinates: { x: 536, y: 0 },
      context: ctx('laneA', boardOf, { collisionRect: rect(0, 536, 256, 468) }),
    })
    expect(stepBackOne).toEqual({ x: 268, y: 0 })
    const stepBackTwo = getter(event('ArrowLeft'), {
      active: 'laneA',
      currentCoordinates: { x: 268, y: 0 },
      context: ctx('laneA', boardOf, { collisionRect: rect(0, 268, 256, 468) }),
    })
    expect(stepBackTwo).toEqual({ x: 0, y: 0 })
    const stepBackThree = getter(event('ArrowLeft'), {
      active: 'laneA',
      currentCoordinates: { x: 0, y: 0 },
      context: ctx('laneA', boardOf, { collisionRect: rect(0, 0, 256, 468) }),
    })
    expect(stepBackThree).toBeUndefined()
  })

  it('lane drag beyond the last lane and item drag beyond the lane top are no-ops', () => {
    const laneBeyond = getter(event('ArrowRight'), {
      active: 'laneC',
      currentCoordinates: { x: 536, y: 0 },
      context: ctx('laneC', boardOf, { collisionRect: rect(0, 536, 256, 468) }),
    })
    expect(laneBeyond).toBeUndefined()
    const itemTop = getter(event('ArrowUp'), {
      active: 'a1',
      currentCoordinates: { x: 0, y: 0 },
      context: ctx('a1', { ...boardOf, a1: 'laneA', a2: 'laneA', b1: 'laneB' }),
    })
    expect(itemTop).toBeUndefined()
  })
})