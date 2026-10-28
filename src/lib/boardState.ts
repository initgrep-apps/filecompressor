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

import { arrayMove } from '@dnd-kit/sortable'
import type { Category, FileEntry } from '@/types'
import { CATEGORIES } from '@/types'
import type { StatusFilter } from '@/lib/grouping'
import { filterFiles, LANE_ORDER } from '@/lib/grouping'

export interface BoardState {
  laneOrder: Category[]
  cardOrder: Partial<Record<Category, string[]>>
}

function isCategory(value: string): value is Category {
  return CATEGORIES.includes(value as Category)
}

function laneOf(category: Category): Category {
  return LANE_ORDER.includes(category) ? category : 'other'
}

function orderLaneIds(files: FileEntry[]): string[] {
  const compressing: string[] = []
  const rest: string[] = []
  for (const file of files) {
    if (file.status === 'compressing') compressing.push(file.id)
    else rest.push(file.id)
  }
  return [...compressing, ...rest]
}

function equalsState(a: BoardState, b: BoardState): boolean {
  if (a.laneOrder.length !== b.laneOrder.length) return false
  for (let i = 0; i < a.laneOrder.length; i++) {
    if (a.laneOrder[i] !== b.laneOrder[i]) return false
  }
  const aKeys = Object.keys(a.cardOrder) as Category[]
  const bKeys = Object.keys(b.cardOrder) as Category[]
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    const aIds = a.cardOrder[key] ?? []
    const bIds = b.cardOrder[key]
    if (!bIds || aIds.length !== bIds.length) return false
    for (let i = 0; i < aIds.length; i++) {
      if (aIds[i] !== bIds[i]) return false
    }
  }
  return true
}

export function initialBoardState(files: FileEntry[]): BoardState {
  const byCategory = new Map<Category, FileEntry[]>()
  for (const file of files) {
    if (file.status === 'unsupported') continue
    const category = laneOf(file.category)
    const lane = byCategory.get(category)
    if (lane) lane.push(file)
    else byCategory.set(category, [file])
  }
  const laneOrder: Category[] = []
  const cardOrder: Partial<Record<Category, string[]>> = {}
  for (const category of LANE_ORDER) {
    const lane = byCategory.get(category)
    if (!lane) continue
    laneOrder.push(category)
    cardOrder[category] = orderLaneIds(lane)
  }
  return { laneOrder, cardOrder }
}

export function syncBoardState(state: BoardState, files: FileEntry[]): BoardState {
  const fileById = new Map<string, FileEntry>()
  const presentCategories = new Set<Category>()
  for (const file of files) {
    if (file.status === 'unsupported') continue
    const category = laneOf(file.category)
    fileById.set(file.id, file)
    presentCategories.add(category)
  }

  const newLaneOrder: Category[] = []
  const newCardOrder: Partial<Record<Category, string[]>> = {}
  const placed = new Set<string>()

  for (const category of state.laneOrder) {
    if (!presentCategories.has(category)) continue
    const kept: string[] = []
    for (const id of state.cardOrder[category] ?? []) {
      const file = fileById.get(id)
      if (file && laneOf(file.category) === category) {
        kept.push(id)
        placed.add(id)
      }
    }
    newLaneOrder.push(category)
    newCardOrder[category] = kept
  }

  for (const category of LANE_ORDER) {
    if (newCardOrder[category] || !presentCategories.has(category)) continue
    const arrivals: FileEntry[] = []
    for (const file of files) {
      if (file.status === 'unsupported') continue
      if (laneOf(file.category) === category && !placed.has(file.id)) {
        arrivals.push(file)
        placed.add(file.id)
      }
    }
    if (arrivals.length === 0) continue
    newLaneOrder.push(category)
    newCardOrder[category] = orderLaneIds(arrivals)
  }

  for (const category of newLaneOrder) {
    const ids = newCardOrder[category] ?? []
    for (const file of files) {
      if (file.status === 'unsupported') continue
      if (laneOf(file.category) === category && !placed.has(file.id)) {
        ids.push(file.id)
        placed.add(file.id)
      }
    }
    newCardOrder[category] = orderLaneIds(ids.map(id => fileById.get(id)!))
  }

  const finalLaneOrder = newLaneOrder.filter(category => (newCardOrder[category]?.length ?? 0) > 0)
  const finalCardOrder: Partial<Record<Category, string[]>> = {}
  for (const category of finalLaneOrder) {
    finalCardOrder[category] = newCardOrder[category]
  }

  const next: BoardState = { laneOrder: finalLaneOrder, cardOrder: finalCardOrder }
  return equalsState(state, next) ? state : next
}

