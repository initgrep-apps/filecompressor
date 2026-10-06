import { beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { Lane } from '@/components/run/Lane'
import { formatSize } from '@/components/FileList'
import type { Category, FileEntry } from '@/types'

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
const matchMediaStub = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {
    return false
  },
})

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('matchMedia', matchMediaStub)
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

function rowOrder(): Array<string | null> {
  return Array.from(document.querySelectorAll('[data-testid^="run-row-"]')).map((el) =>
    el.getAttribute('data-testid')
  )
}

describe('Lane', () => {
  it('Lane renders header pill from laneDonePill and rows in given order', () => {
    const { container } = render(
      <Lane
        category="video"
        files={[
          makeFile({ id: 'a', name: 'Drone_Loop.mp4', status: 'done', compressedSize: 700_000 }),
          makeFile({ id: 'b', name: 'Encode_Fail.mov', status: 'failed', error: 'encoder error' }),
          makeFile({ id: 'c', name: 'B-Roll_Office_4k.mov' }),
        ]}
      />
    )
    expect(screen.getByText('Video')).toBeInTheDocument()
    expect(screen.getByTestId('lane-pill').textContent).toBe('2/3 done')
    expect(rowOrder()).toEqual(['run-row-done', 'run-row-failed', 'run-row-pending'])
    expect(container.textContent).toContain('Drone_Loop.mp4')
  })

  it('Lane pill gets green tint while any row is compressing', () => {
    const { rerender } = render(
      <Lane
        category="video"
        files={[
          makeFile({ id: 'a', status: 'compressing' }),
          makeFile({ id: 'b', status: 'done', compressedSize: 700_000 }),
          makeFile({ id: 'c' }),
        ]}
      />
    )
    const pill = screen.getByTestId('lane-pill')
    expect(pill.textContent).toBe('1/3 done')
    expect(pill.className).toContain('bg-primary/10')
    expect(pill.className).toContain('text-primary')
    expect(pill.className).not.toContain('bg-muted')
    rerender(
      <Lane
        category="video"
        files={[
          makeFile({ id: 'b', status: 'done', compressedSize: 700_000 }),
          makeFile({ id: 'c' }),
        ]}
      />
    )
    expect(screen.getByTestId('lane-pill').textContent).toBe('1/2 done')
    expect(screen.getByTestId('lane-pill').className).toContain('bg-muted')
    expect(screen.getByTestId('lane-pill').className).not.toContain('bg-primary/10')
  })

  it('Lane unmounts a removed row after AnimatePresence exit (assert with waitFor)', async () => {
    const { rerender } = render(
      <Lane
        category="video"
        files={[
          makeFile({ id: 'a', name: 'Drone_Loop.mp4', status: 'done', compressedSize: 700_000 }),
          makeFile({ id: 'b', name: 'B-Roll_Office_4k.mov' }),
        ]}
      />
    )
    expect(screen.getByText('Drone_Loop.mp4')).toBeInTheDocument()
    rerender(<Lane category="video" files={[makeFile({ id: 'b', name: 'B-Roll_Office_4k.mov' })]} />)
    await waitFor(
      () => expect(screen.queryByText('Drone_Loop.mp4')).not.toBeInTheDocument(),
      { timeout: 2000 }
    )
    expect(screen.getByText('B-Roll_Office_4k.mov')).toBeInTheDocument()
  })

  it('Lane renders no rows for empty files array; missing progress entry for a row does not crash', () => {
    const { rerender, container, unmount } = render(<Lane category="image" files={[]} />)
    expect(container.querySelectorAll('[data-testid^="run-row-"]')).toHaveLength(0)
    expect(screen.getByText('Image')).toBeInTheDocument()
    expect(screen.getByTestId('lane-pill').textContent).toBe('0/0 done')
    rerender(<Lane category="image" files={[makeFile({ status: 'compressing' })]} />)
    expect(
      screen.getByText(`${formatSize(1_100_000)} → …`)
    ).toBeInTheDocument()
    expect(screen.getByTestId('run-progress-fill').style.width).toBe('0%')
    unmount()
  })

  it('Lane header label matches the category for all five categories', () => {
    const labels: Record<Category, string> = {
      image: 'Image',
      video: 'Video',
      pdf: 'PDF',
      document: 'Document',
      other: 'Other',
    }
    for (const [category, label] of Object.entries(labels)) {
      const { unmount } = render(<Lane category={category as Category} files={[]} />)
      expect(screen.getByText(label)).toBeInTheDocument()
      unmount()
    }
  })
})
