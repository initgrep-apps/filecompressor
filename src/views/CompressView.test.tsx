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
import { toast } from 'sonner'

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
  const user = userEvent.setup()
  vi.mocked(open).mockResolvedValueOnce('/t/a.jpg')
  vi.mocked(invoke).mockResolvedValueOnce([entry(overrides)])
  await user.click(screen.getByRole('button', { name: /drop files/i }))
  await screen.findByText('a.jpg')
}

describe('CompressView', () => {
  it('does not render banner on initial render', () => {
    render(<CompressView />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('renders destructive alert banner when add fails', async () => {
    const user = userEvent.setup()
    vi.mocked(open).mockResolvedValueOnce('/t/x.jpg')
    vi.mocked(invoke).mockRejectedValueOnce(new Error('picker dead'))
    render(<CompressView />)
    await user.click(screen.getByRole('button', { name: /drop files/i }))
    await waitFor(() => {
      const banner = screen.getByRole('alert')
      expect(banner).toHaveTextContent('Could not add files')
      expect(banner).toHaveTextContent('picker dead')
    })
    expect(screen.getByRole('alert').className).toContain('destructive')
  })

  it('compress button disabled when no pending files', async () => {
    render(<CompressView />)
    await addFileInView({ status: 'done', compressedSize: 100, outputPath: '/o/a.jpg' })
    expect(screen.getByRole('button', { name: 'Compress' })).toBeDisabled()
  })

  it('compress button enabled with pending files and triggers compression', async () => {
    const user = userEvent.setup()
    render(<CompressView />)
    await addFileInView()
    const btn = screen.getByRole('button', { name: 'Compress' })
    expect(btn).toBeEnabled()
    await user.click(btn)
    expect(invoke).toHaveBeenCalledWith('compress_all')
  })

  it('cancel all button visible during compression only', async () => {
    const user = userEvent.setup()
    render(<CompressView />)
    expect(screen.queryByRole('button', { name: 'Cancel All' })).not.toBeInTheDocument()
    await addFileInView()
    await user.click(screen.getByRole('button', { name: 'Compress' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel All' })).toBeInTheDocument()
    )
  })

  it('batch complete toast shows total saved bytes', async () => {
    const user = userEvent.setup()
    render(<CompressView />)
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
  })

  it('batch error toast shows message', async () => {
    const user = userEvent.setup()
    render(<CompressView />)
    await addFileInView()
    await user.click(screen.getByRole('button', { name: 'Compress' }))
    emit('batch:error', { batchId: 'b1', errorMessage: 'Output folder not writable' })
    expect(toast.error).toHaveBeenCalledWith('Output folder not writable')
  })
})
