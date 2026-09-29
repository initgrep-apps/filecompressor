import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { StrictMode } from 'react'

const listeners = new Map<string, (e: { payload: unknown }) => void>()
const unlistens: ReturnType<typeof vi.fn>[] = []

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    listeners.set(event, handler)
    const un = vi.fn()
    unlistens.push(un)
    return Promise.resolve(un)
  }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { useCompression } from '@/hooks/useCompression'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { toast } from 'sonner'
import type { FileEntry } from '@/types'

const emit = (event: string, payload: unknown) =>
  act(() => {
    listeners.get(event)?.({ payload })
  })

const flush = () => act(async () => {})

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

beforeEach(() => {
  listeners.clear()
  unlistens.length = 0
})

describe('useCompression event handling', () => {
  it('file:progress stores percent by fileId', async () => {
    const { result } = renderHook(() => useCompression([entry()], setFilesStub))
    await flush()
    emit('file:progress', { fileId: 'f1', percent: 45 })
    expect(result.current.progressByFile['f1']).toBe(45)
  })

  it('file:progress for unknown fileId is ignored', async () => {
    const { result } = renderHook(() => useCompression([entry()], setFilesStub))
    await flush()
    emit('file:progress', { fileId: 'ghost', percent: 10 })
    expect(result.current.progressByFile['ghost']).toBeUndefined()
  })

  it('file:complete applies done status, sizes, output path and clears progress entry', async () => {
    const setFiles = vi.fn()
    const { result } = renderHook(() => useCompression([entry()], setFiles))
    await flush()
    emit('file:complete', {
      fileId: 'f1',
      outputPath: '/out/a.jpg',
      originalSize: 1024,
      compressedSize: 500,
      status: 'done',
      metTarget: true,
    })
    expect(result.current.progressByFile['f1']).toBeUndefined()
    expect(setFiles).toHaveBeenCalledWith(expect.any(Function))
    const updater = setFiles.mock.calls[0][0]
    const updated = updater([entry()])
    expect(updated[0].status).toBe('done')
    expect(updated[0].compressedSize).toBe(500)
    expect(updated[0].outputPath).toBe('/out/a.jpg')
  })

  it('file:error sets failed with message', async () => {
    const setFiles = vi.fn()
    const { result } = renderHook(() => useCompression([entry()], setFiles))
    await flush()
    emit('file:error', { fileId: 'f1', errorMessage: 'Cannot read file: locked' })
    expect(result.current.progressByFile['f1']).toBeUndefined()
    const updater = setFiles.mock.calls[0][0]
    const updated = updater([entry()])
    expect(updated[0].status).toBe('failed')
    expect(updated[0].error).toBe('Cannot read file: locked')
  })

  it('file:cancelled sets cancelled status', async () => {
    const setFiles = vi.fn()
    const { result } = renderHook(() => useCompression([entry()], setFiles))
    await flush()
    emit('file:cancelled', { fileId: 'f1' })
    expect(result.current.progressByFile['f1']).toBeUndefined()
    const updater = setFiles.mock.calls[0][0]
    const updated = updater([entry({ status: 'compressing' })])
    expect(updated[0].status).toBe('cancelled')
  })

  it('batch:complete resets isCompressing and fires onBatchComplete', async () => {
    const onBatchComplete = vi.fn()
    const { result } = renderHook(() =>
      useCompression([entry()], setFilesStub, { onBatchComplete })
    )
    await flush()
    await act(() => result.current.compressAll())
    expect(result.current.isCompressing).toBe(true)
    emit('file:complete', {
      fileId: 'f1',
      outputPath: '/out/a.jpg',
      originalSize: 1024,
      compressedSize: 500,
      status: 'done',
      metTarget: true,
    })
    emit('batch:complete', { batchId: 'b1', totalSavedBytes: 1024 })
    expect(result.current.isCompressing).toBe(false)
    expect(onBatchComplete).toHaveBeenCalledWith(1024, 1)
  })

  it('batch:error resets isCompressing and fires onBatchError', async () => {
    const onBatchError = vi.fn()
    const { result } = renderHook(() =>
      useCompression([entry()], setFilesStub, { onBatchError })
    )
    await flush()
    await act(() => result.current.compressAll())
    expect(result.current.isCompressing).toBe(true)
    emit('batch:error', { batchId: 'b1', errorMessage: 'Output folder not writable' })
    expect(result.current.isCompressing).toBe(false)
    expect(onBatchError).toHaveBeenCalledWith('Output folder not writable')
  })

  it('file events for unknown fileIds leave state unchanged', async () => {
    const setFiles = vi.fn()
    renderHook(() => useCompression([entry()], setFiles))
    await flush()
    emit('file:complete', { fileId: 'ghost', outputPath: '/o', compressedSize: 1, status: 'done' })
    emit('file:error', { fileId: 'ghost', errorMessage: 'x' })
    emit('file:cancelled', { fileId: 'ghost' })
    const updater = setFiles.mock.calls[0][0]
    const updated = updater([entry()])
    expect(updated[0].status).toBe('pending')
    expect(updated[0].error).toBeNull()
  })

  it('file:progress flips pending row to compressing and leaves done rows untouched', async () => {
    const setFiles = vi.fn()
    renderHook(() => useCompression([entry()], setFiles))
    await flush()
    emit('file:progress', { fileId: 'f1', percent: 45 })
    const updater = setFiles.mock.calls[0][0]
    expect(updater([entry()])[0].status).toBe('compressing')
    expect(updater([entry({ status: 'done' })])[0].status).toBe('done')
  })

  it('ghost file events do not inflate the processed count', async () => {
    const onBatchComplete = vi.fn()
    const { result } = renderHook(() =>
      useCompression([entry()], setFilesStub, { onBatchComplete })
    )
    await flush()
    await act(() => result.current.compressAll())
    emit('file:complete', { fileId: 'ghost', outputPath: '/o', compressedSize: 1, status: 'done' })
    emit('file:complete', {
      fileId: 'f1',
      outputPath: '/o/a.jpg',
      originalSize: 10,
      compressedSize: 5,
      status: 'done',
      metTarget: true,
    })
    emit('batch:complete', { batchId: 'b1', totalSavedBytes: 5 })
    expect(onBatchComplete).toHaveBeenCalledWith(5, 1)
  })

  it('cancelled files do not count as processed and suppress the success toast', async () => {
    const onBatchComplete = vi.fn()
    const { result } = renderHook(() =>
      useCompression([entry()], setFilesStub, { onBatchComplete })
    )
    await flush()
    await act(() => result.current.compressAll())
    emit('file:cancelled', { fileId: 'f1' })
    emit('batch:complete', { batchId: 'b1', totalSavedBytes: 0 })
    expect(result.current.isCompressing).toBe(false)
    expect(onBatchComplete).not.toHaveBeenCalled()
  })

  it('processed count resets between batches', async () => {
    const onBatchComplete = vi.fn()
    const { result } = renderHook(() =>
      useCompression([entry({ id: 'f1' }), entry({ id: 'f2', name: 'b.jpg' })], setFilesStub, {
        onBatchComplete,
      })
    )
    await flush()
    await act(() => result.current.compressAll())
    emit('file:complete', {
      fileId: 'f1',
      outputPath: '/o/a.jpg',
      originalSize: 10,
      compressedSize: 5,
      status: 'done',
      metTarget: true,
    })
    emit('batch:complete', { batchId: 'b1', totalSavedBytes: 5 })
    expect(onBatchComplete).toHaveBeenLastCalledWith(5, 1)
    emit('file:complete', {
      fileId: 'f2',
      outputPath: '/o/b.jpg',
      originalSize: 10,
      compressedSize: 3,
      status: 'done',
      metTarget: true,
    })
    emit('batch:complete', { batchId: 'b2', totalSavedBytes: 7 })
    expect(onBatchComplete).toHaveBeenLastCalledWith(7, 1)
  })
})

