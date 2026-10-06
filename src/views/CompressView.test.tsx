import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { setupMotionStubs } from '@/test/motionStubs'
import type { FileEntry } from '@/types'

const eventListeners = new Map<string, (e: { payload: unknown }) => void>()

let dragHandler: ((e: { payload: unknown }) => void) | undefined
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    eventListeners.set(event, handler)
    return Promise.resolve(() => {})
  }),
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: (e: { payload: unknown }) => void) => {
      dragHandler = handler
      return Promise.resolve(() => {
        if (dragHandler === handler) dragHandler = undefined
      })
    },
  }),
}))

import { CompressView } from '@/views/CompressView'
import { CompressionProvider } from '@/providers/CompressionProvider'
import { toast } from 'sonner'

const renderView = (ui = <CompressView />) =>
  render(<CompressionProvider>{ui}</CompressionProvider>)

const emit = (event: string, payload: unknown) =>
  act(() => {
    eventListeners.get(event)?.({ payload })
  })

beforeEach(() => {
  vi.clearAllMocks()
  eventListeners.clear()
  dragHandler = undefined
  setupMotionStubs()
})

function entry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    id: 'f1',
    name: 'a.jpg',
    path: '/t/a.jpg',
    category: 'image',
    targetBytes: 204800,
    originalSize: 1024,
    status: 'pending',
    compressedSize: null,
    outputPath: null,
    error: null,
    strategyUsed: null,
    qualityUsed: null,
    ...overrides,
  }
}

async function addFileInView(overrides: Partial<FileEntry> = {}) {
  return addFilesInView([overrides])
}

async function addFilesInView(entries: Array<Partial<FileEntry>>) {
  const user = userEvent.setup()
  vi.mocked(open).mockResolvedValueOnce('/t/a.jpg')
  vi.mocked(invoke).mockResolvedValueOnce(entries.map((o) => entry(o)))
  await user.click(screen.getByRole('button', { name: /drop files/i }))
  await screen.findByText(entries[0].name ?? 'a.jpg')
}

async function addViaBrowse(entries: Array<Partial<FileEntry>>) {
  const user = userEvent.setup()
  vi.mocked(open).mockResolvedValueOnce('/t/a.jpg')
  vi.mocked(invoke).mockResolvedValueOnce(entries.map((o) => entry(o)))
  await user.click(screen.getByRole('button', { name: 'Browse' }))
  await screen.findByText(entries[0].name ?? 'a.jpg')
}

async function pressCompress() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Compress' }))
  await screen.findByTestId('run-header')
}

