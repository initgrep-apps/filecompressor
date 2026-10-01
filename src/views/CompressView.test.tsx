import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { FileEntry } from '@/types'

const eventListeners = new Map<string, (e: { payload: unknown }) => void>()

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    eventListeners.set(event, handler)
    return Promise.resolve(() => {})
  }),
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve(() => {}),
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
  })

  it('cancel all button visible during compression only', async () => {
    const user = userEvent.setup()
    renderView()
    expect(screen.queryByRole('button', { name: 'Cancel All' })).not.toBeInTheDocument()
    await addFileInView()
    await user.click(screen.getByRole('button', { name: 'Compress' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel All' })).toBeInTheDocument()
    )
    emit('batch:complete', { batchId: 'b1', totalSavedBytes: 0 })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Cancel All' })).not.toBeInTheDocument()
    )
  })

  it('compress button disabled while compressing', async () => {
    const user = userEvent.setup()
    renderView()
    await addFileInView()
    await user.click(screen.getByRole('button', { name: 'Compress' }))
    await screen.findByRole('button', { name: 'Cancel All' })
    expect(screen.getByRole('button', { name: 'Compress' })).toBeDisabled()
  })

  it('clear list disabled while compressing', async () => {
    const user = userEvent.setup()
    renderView()
    await addFileInView()
    await user.click(screen.getByRole('button', { name: 'Compress' }))
    await screen.findByRole('button', { name: 'Cancel All' })
    expect(screen.getByRole('button', { name: 'Clear List' })).toBeDisabled()
  })

  it('batch summary counts mixed statuses', async () => {
    renderView()
    await addFilesInView([
      { name: 'd1.jpg', id: 'f1', status: 'done', compressedSize: 100, outputPath: '/o/d1.jpg' },
      { name: 'd2.jpg', id: 'f2', status: 'done', compressedSize: 100, outputPath: '/o/d2.jpg' },
      { name: 'c1.jpg', id: 'f3', status: 'compressing' },
      { name: 'p1.jpg', id: 'f4', status: 'pending' },
      { name: 'w1.jpg', id: 'f5', status: 'best_effort', compressedSize: 100, outputPath: '/o/w1.jpg' },
      { name: 'exact.jpg', id: 'ex', status: 'already_under_target', compressedSize: 100, outputPath: '/o/exact.jpg' },
      { name: 's1.jpg', id: 'f6', status: 'unsupported' },
    ])
    expect(screen.getByTestId('batch-summary').textContent).toBe(
      '7 files · 3 done · 1 compressing · 1 pending · 1 warning · 1 skipped'
    )
  })

  it('failed files counted in summary', async () => {
    renderView()
    await addFilesInView([
      { name: 'd1.jpg', id: 'f1', status: 'done', compressedSize: 100, outputPath: '/o/d1.jpg' },
      { name: 'x1.jpg', id: 'f2', status: 'failed', error: 'boom' },
    ])
    expect(screen.getByTestId('batch-summary').textContent).toBe('2 files · 1 done · 1 failed')
  })

  it('cancelled files represented in summary', async () => {
    renderView()
    await addFilesInView([
      { name: 'p1.jpg', id: 'f1', status: 'pending' },
      { name: 'x1.jpg', id: 'f2', status: 'cancelled' },
    ])
    expect(screen.getByTestId('batch-summary').textContent).toBe('2 files · 1 pending · 1 cancelled')
  })

  it('already under target counted as done in summary', async () => {
    renderView()
    await addFilesInView([
      { name: 'a1.jpg', id: 'f1', status: 'already_under_target', compressedSize: 100, outputPath: '/o/a1.jpg' },
    ])
    expect(screen.getByTestId('batch-summary').textContent).toBe('1 files · 1 done')
  })

  it('summary updates live during compression', async () => {
    const user = userEvent.setup()
    renderView()
    await addFileInView()
    const summary = () => screen.getByTestId('batch-summary').textContent
    expect(summary()).toBe('1 files · 1 pending')
    await user.click(screen.getByRole('button', { name: 'Compress' }))
    await screen.findByRole('button', { name: 'Cancel All' })
    emit('file:progress', { fileId: 'f1', percent: 40 })
    await waitFor(() => expect(summary()).toBe('1 files · 1 compressing'))
    emit('file:complete', {
      fileId: 'f1',
      outputPath: '/o/a.jpg',
      originalSize: 1024,
      compressedSize: 512,
      status: 'done',
      metTarget: true,
    })
    await waitFor(() => expect(summary()).toBe('1 files · 1 done'))
  })

  it('cancel all click invokes cancel_all', async () => {
    const user = userEvent.setup()
    renderView()
    await addFileInView()
    vi.mocked(invoke).mockResolvedValue('b1')
    await user.click(screen.getByRole('button', { name: 'Compress' }))
    await screen.findByRole('button', { name: 'Cancel All' })
    await user.click(screen.getByRole('button', { name: 'Cancel All' }))
    expect(invoke).toHaveBeenCalledWith('cancel_all')
  })

  it('batch complete toast shows total saved bytes', async () => {
    const user = userEvent.setup()
    renderView()
    await addFileInView({ originalSize: 1258291 })
    await user.click(screen.getByRole('button', { name: 'Compress' }))
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
    const user = userEvent.setup()
    renderView()
    await addFilesInView([
      { name: 'x1.jpg', id: 'f1' },
      { name: 'x2.jpg', id: 'f2' },
      { name: 'd1.jpg', id: 'f3' },
    ])
    await user.click(screen.getByRole('button', { name: 'Compress' }))
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
    const user = userEvent.setup()
    renderView()
    await addFilesInView(
      Array.from({ length: 10 }, (_, i) => ({
        id: `f${i}`,
        name: `f${i}.jpg`,
        ...(i >= 8 ? { status: 'unsupported' as const } : {}),
      }))
    )
    await user.click(screen.getByRole('button', { name: 'Compress' }))
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
    const user = userEvent.setup()
    renderView()
    await addFileInView()
    await user.click(screen.getByRole('button', { name: 'Compress' }))
    emit('batch:error', { batchId: 'b1', errorMessage: 'Output folder not writable' })
    expect(toast.error).toHaveBeenCalledWith('Output folder not writable')
  })

  it('summary footer sits outside the scroll container', async () => {
    renderView()
    await addFileInView()
    const card = screen.getByTestId('batch-summary').closest('[data-slot="card"]')!
    const scrollArea = card.querySelector('[data-slot="scroll-area"]')!
    const summary = card.querySelector('[data-testid="batch-summary"]')!
    expect(card.contains(scrollArea)).toBe(true)
    expect(scrollArea.contains(summary)).toBe(false)
  })

  it('drop zone is pinned outside the file-list card', async () => {
    renderView()
    await addFileInView()
    const listCard = screen.getByTestId('batch-summary').closest('[data-slot="card"]')
    const dropzone = screen.getByRole('button', { name: /drop files/i })
    expect(listCard!.contains(dropzone)).toBe(false)
  })

  it('renders empty state when no files', () => {
    renderView()
    const emptyCard = screen.getByText('No files yet').closest('[data-slot="card"]')
    expect(emptyCard).not.toBeNull()
  })

  it('compress button shows spinner while compressing', async () => {
    const user = userEvent.setup()
    renderView()
    await addFileInView()
    const btn = screen.getByRole('button', { name: 'Compress' })
    expect(btn.querySelector('[data-slot="spinner"]')).toBeNull()
    await user.click(btn)
    await screen.findByRole('button', { name: 'Cancel All' })
    expect(btn.querySelector('[data-slot="spinner"]')).not.toBeNull()
    emit('batch:complete', { batchId: 'b1', totalSavedBytes: 0 })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Cancel All' })).not.toBeInTheDocument()
    )
    expect(btn.querySelector('[data-slot="spinner"]')).toBeNull()
  })

  it('compress button exposes aria-busy while compressing', async () => {
    const user = userEvent.setup()
    renderView()
    await addFileInView()
    const btn = screen.getByRole('button', { name: 'Compress' })
    expect(btn).toHaveAttribute('aria-busy', 'false')
    await user.click(btn)
    await screen.findByRole('button', { name: 'Cancel All' })
    expect(btn).toHaveAttribute('aria-busy', 'true')
    emit('batch:complete', { batchId: 'b1', totalSavedBytes: 0 })
    await waitFor(() => expect(btn).toHaveAttribute('aria-busy', 'false'))
  })
})
