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
import { KeyboardCode, closestCorners, getFirstCollision } from '@dnd-kit/core'

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
    const { collisionRect, droppableRects, droppableContainers, over } = context as unknown as SensorContextLike & {
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
      if (!rect || !scoped(entry) || String(entry.id) === String(activeId)) continue
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

    const collisions = closestCorners({
      active: activeId,
      collisionRect,
      droppableRects,
      droppableContainers: candidates,
      pointerCoordinates: null,
    } as never) as Array<{ id: UniqueIdentifier }>

    let closestId = getFirstCollision(collisions as never, 'id') as UniqueIdentifier | null
    if (closestId === over?.id && collisions.length > 1) {
      closestId = collisions[1].id
    }

    const newDroppable = closestId != null ? droppableContainers.get(closestId) : undefined
    const sameContainer = newDroppable
      ? activeIsLane || newDroppable.data.current?.sortable?.containerId === activeContainerId
      : false
    if (!newDroppable || !sameContainer) return undefined

    const newRect = droppableRects.get(newDroppable.id)
    const activeRect = droppableRects.get(activeId)
    if (!newRect || !newDroppable.node.current || !activeRect) return undefined

    const afterActive = isAfter(activeEntry, newDroppable)
    return {
      x: newRect.left - (afterActive ? activeRect.width - newRect.width : 0),
      y: newRect.top - (afterActive ? activeRect.height - newRect.height : 0),
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