describe('CompressView', () => {
  it('does not render banner on initial render', () => {
    renderView()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('renders destructive alert banner when add fails', async () => {
    const user = userEvent.setup()
    vi.mocked(open).mockResolvedValueOnce('/t/x.jpg')
    vi.mocked(invoke).mockRejectedValueOnce(new Error('picker dead'))
    renderView()
    await user.click(screen.getByRole('button', { name: /drop files/i }))
    await waitFor(() => {
      const banner = screen.getByRole('alert')
      expect(banner).toHaveTextContent('Could not add files')
      expect(banner).toHaveTextContent('picker dead')
    })
    expect(screen.getByRole('alert').className).toContain('destructive')
  })

  it('staging empty renders only the full-surface dropzone with no table and no card', () => {
    renderView()
    expect(screen.getByText('Drag and drop files here')).toBeInTheDocument()
    expect(screen.queryByText('No files yet')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByTestId('batch-summary')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Compress' })).not.toBeInTheDocument()
  })

  it('staging with files renders compact hero, table, and footer counts of non-unsupported sizes', async () => {
    renderView()
    await addFilesInView([
      {
        name: 'd1.jpg',
        id: 'f1',
        status: 'done',
        compressedSize: 100,
        outputPath: '/o/d1.jpg',
        originalSize: 1258291,
      },
      { name: 'p1.jpg', id: 'f2', originalSize: 1024 },
      {
        name: 's1.jpg',
        id: 'f3',
        category: 'other',
        originalSize: 2048,
        targetBytes: 0,
        status: 'unsupported',
      },
    ])
    expect(screen.getByText('Drop more files here')).toBeInTheDocument()
    expect(screen.queryByText('Drag and drop files here')).not.toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByTestId('batch-summary').textContent).toBe(
      '2 files selected · Total size: ~1.2 MB'
    )
    expect(screen.getByRole('button', { name: 'Compress' })).toBeEnabled()
  })

  it('compress button disabled when no pending files', async () => {
    renderView()
    await addFileInView({ status: 'done', compressedSize: 100, outputPath: '/o/a.jpg' })
    expect(screen.getByRole('button', { name: 'Compress' })).toBeDisabled()
  })

  it('compress button enabled with pending files and triggers compression', async () => {
    const user = userEvent.setup()
    renderView()
    await addFileInView()
    const btn = screen.getByRole('button', { name: 'Compress' })
    expect(btn).toBeEnabled()
    await user.click(btn)
    expect(invoke).toHaveBeenCalledWith('compress_all')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('compress press switches to locked run screen with Batch #1, Compressing pill, and roster lanes', async () => {
    renderView()
    await addFileInView()
    await pressCompress()
    expect(invoke).toHaveBeenCalledWith('compress_all')
    expect(screen.getByTestId('batch-pill')).toHaveTextContent('Batch #1')
    expect(screen.getByTestId('status-pill')).toHaveTextContent('Compressing')
    expect(screen.getByText('Image')).toBeInTheDocument()
    expect(screen.getByText('a.jpg')).toBeInTheDocument()
    expect(screen.queryByText('Drag and drop files here')).not.toBeInTheDocument()
    expect(screen.queryByText('Drop more files here')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument()
  })

  it('run screen toasts and ignores drop while running', async () => {
    renderView()
    await addFileInView()
    await pressCompress()
    if (!dragHandler) throw new Error('run screen drop guard is not registered')
    act(() => {
      dragHandler?.({ payload: { type: 'drop', paths: ['/t/late.jpg'] } })
    })
    expect(toast.info).toHaveBeenCalledWith('Batch in progress — wait until it completes')
    expect(screen.queryByText('late.jpg')).not.toBeInTheDocument()
  })

  it('batch:error event shows Failed pill and error line on run screen', async () => {
    renderView()
    await addFileInView()
    await pressCompress()
    emit('batch:error', { batchId: 'b1', errorMessage: 'Output folder not writable' })
    expect(screen.getByTestId('status-pill').getAttribute('data-state')).toBe('failed')
    expect(screen.getByTestId('batch-error')).toHaveTextContent('Output folder not writable')
    expect(screen.getByTestId('new-batch')).toBeInTheDocument()
    expect(screen.queryByTestId('cancel-all')).not.toBeInTheDocument()
  })

  it('Cancel All appears while compressing and New batch replaces it after completion', async () => {
    renderView()
    await addFileInView()
    expect(screen.queryByTestId('cancel-all')).not.toBeInTheDocument()
    await pressCompress()
    expect(screen.getByTestId('cancel-all')).toBeInTheDocument()
    expect(screen.queryByTestId('new-batch')).not.toBeInTheDocument()
    emit('batch:complete', { batchId: 'b1', totalSavedBytes: 0 })
    await waitFor(() =>
      expect(screen.queryByTestId('cancel-all')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('new-batch')).toBeInTheDocument()
  })

  it('cancel all click invokes cancel_all', async () => {
    renderView()
    await addFileInView()
    vi.mocked(invoke).mockResolvedValue('b1')
    await pressCompress()
    const user = userEvent.setup()
    await user.click(screen.getByTestId('cancel-all'))
    expect(invoke).toHaveBeenCalledWith('cancel_all')
  })

  it('file:cancelled marks the roster row and pending rows stay listed', async () => {
    renderView()
    await addFilesInView([
      { name: 'p1.jpg', id: 'f1' },
      { name: 'p2.jpg', id: 'f2', path: '/t/p2.jpg' },
    ])
    await pressCompress()
    emit('file:cancelled', { fileId: 'f1' })
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
    expect(screen.getByText('p2.jpg')).toBeInTheDocument()
  })

  it('New batch after completion returns to staging with final statuses still listed', async () => {
    renderView()
    await addFileInView({ originalSize: 1258291 })
    vi.mocked(invoke).mockResolvedValueOnce('b1')
    await pressCompress()
    emit('file:complete', {
      fileId: 'f1',
      outputPath: '/o/a.jpg',
      originalSize: 1258291,
      compressedSize: 184320,
      status: 'done',
      metTarget: true,
    })
    emit('batch:complete', { batchId: 'b1', totalSavedBytes: 512 })
    await waitFor(() => {
      expect(screen.getByTestId('status-pill').getAttribute('data-state')).toBe('complete')
    })
    const user = userEvent.setup()
    await user.click(screen.getByTestId('new-batch'))
    await screen.findByRole('table')
    expect(screen.queryByTestId('run-header')).not.toBeInTheDocument()
    expect(screen.getByText('Drop more files here')).toBeInTheDocument()
    expect(screen.getByText('a.jpg')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(screen.getByTestId('batch-summary').textContent).toBe(
      '1 files selected · Total size: ~1.2 MB'
    )
  })

  it('batch number increments on second compress and second roster holds only new pending files', async () => {
    renderView()
    await addFileInView()
    await pressCompress()
    emit('file:complete', {
      fileId: 'f1',
      outputPath: '/o/a.jpg',
      originalSize: 1024,
      compressedSize: 512,
      status: 'done',
      metTarget: true,
    })
    emit('batch:complete', { batchId: 'b1', totalSavedBytes: 512 })
    await waitFor(() => {
      expect(screen.getByTestId('status-pill').getAttribute('data-state')).toBe('complete')
    })
    const user = userEvent.setup()
    await user.click(screen.getByTestId('new-batch'))
    await addViaBrowse([{ id: 'f2', name: 'b2.jpg', path: '/t/b2.jpg' }])
    await pressCompress()
    expect(screen.getByTestId('batch-pill')).toHaveTextContent('Batch #2')
    expect(screen.getByText('b2.jpg')).toBeInTheDocument()
    expect(screen.queryByText('a.jpg')).not.toBeInTheDocument()
  })

  it('chips reflect full-roster counts while a filter is active', async () => {
    renderView()
    await addFilesInView([
      { name: 'p1.jpg', id: 'f1' },
      { name: 'p2.jpg', id: 'f2', path: '/t/p2.jpg' },
    ])
    await pressCompress()
    expect(screen.getAllByTestId('chip-count').map((c) => c.textContent)).toEqual(['2', '2'])
    const user = userEvent.setup()
    await user.click(screen.getByTestId('chip-queued'))
    expect(screen.getByTestId('chip-queued')).toHaveAttribute('aria-pressed', 'true')
    emit('file:progress', { fileId: 'f1', percent: 40 })
    expect(screen.getAllByTestId('chip-count').map((c) => c.textContent)).toEqual(['2', '1', '1'])
    expect(screen.getByText('p2.jpg')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('p1.jpg')).not.toBeInTheDocument())
    emit('file:complete', {
      fileId: 'f1',
      outputPath: '/o/p1.jpg',
      originalSize: 1024,
      compressedSize: 512,
      status: 'done',
      metTarget: true,
    })
    expect(screen.getAllByTestId('chip-count').map((c) => c.textContent)).toEqual(['2', '1', '1'])
    expect(screen.getByTestId('chip-queued')).toHaveAttribute('aria-pressed', 'true')
  })

  it('summary footer sits outside the scroll container', async () => {
    renderView()
    await addFileInView()
    const card = screen.getByTestId('batch-summary').closest('[data-slot="card"]')
    if (!card) throw new Error('batch summary not inside a card')
    const scrollRegion = card.querySelector('[data-slot="file-list-scroll"]')
    if (!scrollRegion) throw new Error('file-list card has no scroll region')

    expect(scrollRegion.contains(screen.getByRole('table'))).toBe(true)
    expect(scrollRegion.contains(screen.getByTestId('batch-summary'))).toBe(false)
    expect(scrollRegion.contains(screen.getByRole('button', { name: 'Compress' }))).toBe(false)
    expect(scrollRegion.contains(screen.getByRole('button', { name: 'Clear List' }))).toBe(false)
  })

  it('compact hero is pinned outside the file-list card', async () => {
    renderView()
    await addFileInView()
    const listCard = screen.getByTestId('batch-summary').closest('[data-slot="card"]')
    if (!listCard) throw new Error('batch summary not inside a card')
    const dropzone = screen.getByText('Drop more files here').closest('[role="button"]')
    if (!dropzone) throw new Error('compact hero is not a click target')
    expect(listCard.contains(dropzone)).toBe(false)
  })

  it('file-list panel is inset inside the card, not full-bleed', async () => {
    renderView()
    await addFileInView()
    const card = screen.getByTestId('batch-summary').closest('[data-slot="card"]')
    if (!card) throw new Error('batch summary not inside a card')
    const content = card.querySelector('[data-slot="card-content"]')
    if (!content) throw new Error('file-list card has no content wrapper')

    expect(content.className).toContain('px-(--card-spacing)')
    expect(content.className).not.toContain('p-0')
  })

  it('batch complete toast shows total saved bytes', async () => {
    renderView()
    await addFileInView({ originalSize: 1258291 })
    vi.mocked(invoke).mockResolvedValueOnce('b1')
    await pressCompress()
    emit('file:complete', {
      fileId: 'f1',
      outputPath: '/o/a.jpg',
      originalSize: 1258291,
      compressedSize: 184320,
      status: 'done',
      metTarget: true,
    })
    emit('batch:complete', { batchId: 'b1', totalSavedBytes: 2048 })
    expect(toast.success).toHaveBeenCalledTimes(1)
    const message = vi.mocked(toast.success).mock.calls[0][0] as string
    expect(message).toContain('Compressed 1 files')
    expect(message).toContain('Saved 2 KB total')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('error count toast shows count when errors accumulated', async () => {
    renderView()
    await addFilesInView([
      { name: 'x1.jpg', id: 'f1' },
      { name: 'x2.jpg', id: 'f2' },
      { name: 'd1.jpg', id: 'f3' },
    ])
    await pressCompress()
    emit('file:error', { fileId: 'f1', errorMessage: 'boom' })
    emit('file:error', { fileId: 'f2', errorMessage: 'boom' })
    emit('file:complete', {
      fileId: 'f3',
      outputPath: '/o/d1.jpg',
      originalSize: 10,
      compressedSize: 5,
      status: 'done',
      metTarget: true,
    })
    emit('batch:complete', { batchId: 'b1', totalSavedBytes: 5 })
    expect(toast.error).toHaveBeenCalledWith('2 files could not reach target.')
    expect(toast.success).toHaveBeenCalledTimes(1)
  })

  it('toast success says compressed N files with done count', async () => {
    renderView()
    await addFilesInView(
      Array.from({ length: 10 }, (_, i) => ({
        id: `f${i}`,
        name: `f${i}.jpg`,
        path: `/t/f${i}.jpg`,
        ...(i >= 8 ? { status: 'unsupported' as const } : {}),
      }))
    )
    await pressCompress()
    for (let i = 0; i < 8; i++) {
      emit('file:complete', {
        fileId: `f${i}`,
        outputPath: `/o/f${i}.jpg`,
        originalSize: 10,
        compressedSize: 5,
        status: 'done',
        metTarget: true,
      })
    }
    emit('batch:complete', { batchId: 'b1', totalSavedBytes: 24 })
    const message = vi.mocked(toast.success).mock.calls[0][0] as string
    expect(message).toContain('Compressed 8 files')
    expect(message).not.toContain('10')
  })

  it('batch error toast shows message', async () => {
    renderView()
    await addFileInView()
    await pressCompress()
    emit('batch:error', { batchId: 'b1', errorMessage: 'Output folder not writable' })
    expect(toast.error).toHaveBeenCalledWith('Output folder not writable')
  })
})
