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

import type { KeyboardCoordinateGetter, UniqueIdentifier } from '@dnd-kit/core'
import { KeyboardCode } from '@dnd-kit/core'

const DIRECTION_CODES = new Set<string>([KeyboardCode.Up, KeyboardCode.Down, KeyboardCode.Left, KeyboardCode.Right])

interface RectLike {
  top: number
  left: number
  width: number
  height: number
  right: number
  bottom: number
}

interface DroppableEntry {
  id: UniqueIdentifier
  disabled?: boolean
  data: { current?: { sortable?: { containerId: string; index: number } } }
  node: { current?: unknown }
}

interface SensorContextLike {
  over: { id: UniqueIdentifier } | null | undefined
}

export function laneKeyboardCoordinates(
  isLane: (id: UniqueIdentifier) => boolean,
  laneIds: () => string[]
): KeyboardCoordinateGetter {
  return (event, { active, context }) => {
    if (!DIRECTION_CODES.has(event.code)) return
    const { collisionRect, droppableRects, droppableContainers } = context as unknown as SensorContextLike & {
      collisionRect: RectLike
      droppableRects: Map<UniqueIdentifier, RectLike>
      droppableContainers: { getEnabled: () => Iterable<DroppableEntry>; get: (id: UniqueIdentifier) => DroppableEntry | undefined }
    }

    const activeId: UniqueIdentifier = active ?? contextActiveId(context)
    if (!activeId || !collisionRect) return
    event.preventDefault()

    const activeEntry = droppableContainers.get(activeId)
    if (!activeEntry) return

    const activeIsLane = isLane(activeId)
    const laneIdSet = new Set(laneIds())
    const activeContainerId = activeEntry.data.current?.sortable?.containerId

    const scoped = (entry: DroppableEntry): boolean =>
      activeIsLane ? laneIdSet.has(String(entry.id)) : entry.data.current?.sortable?.containerId === activeContainerId

    const candidates: DroppableEntry[] = []
    for (const entry of droppableContainers.getEnabled()) {
      if (!entry || entry.disabled) continue
      const rect = droppableRects.get(entry.id)
      if (!rect || !scoped(entry)) continue
      switch (event.code) {
        case KeyboardCode.Down:
          if (collisionRect.top < rect.top) candidates.push(entry)
          break
        case KeyboardCode.Up:
          if (collisionRect.top > rect.top) candidates.push(entry)
          break
        case KeyboardCode.Left:
          if (collisionRect.left > rect.left) candidates.push(entry)
          break
        case KeyboardCode.Right:
          if (collisionRect.left < rect.left) candidates.push(entry)
          break
      }
    }

    if (candidates.length === 0) return undefined

    // Deterministic ordered pick: the closest candidate in the pressed direction.
    // closestCorners ties break on DOM order and mis-target lanes that share a row,
    // which deadlocks the original position and skips intermediate lanes.
    const best = candidates.reduce((best, entry) => {
      const rect = droppableRects.get(entry.id) as RectLike
      const bestRect = droppableRects.get(best.id) as RectLike
      switch (event.code) {
        case KeyboardCode.Down:
          return rect.top < bestRect.top ? entry : best
        case KeyboardCode.Up:
          return rect.top > bestRect.top ? entry : best
        case KeyboardCode.Left:
          return rect.left > bestRect.left ? entry : best
        case KeyboardCode.Right:
          return rect.left < bestRect.left ? entry : best
      }
      return best
    })
    const sameContainer = best
      ? activeIsLane || best.data.current?.sortable?.containerId === activeContainerId
      : false
    if (!best || !sameContainer) return undefined

    const newRect = droppableRects.get(best.id)
    if (!newRect || !best.node.current) return undefined

    const afterActive = isAfter(activeEntry, best)
    return {
      x: newRect.left - (afterActive ? collisionRect.width - newRect.width : 0),
      y: newRect.top - (afterActive ? collisionRect.height - newRect.height : 0),
    }
  }
}

function contextActiveId(context: unknown): UniqueIdentifier | null {
  const active = (context as { active?: { id?: UniqueIdentifier } } | undefined | null)?.active
  return active?.id ?? null
}

function isAfter(a: DroppableEntry, b: DroppableEntry): boolean {
  if (!a.data.current?.sortable || !b.data.current?.sortable) return false
  return (
    a.data.current.sortable.containerId === b.data.current.sortable.containerId &&
    a.data.current.sortable.index < b.data.current.sortable.index
  )
}