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
import type { FileEntry } from '@/types'
import type { StatusFilter } from '@/lib/grouping'
import {
  applyCardMove,
  applyLaneOrder,
  derivedColumns,
  initialBoardState,
  syncBoardState,
  type BoardState,
} from '@/lib/boardState'

function makeFile(patch: Partial<FileEntry> = {}): FileEntry {
  return {
    id: 'f1',
    name: 'IMG_5647.MOV',
    path: '/tmp/IMG_5647.MOV',
    category: 'video',
    targetBytes: 8_388_608,
    originalSize: 1_100_000,
    status: 'done',
    compressedSize: 700_000,
    outputPath: '/out/IMG_5647.MOV',
    error: null,
    strategyUsed: 'crf=24',
    qualityUsed: null,
    ...patch,
  }
}

describe('boardState', () => {
  it('initial board orders lanes by LANE_ORDER and pins compressing ids front', () => {
    const files = [
      makeFile({ id: 'f1', category: 'pdf', status: 'pending' }),
      makeFile({ id: 'f2', category: 'image', status: 'compressing' }),
      makeFile({ id: 'f3', category: 'image', status: 'done' }),
      makeFile({ id: 'f4', category: 'video', status: 'compressing' }),
      makeFile({ id: 'f5', category: 'video', status: 'pending' }),
    ]
    const state = initialBoardState(files)
    expect(state.laneOrder).toEqual(['image', 'video', 'pdf'])
    expect(state.cardOrder).toEqual({
      image: ['f2', 'f3'],
      video: ['f4', 'f5'],
      pdf: ['f1'],
    })
  })

  it('unsupported files are excluded from initial state and from sync', () => {
    const files = [
      makeFile({ id: 'f1', category: 'image', status: 'done' }),
      makeFile({ id: 'f2', category: 'image', status: 'unsupported' }),
    ]
    const state = initialBoardState(files)
    expect(state.cardOrder.image).toEqual(['f1'])

    const next = syncBoardState(state, [
      makeFile({ id: 'f1', category: 'image', status: 'done' }),
      makeFile({ id: 'f3', category: 'image', status: 'unsupported' }),
    ])
    expect(next.cardOrder.image).toEqual(['f1'])
  })

  it('sync appends new ids, drops removed ids, and drops an emptied lane', () => {
    const state: BoardState = {
      laneOrder: ['image', 'video'],
      cardOrder: {
        image: ['f1'],
        video: ['f2'],
      },
    }
    const next = syncBoardState(state, [
      makeFile({ id: 'f1', category: 'image', status: 'done' }),
      makeFile({ id: 'f3', category: 'image', status: 'pending' }),
    ])
    expect(next.laneOrder).toEqual(['image'])
    expect(next.cardOrder.image).toEqual(['f1', 'f3'])
    expect(next.cardOrder.video).toBeUndefined()
  })

  it('sync returns the same state reference when the roster id-set is unchanged', () => {
    const files = [
      makeFile({ id: 'f1', category: 'image', status: 'done' }),
      makeFile({ id: 'f2', category: 'image', status: 'pending' }),
    ]
    const state = initialBoardState(files)
    const next = syncBoardState(state, files)
    expect(next).toBe(state)
  })

  it('sync pins a file that became compressing to the front and preserves user order otherwise', () => {
    const state = initialBoardState([
      makeFile({ id: 'f1', category: 'image', status: 'done' }),
      makeFile({ id: 'f2', category: 'image', status: 'pending' }),
      makeFile({ id: 'f3', category: 'image', status: 'done' }),
    ])
    const next = syncBoardState(state, [
      makeFile({ id: 'f1', category: 'image', status: 'done' }),
      makeFile({ id: 'f2', category: 'image', status: 'compressing' }),
      makeFile({ id: 'f3', category: 'image', status: 'done' }),
    ])
    expect(next.cardOrder.image).toEqual(['f2', 'f1', 'f3'])
  })

  it('derivedColumns filters by status, omits empty lanes, and keeps user card order', () => {
    const state: BoardState = {
      laneOrder: ['image', 'video', 'pdf'],
      cardOrder: {
        image: ['f1', 'f2'],
        video: ['f3'],
        pdf: ['f4'],
      },
    }
    const files = [
      makeFile({ id: 'f1', category: 'image', status: 'compressing' }),
      makeFile({ id: 'f2', category: 'image', status: 'done' }),
      makeFile({ id: 'f3', category: 'video', status: 'done' }),
      makeFile({ id: 'f4', category: 'pdf', status: 'pending' }),
    ]
    const columns = derivedColumns(state, files, 'complete' as StatusFilter)
    expect(columns.map((c) => c.category)).toEqual(['image', 'video'])
    expect(columns[0].files.map((f) => f.id)).toEqual(['f2'])
    expect(columns[1].files.map((f) => f.id)).toEqual(['f3'])
  })

  it('derivedColumns appends a lane missing from laneOrder instead of dropping its files', () => {
    const state: BoardState = {
      laneOrder: ['image'],
      cardOrder: {
        image: ['f1'],
      },
    }
    const files = [
      makeFile({ id: 'f1', category: 'image', status: 'done' }),
      makeFile({ id: 'f2', category: 'video', status: 'done' }),
      makeFile({ id: 'f3', category: 'pdf', status: 'done' }),
    ]
    const columns = derivedColumns(state, files, 'all' as StatusFilter)
    expect(columns.map((c) => c.category)).toEqual(['image', 'video', 'pdf'])
    expect(columns[2].files.map((f) => f.id)).toEqual(['f3'])
  })

  it('applyCardMove reorders within a lane', () => {
    const state: BoardState = {
      laneOrder: ['image'],
      cardOrder: {
        image: ['a', 'b', 'c'],
      },
    }
    const files = [
      makeFile({ id: 'a', category: 'image', status: 'done' }),
      makeFile({ id: 'b', category: 'image', status: 'done' }),
      makeFile({ id: 'c', category: 'image', status: 'done' }),
    ]
    const next = applyCardMove(
      state,
      {
        activeId: 'b',
        overId: 'a',
        activeContainer: 'image',
        overContainer: 'image',
        overIsColumn: false,
      },
      files
    )
    expect(next.cardOrder.image).toEqual(['b', 'a', 'c'])
  })

  it('applyCardMove clamps drop index below the pinned compressing card', () => {
    const state: BoardState = {
      laneOrder: ['image'],
      cardOrder: {
        image: ['comp', 'a', 'b'],
      },
    }
    const files = [
      makeFile({ id: 'comp', category: 'image', status: 'compressing' }),
      makeFile({ id: 'a', category: 'image', status: 'done' }),
      makeFile({ id: 'b', category: 'image', status: 'done' }),
    ]
    const next = applyCardMove(
      state,
      {
        activeId: 'b',
        overId: 'comp',
        activeContainer: 'image',
        overContainer: 'image',
        overIsColumn: false,
      },
      files
    )
    expect(next.cardOrder.image).toEqual(['comp', 'b', 'a'])
  })

  it('applyCardMove pinning depends only on files contents', () => {
    const state: BoardState = {
      laneOrder: ['image'],
      cardOrder: {
        image: ['pin', 'a', 'b'],
      },
    }
    const files = [
      makeFile({ id: 'pin', category: 'image', status: 'compressing' }),
      makeFile({ id: 'a', category: 'image', status: 'done' }),
      makeFile({ id: 'b', category: 'image', status: 'done' }),
    ]
    const next = applyCardMove(
      state,
      {
        activeId: 'b',
        overId: 'pin',
        activeContainer: 'image',
        overContainer: 'image',
        overIsColumn: false,
      },
      files
    )
    expect(next.cardOrder.image).toEqual(['pin', 'b', 'a'])
  })

  it('applyCardMove ignores cross-lane moves and returns the same state', () => {
    const state: BoardState = {
      laneOrder: ['image', 'video'],
      cardOrder: {
        image: ['a'],
        video: ['b'],
      },
    }
    const files = [
      makeFile({ id: 'a', category: 'image', status: 'done' }),
      makeFile({ id: 'b', category: 'video', status: 'done' }),
    ]
    const next = applyCardMove(
      state,
      {
        activeId: 'a',
        overId: 'b',
        activeContainer: 'image',
        overContainer: 'video',
        overIsColumn: false,
      },
      files
    )
    expect(next).toBe(state)
  })

  it('applyCardMove is a no-op for unknown overId and for lanes that are not categories', () => {
    const state: BoardState = {
      laneOrder: ['image'],
      cardOrder: {
        image: ['a', 'b'],
      },
    }
    const files = [
      makeFile({ id: 'a', category: 'image', status: 'done' }),
      makeFile({ id: 'b', category: 'image', status: 'done' }),
    ]
    const unknownOver = applyCardMove(
      state,
      {
        activeId: 'a',
        overId: 'z',
        activeContainer: 'image',
        overContainer: 'image',
        overIsColumn: false,
      },
      files
    )
    expect(unknownOver).toBe(state)

    const badContainer = applyCardMove(
      state,
      {
        activeId: 'a',
        overId: 'b',
        activeContainer: 'image',
        overContainer: 'not-a-category',
        overIsColumn: false,
      },
      files
    )
    expect(badContainer).toBe(state)
  })

  it('applyCardMove appends to the lane end on column-body drop', () => {
    const state: BoardState = {
      laneOrder: ['image'],
      cardOrder: {
        image: ['a', 'b', 'c'],
      },
    }
    const files = [
      makeFile({ id: 'a', category: 'image', status: 'done' }),
      makeFile({ id: 'b', category: 'image', status: 'done' }),
      makeFile({ id: 'c', category: 'image', status: 'done' }),
    ]
    const next = applyCardMove(
      state,
      {
        activeId: 'a',
        overId: 'image',
        activeContainer: 'image',
        overContainer: 'image',
        overIsColumn: true,
      },
      files
    )
    expect(next.cardOrder.image).toEqual(['b', 'c', 'a'])
  })

  it('applyLaneOrder reorders the visible subset and keeps lanes absent from keys in place', () => {
    const state: BoardState = {
      laneOrder: ['image', 'video', 'pdf', 'document'],
      cardOrder: {},
    }
    const next = applyLaneOrder(state, ['video', 'image'])
    expect(next.laneOrder).toEqual(['video', 'image', 'pdf', 'document'])
  })

  it('applyCardMove is a no-op for a compressing active id', () => {
    const state: BoardState = {
      laneOrder: ['image'],
      cardOrder: {
        image: ['comp', 'a', 'b'],
      },
    }
    const files = [
      makeFile({ id: 'comp', category: 'image', status: 'compressing' }),
      makeFile({ id: 'a', category: 'image', status: 'done' }),
      makeFile({ id: 'b', category: 'image', status: 'done' }),
    ]
    const next = applyCardMove(
      state,
      {
        activeId: 'comp',
        overId: 'b',
        activeContainer: 'image',
        overContainer: 'image',
        overIsColumn: false,
      },
      files
    )
    expect(next).toBe(state)
  })
})