describe('useCompression commands', () => {
  it('compress_all invokes command when pending files exist', async () => {
    const { result } = renderHook(() => useCompression([entry()], setFilesStub))
    await flush()
    await act(() => result.current.compressAll())
    expect(invoke).toHaveBeenCalledWith('compress_all')
    expect(result.current.isCompressing).toBe(true)
  })

  it('compress_all no-ops when no pending files', async () => {
    const { result } = renderHook(() => useCompression([entry({ status: 'done' })], setFilesStub))
    await flush()
    await act(() => result.current.compressAll())
    expect(invoke).not.toHaveBeenCalled()
    expect(result.current.isCompressing).toBe(false)
  })

  it('cancel_file / cancel_all / reveal_in_folder invoke with camelCase payloads', async () => {
    const { result } = renderHook(() => useCompression([entry()], setFilesStub))
    await flush()
    await act(() => result.current.cancelFile('f1'))
    expect(invoke).toHaveBeenCalledWith('cancel_file', { fileId: 'f1' })
    await act(() => result.current.cancelAll())
    expect(invoke).toHaveBeenCalledWith('cancel_all')
    await act(() => result.current.revealInFolder('/out/a.jpg'))
    expect(invoke).toHaveBeenCalledWith('reveal_in_folder', { filePath: '/out/a.jpg' })
  })

  it('compress_all resets state when backend returns empty batch id', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('')
    const onBatchError = vi.fn()
    const { result } = renderHook(() =>
      useCompression([entry()], setFilesStub, { onBatchError })
    )
    await flush()
    await act(() => result.current.compressAll())
    expect(result.current.isCompressing).toBe(false)
    expect(onBatchError).toHaveBeenCalledWith('No pending files')
  })

  it('compress_all resets state and reports when invoke rejects', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('worker dead'))
    const onBatchError = vi.fn()
    const { result } = renderHook(() =>
      useCompression([entry()], setFilesStub, { onBatchError })
    )
    await flush()
    await act(() => result.current.compressAll())
    expect(result.current.isCompressing).toBe(false)
    expect(onBatchError).toHaveBeenCalledWith('worker dead')
  })

  it('reveal failure surfaces a toast error', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('opener unavailable'))
    const { result } = renderHook(() => useCompression([entry()], setFilesStub))
    await flush()
    await act(() => result.current.revealInFolder('/out/a.jpg'))
    expect(toast.error).toHaveBeenCalledWith('Could not open folder: opener unavailable')
  })

  it('cancel_all failure surfaces a toast error', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('ipc down'))
    const { result } = renderHook(() => useCompression([entry()], setFilesStub))
    await flush()
    await act(() => result.current.cancelAll())
    expect(toast.error).toHaveBeenCalledWith('Could not cancel: ipc down')
  })
})

