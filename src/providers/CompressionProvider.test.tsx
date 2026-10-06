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
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

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
    strategyUsed: null,
    qualityUsed: null,
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

function RunConsumer({ paths }: { paths: string[] }) {
  const {
    files,
    runScreen,
    batchNumber,
    roster,
    batchError,
    batchCancelled,
    addFiles,
    startRun,
    endRun,
  } = useCompressionContext()
  return (
    <div>
      <button type="button" onClick={() => addFiles(paths)}>
        add
      </button>
      <button type="button" onClick={startRun}>
        start run
      </button>
      <button type="button" onClick={endRun}>
        end run
      </button>
      <p data-testid="run-state">{runScreen}</p>
      <p data-testid="batch-number">{batchNumber}</p>
      <p data-testid="roster">{roster.join(',')}</p>
      <p data-testid="batch-error">{batchError ?? ''}</p>
      <p data-testid="batch-cancelled">{String(batchCancelled)}</p>
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

  it('startRun captures pending roster and increments batch number', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      entry({ id: 'done-f', name: 'done.jpg', status: 'done', compressedSize: 10, outputPath: '/o/done.jpg' }),
      entry({
        id: 'uns-f',
        name: 'uns.jpg',
        category: 'other',
        originalSize: 0,
        targetBytes: 0,
        status: 'unsupported',
      }),
      entry({ id: 'p1', name: 'p1.jpg' }),
      entry({ id: 'p2', name: 'p2.jpg', path: '/t/p2.jpg' }),
    ])
    render(
      <CompressionProvider>
        <RunConsumer paths={['/t/p1.jpg']} />
      </CompressionProvider>
    )
    await flush()
    await act(async () => {
      await screen.getByRole('button', { name: 'add' }).click()
    })
    expect(screen.getByTestId('run-state')).toHaveTextContent('staging')
    await act(() => {
      screen.getByRole('button', { name: 'start run' }).click()
    })
    expect(screen.getByTestId('run-state')).toHaveTextContent('run')
    expect(screen.getByTestId('batch-number')).toHaveTextContent('1')
    expect(screen.getByTestId('roster')).toHaveTextContent('p1,p2')
  })

  it('endRun returns to staging and keeps the batch counter', async () => {
    vi.mocked(invoke).mockResolvedValue([entry()])
    render(
      <CompressionProvider>
        <RunConsumer paths={['/t/a.jpg']} />
      </CompressionProvider>
    )
    await flush()
    await act(async () => {
      await screen.getByRole('button', { name: 'add' }).click()
    })
    await act(() => {
      screen.getByRole('button', { name: 'start run' }).click()
    })
    expect(screen.getByTestId('run-state')).toHaveTextContent('run')
    await act(() => {
      screen.getByRole('button', { name: 'end run' }).click()
    })
    expect(screen.getByTestId('run-state')).toHaveTextContent('staging')
    expect(screen.getByTestId('batch-number')).toHaveTextContent('1')
  })

  it('run screen survives view switch (remount of a fresh consumer within the same provider)', async () => {
    vi.mocked(invoke).mockResolvedValue([entry()])
    const { rerender } = render(
      <CompressionProvider>
        <RunConsumer paths={['/t/a.jpg']} />
      </CompressionProvider>
    )
    await flush()
    await act(async () => {
      await screen.getByRole('button', { name: 'add' }).click()
    })
    await act(() => {
      screen.getByRole('button', { name: 'start run' }).click()
    })
    expect(screen.getByTestId('run-state')).toHaveTextContent('run')
    rerender(<CompressionProvider>{null}</CompressionProvider>)
    rerender(
      <CompressionProvider>
        <RunConsumer paths={['/t/a.jpg']} />
      </CompressionProvider>
    )
    expect(screen.getByTestId('run-state')).toHaveTextContent('run')
    expect(screen.getByTestId('roster')).toHaveTextContent('f1')
    expect(screen.getByTestId('batch-number')).toHaveTextContent('1')
  })

  it('startRun keeps the batch error until a terminal event clears it and second startRun increments the counter', async () => {
    vi.mocked(invoke).mockResolvedValue([entry()])
    render(
      <CompressionProvider>
        <RunConsumer paths={['/t/a.jpg']} />
      </CompressionProvider>
    )
    await flush()
    await act(async () => {
      await screen.getByRole('button', { name: 'add' }).click()
    })
    emit('batch:error', { batchId: 'b0', errorMessage: 'worker gone' })
    expect(screen.getByTestId('batch-error')).toHaveTextContent('worker gone')
    await act(() => {
      screen.getByRole('button', { name: 'start run' }).click()
    })
    expect(screen.getByTestId('batch-error')).toHaveTextContent('worker gone')
    emit('file:complete', {
      fileId: 'f1',
      outputPath: '/o/a.jpg',
      originalSize: 10,
      compressedSize: 5,
      status: 'done',
      metTarget: true,
    })
    emit('batch:complete', { batchId: 'b1', totalSavedBytes: 0 })
    expect(screen.getByTestId('batch-error')).not.toHaveTextContent('worker gone')
    await act(() => {
      screen.getByRole('button', { name: 'end run' }).click()
    })
    // startRun no-ops with zero pending files, so the second run needs a fresh pending row.
    await act(async () => {
      await screen.getByRole('button', { name: 'add' }).click()
    })
    await act(() => {
      screen.getByRole('button', { name: 'start run' }).click()
    })
    expect(screen.getByTestId('batch-number')).toHaveTextContent('2')
  })

  it('provider sets batchCancelled on cancelled terminal and clears it on startRun', async () => {
    vi.mocked(invoke).mockResolvedValue([entry()])
    render(
      <CompressionProvider>
        <RunConsumer paths={['/t/a.jpg']} />
      </CompressionProvider>
    )
    await flush()
    await act(async () => {
      await screen.getByRole('button', { name: 'add' }).click()
    })
    expect(screen.getByTestId('batch-cancelled')).toHaveTextContent('false')
    await act(() => {
      screen.getByRole('button', { name: 'start run' }).click()
    })
    emit('batch:complete', { batchId: 'b1', totalSavedBytes: 0, cancelled: true })
    expect(screen.getByTestId('batch-cancelled')).toHaveTextContent('true')
    await act(() => {
      screen.getByRole('button', { name: 'start run' }).click()
    })
    expect(screen.getByTestId('batch-cancelled')).toHaveTextContent('false')
    emit('file:complete', {
      fileId: 'f1',
      outputPath: '/o/a.jpg',
      originalSize: 10,
      compressedSize: 5,
      status: 'done',
      metTarget: true,
    })
    emit('batch:complete', { batchId: 'b2', totalSavedBytes: 5 })
    expect(screen.getByTestId('batch-cancelled')).toHaveTextContent('false')
  })

  it('startRun no-ops when there are no pending files', async () => {
    vi.mocked(invoke).mockResolvedValue([
      entry({ status: 'done', compressedSize: 10, outputPath: '/o/a.jpg' }),
    ])
    render(
      <CompressionProvider>
        <RunConsumer paths={['/t/a.jpg']} />
      </CompressionProvider>
    )
    await flush()
    await act(async () => {
      await screen.getByRole('button', { name: 'add' }).click()
    })
    await act(() => {
      screen.getByRole('button', { name: 'start run' }).click()
    })
    expect(screen.getByTestId('run-state')).toHaveTextContent('staging')
    expect(screen.getByTestId('batch-number')).toHaveTextContent('0')
    expect(invoke).not.toHaveBeenCalledWith('compress_all')
  })

  it('startRun while a run is in flight does not start a second batch', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([entry()])
    render(
      <CompressionProvider>
        <RunConsumer paths={['/t/a.jpg']} />
      </CompressionProvider>
    )
    await flush()
    await act(async () => {
      await screen.getByRole('button', { name: 'add' }).click()
    })
    vi.mocked(invoke).mockImplementationOnce(() => new Promise(() => {}))
    await act(() => {
      screen.getByRole('button', { name: 'start run' }).click()
    })
    expect(screen.getByTestId('run-state')).toHaveTextContent('run')
    expect(screen.getByTestId('batch-number')).toHaveTextContent('1')
    await act(() => {
      screen.getByRole('button', { name: 'start run' }).click()
    })
    expect(screen.getByTestId('run-state')).toHaveTextContent('run')
    expect(screen.getByTestId('batch-number')).toHaveTextContent('1')
    expect(screen.getByTestId('roster')).toHaveTextContent('f1')
    const compressCalls = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'compress_all')
    expect(compressCalls).toHaveLength(1)
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
