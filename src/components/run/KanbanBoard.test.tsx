import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RunHeader } from '@/components/run/RunHeader'
import { KanbanBoard } from '@/components/run/KanbanBoard'
import { batchCounts, type StatusFilter } from '@/lib/grouping'
import { setupMotionStubs } from '@/test/motionStubs'
import type { FileEntry } from '@/types'

beforeAll(() => {
  setupMotionStubs()
})

function makeFile(patch: Partial<FileEntry> = {}): FileEntry {
  return {
    id: 'f1',
    name: 'IMG_5647.MOV',
    path: '/tmp/IMG_5647.MOV',
    category: 'video',
    targetBytes: 8_388_608,
    originalSize: 1_100_000,
    status: 'pending',
    compressedSize: null,
    outputPath: null,
    error: null,
    strategyUsed: null,
    qualityUsed: null,
    ...patch,
  }
}

const LABEL_TO_CATEGORY: Record<string, string> = {
  Image: 'image',
  Video: 'video',
  PDF: 'pdf',
  Document: 'document',
  Other: 'other',
}

function laneLabels(): string[] {
  return Array.from(document.querySelectorAll('span')).flatMap((el) => {
    const category = LABEL_TO_CATEGORY[el.textContent ?? '']
    return category ? [category] : []
  })
}

const ALL_HANDLERS = {
  onFilterChange: vi.fn(),
  onCancel: vi.fn(),
  onReveal: vi.fn(),
  onRemove: vi.fn(),
}

function boardFor(roster: FileEntry[], statusFilter: StatusFilter = 'all') {
  return <KanbanBoard roster={roster} statusFilter={statusFilter} {...ALL_HANDLERS} />
}