describe('useCompression listener lifecycle', () => {
  it('subscribes to all six events', async () => {
    renderHook(() => useCompression([entry()], setFilesStub))
    await flush()
    expect([...listeners.keys()].sort()).toEqual([
      'batch:complete',
      'batch:error',
      'file:cancelled',
      'file:complete',
      'file:error',
      'file:progress',
    ])
  })

  it('unsubscribes all listeners on unmount', async () => {
    const { unmount } = renderHook(() => useCompression([entry()], setFilesStub))
    await flush()
    expect(listeners.size).toBe(6)
    unmount()
    expect(unlistens.length).toBeGreaterThan(0)
    expect(unlistens.every((u) => u.mock.calls.length === 1)).toBe(true)
  })

  it('strict mode double-mount does not leak duplicate listeners', async () => {
    const { unmount } = renderHook(() => useCompression([entry()], setFilesStub), {
      wrapper: StrictMode,
    })
    await flush()
    unmount()
    await flush()
    expect(unlistens.length).toBeGreaterThan(0)
    expect(unlistens.every((u) => u.mock.calls.length === 1)).toBe(true)
  })

  it('listener registration failure reports batch error', async () => {
    vi.mocked(listen).mockRejectedValueOnce(new Error('bus down'))
    const onBatchError = vi.fn()
    renderHook(() => useCompression([entry()], setFilesStub, { onBatchError }))
    await flush()
    expect(onBatchError).toHaveBeenCalledWith('Lost connection to compression worker')
  })
})

function setFilesStub(value: unknown) {
  return typeof value === 'function' ? value([]) : value
}
