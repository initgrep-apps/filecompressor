import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, act } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import type { FileEntry } from '@/types'

const listeners = new Map<string, Set<(e: { payload: unknown }) => void>>()
const unlistens: Array<() => void> = []

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    const set = listeners.get(event) ?? new Set()
    set.add(handler)
    listeners.set(event, set)
    const unlisten = () => {
      set.delete(handler)
    }
    unlistens.push(unlisten)
    return Promise.resolve(unlisten)
  }),
}))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { CompressionProvider, useCompressionContext } from '@/providers/CompressionProvider'
import { listen } from '@tauri-apps/api/event'
import { toast } from 'sonner'

const flush = () => act(async () => {})

const emit = (event: string, payload: unknown) =>
  act(() => {
    listeners.get(event)?.forEach((h) => h({ payload }))
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

function Row({ paths }: { paths: string[] }) {
  const { files, addFiles } = useCompressionContext()
  return (
    <div>
      <button type="button" onClick={() => addFiles(paths)}>
        add
      </button>
      <ul>
        {files.map((f) => (
          <li key={f.id}>
            {f.name}
            {f.status !== 'pending' ? ` (${f.status})` : ''}
          </li>
        ))}
      </ul>
    </div>
  )
}

describe('CompressionProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listeners.clear()
    unlistens.length = 0
  })

  it('shares list state across consumer remounts (view-switch survival)', async () => {
    vi.mocked(invoke).mockResolvedValue([entry()])
    const { rerender } = render(
      <CompressionProvider>
        <Row paths={['/t/a.jpg']} />
      </CompressionProvider>
    )
    await flush()
    await act(async () => {
      await screen.getByRole('button', { name: 'add' }).click()
    })
    expect(screen.getByText('a.jpg')).toBeInTheDocument()
    // Simulate CompressView unmount/remount: consumer dies, provider persists.
    rerender(<CompressionProvider>{null}</CompressionProvider>)
    rerender(
      <CompressionProvider>
        <Row paths={['/t/a.jpg']} />
      </CompressionProvider>
    )
    expect(screen.getByText('a.jpg')).toBeInTheDocument()
  })

  it('re-drop of same path keeps one row and a new path appends', async () => {
    // First drop: backend accepts a.jpg.
    vi.mocked(invoke).mockResolvedValueOnce([entry()])
    // Second drop of the same path: backend dedups → returns nothing.
    vi.mocked(invoke).mockResolvedValueOnce([])
    // Third drop: same path + a new one → only the new entry comes back.
    vi.mocked(invoke).mockResolvedValueOnce([entry({ id: 'f2', name: 'b.jpg', path: '/t/b.jpg' })])
    const { rerender } = render(
      <CompressionProvider>
        <Row paths={['/t/a.jpg']} />
      </CompressionProvider>
    )
    await flush()
    const add = async (paths: string[]) => {
      rerender(
        <CompressionProvider>
          <Row paths={paths} />
        </CompressionProvider>
      )
      await act(async () => {
        await screen.getByRole('button', { name: 'add' }).click()
      })
    }
    await add(['/t/a.jpg'])
    expect(screen.getAllByText('a.jpg')).toHaveLength(1)
    // Dedup drop: backend returns [] — frontend must still show exactly one row.
    await add(['/t/a.jpg'])
    expect(screen.getAllByText('a.jpg')).toHaveLength(1)
    // New file appends.
    await add(['/t/a.jpg', '/t/b.jpg'])
    expect(screen.getAllByText('a.jpg')).toHaveLength(1)
    expect(screen.getByText('b.jpg')).toBeInTheDocument()
  })

  it('events fired while consumer unmounted update the remounted consumer', async () => {
    vi.mocked(invoke).mockResolvedValue([entry()])
    const { rerender } = render(
      <CompressionProvider>
        <Row paths={['/t/a.jpg']} />
      </CompressionProvider>
    )
    await flush()
    await act(async () => {
      await screen.getByRole('button', { name: 'add' }).click()
    })
    expect(screen.getByText('a.jpg')).toBeInTheDocument()
    // "Navigate away": unmount the consumer while the provider keeps listening.
    rerender(<CompressionProvider>{null}</CompressionProvider>)
    emit('file:progress', { fileId: 'f1', percent: 50 })
    emit('file:complete', {
      fileId: 'f1',
      outputPath: '/o/a.jpg',
      originalSize: 1024,
      compressedSize: 512,
      status: 'done',
      metTarget: true,
    })
    // "Come back": consumer remounts and must see the final state.
    rerender(
      <CompressionProvider>
        <Row paths={['/t/a.jpg']} />
      </CompressionProvider>
    )
    expect(screen.getByText('a.jpg (done)')).toBeInTheDocument()
  })

  it('registers IPC listeners exactly once under StrictMode', async () => {
    render(
      <StrictMode>
        <CompressionProvider>
          <Row paths={[]} />
        </CompressionProvider>
      </StrictMode>
    )
    await flush()
    // StrictMode double-invokes the mount effect (register → cleanup → register).
    // Final active state: exactly one handler per event name.
    const expected = [
      'file:progress',
      'file:complete',
      'file:error',
      'file:cancelled',
      'batch:complete',
      'batch:error',
    ]
    for (const name of expected) {
      expect(listeners.get(name)?.size).toBe(1)
    }
    expect(listeners.size).toBe(expected.length)
  })

  it('useCompressionContext throws outside provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Row paths={[]} />)).toThrow(
      /must be used within CompressionProvider/
    )
    spy.mockRestore()
  })

  it('provider fires batch toasts for complete and error batches', async () => {
    vi.mocked(invoke).mockResolvedValue([entry()])
    render(
      <CompressionProvider>
        <Row paths={['/t/a.jpg']} />
      </CompressionProvider>
    )
    await flush()
    await act(async () => {
      await screen.getByRole('button', { name: 'add' }).click()
    })
    emit('file:complete', {
      fileId: 'f1',
      outputPath: '/o/a.jpg',
      originalSize: 1024,
      compressedSize: 512,
      status: 'done',
      metTarget: true,
    })
    emit('batch:complete', { batchId: 'b1', totalSavedBytes: 2048 })
    expect(vi.mocked(toast.success).mock.calls[0][0]).toContain('Saved 2 KB total')
    emit('batch:error', { batchId: 'b2', errorMessage: 'Output folder not writable' })
    expect(toast.error).toHaveBeenCalledWith('Output folder not writable')
  })

  it('provider surfaces listener registration failure as batch error toast', async () => {
    vi.mocked(listen).mockRejectedValueOnce(new Error('ipc dead'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <CompressionProvider>
        <Row paths={[]} />
      </CompressionProvider>
    )
    await flush()
    expect(toast.error).toHaveBeenCalledWith('Lost connection to compression worker')
    spy.mockRestore()
  })
})