describe('KanbanBoard', () => {
  it('renders one lane per category present in LANE_ORDER; single-category roster renders a single lane', () => {
    const mixed = [
      makeFile({ id: 'a', name: 'Photo.png', category: 'image' }),
      makeFile({ id: 'b', name: 'Clip.mov', category: 'video', status: 'done' }),
      makeFile({ id: 'c', name: 'Doc.pdf', category: 'pdf', status: 'done' }),
      makeFile({ id: 'd', name: 'Note.docx', category: 'document', status: 'done' }),
      makeFile({ id: 'e', name: 'Data.bin', category: 'other', status: 'done' }),
    ]
    const { rerender } = render(boardFor(mixed))
    expect(laneLabels()).toEqual(['image', 'video', 'pdf', 'document', 'other'])
    expect(screen.getByTestId('kanban-board').className).toContain('overflow-x-auto')

    rerender(boardFor([makeFile({ name: 'Photo.png', category: 'image' })]))
    expect(laneLabels()).toEqual(['image'])
  })

  it('failed filter renders only lanes containing failed rows', () => {
    render(
      boardFor(
        [
          makeFile({ id: 'a', name: 'Photo_done.png', category: 'image', status: 'done' }),
          makeFile({ id: 'b', name: 'Encode_Fail.mov', category: 'video', status: 'failed' }),
        ],
        'failed'
      )
    )
    expect(laneLabels()).toEqual(['video'])
    expect(screen.getByText('Encode_Fail.mov')).toBeInTheDocument()
    expect(screen.queryByText('Photo_done.png')).not.toBeInTheDocument()
  })

  it('filtered row unmounts when its status leaves the filter without crashing and header counts stay roster-based', async () => {
    const roster = [
      makeFile({ id: 'a', name: 'Drone_Loop.mp4', status: 'done' }),
      makeFile({ id: 'b', name: 'B-Roll.mp4', status: 'done' }),
    ]
    const onFilterChange = vi.fn()
    const headerProps = (files: FileEntry[]) => ({
      batchNumber: 1,
      running: true,
      batchError: null,
      counts: batchCounts(files),
      total: files.length,
      statusFilter: 'complete' as StatusFilter,
      onFilterChange,
      onCancelAll: vi.fn(),
      onNewBatch: vi.fn(),
    })
    const boardProps = (files: FileEntry[]) => ({
      roster: files,
      statusFilter: 'complete' as StatusFilter,
      onFilterChange,
      onCancel: vi.fn(),
      onReveal: vi.fn(),
      onRemove: vi.fn(),
    })
    const nextRoster = [
      makeFile({ id: 'a', name: 'Drone_Loop.mp4', status: 'compressing' }),
      makeFile({ id: 'b', name: 'B-Roll.mp4', status: 'done' }),
    ]
    const { rerender } = render(
      <div>
        <RunHeader {...headerProps(roster)} />
        <KanbanBoard {...boardProps(roster)} />
      </div>
    )
    expect(screen.getByTestId('chip-all').textContent).toBe('All files2')
    expect(screen.getByTestId('chip-complete').textContent).toBe('Complete2')

    rerender(
      <div>
        <RunHeader {...headerProps(nextRoster)} />
        <KanbanBoard {...boardProps(nextRoster)} />
      </div>
    )
    await waitFor(
      () => expect(screen.queryByText('Drone_Loop.mp4')).not.toBeInTheDocument(),
      { timeout: 2000 }
    )
    expect(screen.getByText('B-Roll.mp4')).toBeInTheDocument()
    expect(screen.getByTestId('chip-all').textContent).toBe('All files2')
    expect(screen.getByTestId('chip-complete').textContent).toBe('Complete1')
    expect(screen.getByTestId('chip-compressing').textContent).toBe('Processing1')
  })

  it('filtered-empty board shows Nothing {x} right now keyed to the active filter with a working Show all link', () => {
    const cases: Array<[StatusFilter, string, FileEntry[]]> = [
      ['compressing', 'Nothing processing right now', [makeFile({ status: 'done' })]],
      ['complete', 'Nothing complete right now', [makeFile({ status: 'compressing' })]],
      ['below_target', 'Nothing below target right now', [makeFile({ status: 'done' })]],
      ['failed', 'Nothing failed right now', [makeFile({ status: 'done' })]],
      ['queued', 'Nothing queued right now', [makeFile({ status: 'compressing' })]],
    ]
    for (const [filter, message, files] of cases) {
      const { unmount } = render(boardFor(files, filter))
      expect(screen.getByText(message)).toBeInTheDocument()
      expect(screen.getByTestId('show-all')).toBeInTheDocument()
      unmount()
    }

    const { unmount } = render(boardFor([], 'all'))
    expect(screen.getByText('Nothing here right now')).toBeInTheDocument()
    expect(screen.getByTestId('show-all')).toBeInTheDocument()
    unmount()
  })

  it('populated board rerenders to filtered-empty when every row leaves the filter, showing same-tree empty state', () => {
    const initial = [
      makeFile({ id: 'a', name: 'Fail_A.mov', status: 'failed' }),
      makeFile({ id: 'b', name: 'Fail_B.mov', status: 'failed' }),
    ]
    const next = [
      makeFile({ id: 'a', name: 'Fail_A.mov', status: 'done' }),
      makeFile({ id: 'b', name: 'Fail_B.mov', status: 'done' }),
    ]
    const propsFor = (roster: FileEntry[]) => ({
      roster,
      statusFilter: 'failed' as StatusFilter,
      onFilterChange: vi.fn(),
      onCancel: vi.fn(),
      onReveal: vi.fn(),
      onRemove: vi.fn(),
    })

    const { rerender } = render(<KanbanBoard {...propsFor(initial)} />)
    expect(laneLabels()).toEqual(['video'])

    rerender(<KanbanBoard {...propsFor(next)} />)
    expect(screen.queryByTestId('kanban-board')).not.toBeInTheDocument()
    expect(screen.getByText('Nothing failed right now')).toBeInTheDocument()
    expect(screen.getByTestId('show-all')).toBeInTheDocument()
    expect(screen.queryByText('Fail_A.mov')).not.toBeInTheDocument()
    expect(screen.queryByText('Fail_B.mov')).not.toBeInTheDocument()
  })

  it('Show all link resets the filter to all', () => {
    const onFilterChange = vi.fn()
    render(
      <KanbanBoard
        roster={[makeFile({ status: 'done' })]}
        statusFilter="failed"
        onFilterChange={onFilterChange}
        onCancel={vi.fn()}
        onReveal={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('show-all'))
    expect(onFilterChange).toHaveBeenCalledTimes(1)
    expect(onFilterChange).toHaveBeenCalledWith('all')
  })

  it("fills its container height and drops the fixed lane cap", () => {
    render(boardFor([makeFile()]))
    const board = document.querySelector('[data-testid="kanban-board"]') as HTMLElement
    expect(board.className).toContain("h-full")
    expect(document.body.innerHTML).not.toContain("max-h-[533px]")
  })

  it("pans horizontally from a vertical wheel", () => {
    render(boardFor([makeFile()]))
    const board = document.querySelector('[data-testid="kanban-board"]') as HTMLElement
    Object.defineProperty(board, "scrollLeft", { value: 0, writable: true })
    fireEvent.wheel(board, { deltaY: 240 })
    expect(board.scrollLeft).toBe(240)
  })

  it('lane rows receive progress percent', () => {
    render(
      <KanbanBoard
        roster={[makeFile({ status: 'compressing' })]}
        statusFilter="all"
        progress={{ f1: 45 }}
        {...ALL_HANDLERS}
      />
    )
    expect(screen.getByTestId('run-progress-fill').style.width).toBe('45%')
    expect(screen.getByText('45%')).toBeInTheDocument()
  })

  it('removeDisabled suppresses row remove buttons; otherwise Remove is wired', () => {
    const onRemove = vi.fn()
    const { rerender } = render(
      <KanbanBoard
        roster={[makeFile({ id: 'f1', name: 'Remove.png' })]}
        statusFilter="all"
        onFilterChange={vi.fn()}
        onCancel={vi.fn()}
        onReveal={vi.fn()}
        onRemove={onRemove}
        removeDisabled
      />
    )
    expect(screen.queryByRole('button', { name: 'Remove Remove.png' })).not.toBeInTheDocument()

    rerender(
      <KanbanBoard
        roster={[makeFile({ id: 'f1', name: 'Remove.png' })]}
        statusFilter="all"
        onFilterChange={vi.fn()}
        onCancel={vi.fn()}
        onReveal={vi.fn()}
        onRemove={onRemove}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove Remove.png' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onRemove).toHaveBeenCalledWith('f1')
  })

  it('renders no right-edge fade overlay', () => {
    render(boardFor([makeFile({ status: 'done' })]))
    expect(document.querySelectorAll('[class*="to-card"]')).toHaveLength(0)
  })

  it('scroll container has right padding for scroll end', () => {
    render(boardFor([makeFile({ status: 'done' })]))
    expect(screen.getByTestId('kanban-board').className).toContain('pr-6')
  })
})
