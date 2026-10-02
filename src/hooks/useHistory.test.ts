import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const registry = new Map<string, Set<(e: { payload: unknown }) => void>>()
let failListenEvent: string | null = null
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    if (event === failListenEvent) {
      return Promise.reject(new Error('listener bus down'))
    }
    if (!registry.has(event)) registry.set(event, new Set())
    registry.get(event)!.add(handler)
    return Promise.resolve(vi.fn(() => registry.get(event)?.delete(handler)))
  }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { useHistory } from '@/hooks/useHistory'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'

const emptyResponse = {
  sessions: [], page: 0, pageSize: 50, totalSessions: 0, totalFiles: 0,
  summary: { sessions: 0, files: 0, savedBytes: 0, failedFiles: 0 },
  outputFolders: [], skippedLines: 0,
}

const emit = (event: string, payload: unknown) =>
  act(() => { registry.get(event)?.forEach((h) => h({ payload })) })

beforeEach(() => {
  vi.clearAllMocks()
  registry.clear()
  failListenEvent = null
})

describe('useHistory', () => {
  it('loads on mount', async () => {
    vi.mocked(invoke).mockResolvedValue(emptyResponse)
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(invoke).toHaveBeenCalledWith('get_history', {
      filters: {}, page: 0, pageSize: 50,
    })
    expect(result.current.response?.totalSessions).toBe(0)
  })

  it('setFilters merges and resets page', async () => {
    vi.mocked(invoke).mockResolvedValue(emptyResponse)
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setPage(2))
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('get_history', expect.objectContaining({ page: 2 })))
    act(() => result.current.setFilters({ search: 'abc' }))
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('get_history', expect.objectContaining({ page: 0, filters: { search: 'abc' } })))
  })

  it('refetches on batch:complete', async () => {
    vi.mocked(invoke).mockResolvedValue(emptyResponse)
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const calls = vi.mocked(invoke).mock.calls.length
    emit('batch:complete', { batchId: 'b', totalSavedBytes: 0 })
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.length).toBeGreaterThan(calls))
  })

  it('toasts on history:error', async () => {
    vi.mocked(invoke).mockResolvedValue(emptyResponse)
    renderHook(() => useHistory())
    await waitFor(() => expect(registry.get('history:error')?.size).toBe(1))
    emit('history:error', { message: 'disk full' })
    expect(toast.error).toHaveBeenCalledWith('History could not be saved — compression was not affected.')
  })

  it('surfaces load errors and clearHistory refetches', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(emptyResponse)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ ...emptyResponse, skippedLines: 2 })
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => { await result.current.clearHistory() })
    expect(invoke).toHaveBeenCalledWith('clear_history')
    await waitFor(() => expect(result.current.response?.skippedLines).toBe(2))
  })

  it('setFilters unchanged keeps identity', async () => {
    vi.mocked(invoke).mockResolvedValue(emptyResponse)
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const calls = vi.mocked(invoke).mock.calls.length
    act(() => result.current.setFilters({ search: 'abc' }))
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.length).toBe(calls + 1))
    act(() => result.current.setFilters({ search: 'abc' }))
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.length).toBe(calls + 1))
    expect(result.current.filters).toEqual({ search: 'abc' })
    act(() => result.current.setPage(2))
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('get_history', expect.objectContaining({ page: 2 })))
    const callsAtPage2 = vi.mocked(invoke).mock.calls.length
    act(() => result.current.setFilters({}))
    expect(result.current.page).toBe(2)
    expect(result.current.filters).toEqual({ search: 'abc' })
    expect(vi.mocked(invoke).mock.calls.length).toBe(callsAtPage2)
  })

  it('load rejection sets error', async () => {
    vi.mocked(invoke).mockRejectedValue('disk error')
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.error).toContain('Could not load history'))
    expect(result.current.loading).toBe(false)
    expect(result.current.response).toBeNull()
  })

  it('clearHistory failure toasts and keeps response', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(emptyResponse)
      .mockRejectedValueOnce('locked')
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const responseBefore = result.current.response
    await act(async () => { await result.current.clearHistory() })
    expect(toast.error).toHaveBeenCalledWith('Could not clear history')
    expect(result.current.response).toBe(responseBefore)
  })

  it('clearError resets error', async () => {
    vi.mocked(invoke).mockRejectedValueOnce('disk error')
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.error).not.toBeNull())
    act(() => result.current.clearError())
    expect(result.current.error).toBeNull()
  })

  it('manual refresh refetches', async () => {
    vi.mocked(invoke).mockResolvedValue(emptyResponse)
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const calls = vi.mocked(invoke).mock.calls.length
    act(() => result.current.refresh())
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.length).toBe(calls + 1))
  })

  it('unlisten on unmount', async () => {
    vi.mocked(invoke).mockResolvedValue(emptyResponse)
    const { unmount } = renderHook(() => useHistory())
    await waitFor(() => expect(registry.get('batch:complete')?.size).toBe(1))
    expect(registry.get('history:error')?.size).toBe(1)
    unmount()
    expect(registry.get('batch:complete')?.size).toBe(0)
    expect(registry.get('history:error')?.size).toBe(0)
  })

  it('stale response ignored', async () => {
    let resolveStale: (value: unknown) => void = () => {}
    let rejectStale: (err: unknown) => void = () => {}
    vi.mocked(invoke)
      .mockResolvedValueOnce(emptyResponse)
      .mockImplementationOnce(
        () =>
          new Promise((res, rej) => {
            resolveStale = res
            rejectStale = rej
          })
      )
      .mockResolvedValueOnce({ ...emptyResponse, page: 2, totalSessions: 5 })
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setPage(1))
    act(() => result.current.setPage(2))
    await waitFor(() => expect(result.current.response?.totalSessions).toBe(5))
    await act(async () => {
      resolveStale({ ...emptyResponse, page: 1, totalSessions: 99 })
    })
    expect(result.current.response?.totalSessions).toBe(5)
    expect(result.current.error).toBeNull()
    await act(async () => {
      rejectStale(new Error('stale disk error'))
    })
    expect(result.current.response?.totalSessions).toBe(5)
    expect(result.current.error).toBeNull()
  })

  it('setFilters merge accumulation', async () => {
    vi.mocked(invoke).mockResolvedValue(emptyResponse)
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setFilters({ statuses: ['done'] }))
    await waitFor(() => expect(result.current.filters).toEqual({ statuses: ['done'] }))
    act(() => result.current.setFilters({ search: 'abc' }))
    await waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith(
        'get_history',
        expect.objectContaining({
          page: 0,
          filters: { statuses: ['done'], search: 'abc' },
        })
      )
    )
  })

  it('error clears on successful reload', async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce('disk error')
      .mockResolvedValueOnce({ ...emptyResponse, totalSessions: 3 })
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.error).toContain('Could not load history'))
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.response?.totalSessions).toBe(3))
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('listener registration failure degrades gracefully', async () => {
    vi.mocked(invoke).mockResolvedValue(emptyResponse)
    failListenEvent = 'history:error'
    const { result } = renderHook(() => useHistory())
    failListenEvent = null
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.response?.totalSessions).toBe(0)
    expect(result.current.error).toBeNull()
    expect(toast.error).toHaveBeenCalledWith('History error notifications are unavailable.')
    expect(registry.get('history:error')?.size ?? 0).toBe(0)
  })
})