export function derivedColumns(
  state: BoardState,
  files: FileEntry[],
  statusFilter: StatusFilter
): Array<{ category: Category; files: FileEntry[] }> {
  const fileById = new Map<string, FileEntry>()
  const presentCategories = new Set<Category>()
  for (const file of files) {
    if (file.status === 'unsupported') continue
    fileById.set(file.id, file)
    presentCategories.add(laneOf(file.category))
  }

  const columns: Array<{ category: Category; files: FileEntry[] }> = []
  const seen = new Set<Category>()

  for (const category of state.laneOrder) {
    if (!presentCategories.has(category)) continue
    const laneFiles = (state.cardOrder[category] ?? [])
      .map(id => fileById.get(id))
      .filter((file): file is FileEntry => file !== undefined)
    const filtered = filterFiles(laneFiles, statusFilter)
    if (filtered.length === 0) continue
    seen.add(category)
    columns.push({ category, files: filtered })
  }

  for (const category of LANE_ORDER) {
    if (seen.has(category) || !presentCategories.has(category)) continue
    const laneFiles = files.filter(
      file => file.status !== 'unsupported' && laneOf(file.category) === category
    )
    const filtered = filterFiles(laneFiles, statusFilter)
    if (filtered.length === 0) continue
    columns.push({ category, files: filtered })
  }

  return columns
}

export function applyCardMove(
  state: BoardState,
  move: {
    activeId: string
    overId: string
    activeContainer: string
    overContainer: string
    overIsColumn: boolean
  },
  files: FileEntry[]
): BoardState {
  if (!isCategory(move.activeContainer) || !isCategory(move.overContainer)) return state
  if (move.activeContainer !== move.overContainer) return state
  const lane = state.cardOrder[move.activeContainer]
  if (!lane) return state
  const activeIndex = lane.indexOf(move.activeId)
  if (activeIndex < 0) return state

  const statusById = new Map<string, FileEntry['status']>()
  for (const file of files ?? []) {
    statusById.set(file.id, file.status)
  }

  const isCompressing = (id: string): boolean => statusById.get(id) === 'compressing'

  let overIndex: number
  if (move.overIsColumn) {
    overIndex = lane.length
  } else {
    overIndex = lane.indexOf(move.overId)
    if (overIndex < 0) return state
    if (isCompressing(move.activeId)) return state
    if (lane.length > 0 && isCompressing(lane[0])) {
      overIndex = Math.max(1, overIndex)
    }
  }

  if (activeIndex === overIndex) return state
  const nextLane = arrayMove(lane, activeIndex, overIndex)
  return {
    laneOrder: state.laneOrder,
    cardOrder: { ...state.cardOrder, [move.activeContainer]: nextLane },
  }
}

export function applyLaneOrder(state: BoardState, keys: string[]): BoardState {
  const keySet = new Set(keys)
  const keyLanes = state.laneOrder.filter(category => keySet.has(category))
  const keyLanesByKeyOrder = keys
    .filter((key): key is Category => isCategory(key) && keyLanes.includes(key))
    .filter((category, index, self) => self.indexOf(category) === index)
  let keyIndex = 0
  const nextLaneOrder: Category[] = []
  for (const category of state.laneOrder) {
    if (keyLanes.includes(category)) {
      nextLaneOrder.push(keyLanesByKeyOrder[keyIndex++])
    } else {
      nextLaneOrder.push(category)
    }
  }
  if (equalsState(state, { ...state, laneOrder: nextLaneOrder })) return state
  return { laneOrder: nextLaneOrder, cardOrder: state.cardOrder }
}
