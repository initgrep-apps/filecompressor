import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const registry = new Map<string, Set<(e: { payload: unknown }) => void>>()
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
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
})
