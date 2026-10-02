// File Size Optimizer — offline batch file compression
// Copyright (C) 2026 File Size Optimizer Contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const registry = new Map<string, Set<(e: { payload: unknown }) => void>>()
let failListenEvent: string | null = null
let holdListen = false
let heldResolves: Array<(u: unknown) => void> = []
let heldRejects: Array<(err: unknown) => void> = []
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    if (event === failListenEvent) {
      return Promise.reject(new Error('listener bus down'))
    }
    if (!registry.has(event)) registry.set(event, new Set())
    registry.get(event)!.add(handler)
    const unlisten = vi.fn(() => registry.get(event)?.delete(handler))
    if (holdListen) {
      return new Promise((resolve, reject) => {
        heldResolves.push(() => resolve(unlisten))
        heldRejects.push(reject)
      })
    }
    return Promise.resolve(unlisten)
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
  holdListen = false
  heldResolves = []
  heldRejects = []
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
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    emit('history:error', { message: 'disk full' })
    expect(toast.error).toHaveBeenCalledWith('History could not be saved — compression was not affected.')
    expect(result.current.error).toBeNull()
    expect(result.current.response?.totalSessions).toBe(emptyResponse.totalSessions)
  })

  it('clearHistory refetches and updates response', async () => {
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
    const callsBeforePage = vi.mocked(invoke).mock.calls.length
    vi.mocked(invoke).mockResolvedValueOnce({ ...emptyResponse, page: 2 })
    act(() => result.current.setPage(2))
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('get_history', expect.objectContaining({ page: 2 })))
    expect(vi.mocked(invoke).mock.calls.length).toBe(callsBeforePage + 1)
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
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(invoke)
      .mockResolvedValueOnce(emptyResponse)
      .mockRejectedValueOnce('locked')
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const responseBefore = result.current.response
    await act(async () => { await result.current.clearHistory() })
    expect(invoke).toHaveBeenCalledWith('clear_history')
    expect(console.error).toHaveBeenCalledWith('clear_history failed:', 'locked')
    expect(toast.error).toHaveBeenCalledWith('Could not clear history')
    expect(result.current.response).toBe(responseBefore)
    errSpy.mockRestore()
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

  it('response retained during refetch', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ ...emptyResponse, totalSessions: 3 })
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let resolver: (value: unknown) => void = () => {}
    vi.mocked(invoke).mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolver = res
        })
    )
    act(() => result.current.refresh())
    expect(result.current.loading).toBe(true)
    expect(result.current.response?.totalSessions).toBe(3)
    await act(async () => {
      resolver({ ...emptyResponse, totalSessions: 7 })
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.response?.totalSessions).toBe(7)
    expect(result.current.error).toBeNull()
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

  it('unmount before listen resolves unregisters handlers', async () => {
    vi.mocked(invoke).mockResolvedValue(emptyResponse)
    holdListen = true
    const { unmount } = renderHook(() => useHistory())
    expect(registry.get('batch:complete')?.size).toBe(1)
    expect(registry.get('history:error')?.size).toBe(1)
    unmount()
    heldResolves.forEach((resolve) => resolve(undefined))
    await act(async () => {})
    expect(registry.get('batch:complete')?.size ?? 0).toBe(0)
    expect(registry.get('history:error')?.size ?? 0).toBe(0)
  })

  it('stale response ignored', async () => {
    let resolveStale: (value: unknown) => void = () => {}
    vi.mocked(invoke)
      .mockResolvedValueOnce(emptyResponse)
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveStale = res
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
    expect(result.current.response?.page).toBe(2)
    expect(result.current.error).toBeNull()
  })

  it('stale rejection ignored after newer resolves', async () => {
    let rejectStale: (err: unknown) => void = () => {}
    vi.mocked(invoke)
      .mockResolvedValueOnce(emptyResponse)
      .mockImplementationOnce(
        () =>
          new Promise((_res, rej) => {
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
      rejectStale(new Error('stale'))
    })
    expect(result.current.response?.totalSessions).toBe(5)
    expect(result.current.response?.page).toBe(2)
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('malformed response page leaves page untouched', async () => {
    vi.mocked(invoke).mockResolvedValue({
      ...emptyResponse,
      page: 'bad' as unknown as number,
      totalSessions: 5,
    })
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.response?.totalSessions).toBe(5)
    await act(async () => {})
    expect(vi.mocked(invoke).mock.calls.length).toBe(1)
    expect(result.current.page).toBe(0)
    expect(result.current.error).toBeNull()
  })

  it('page syncs when backend clamps response', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(emptyResponse)
      .mockResolvedValue({ ...emptyResponse, page: 0, totalSessions: 40 })
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const callsBefore = vi.mocked(invoke).mock.calls.length
    act(() => result.current.setPage(2))
    await waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith(
        'get_history',
        expect.objectContaining({ page: 2 })
      )
    )
    await waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith(
        'get_history',
        expect.objectContaining({ page: 0 })
      )
    )
    expect(vi.mocked(invoke).mock.calls.length).toBe(callsBefore + 2)
    expect(result.current.page).toBe(0)
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

  it('batch:complete listener failure stays log-only', async () => {
    vi.mocked(invoke).mockResolvedValue(emptyResponse)
    failListenEvent = 'batch:complete'
    const { result } = renderHook(() => useHistory())
    failListenEvent = null
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.response?.totalSessions).toBe(0)
    expect(result.current.error).toBeNull()
    expect(toast.error).not.toHaveBeenCalled()
    expect(registry.get('batch:complete')?.size ?? 0).toBe(0)
    const calls = vi.mocked(invoke).mock.calls.length
    emit('batch:complete', { batchId: 'b', totalSavedBytes: 0 })
    expect(vi.mocked(invoke).mock.calls.length).toBe(calls)
  })

  it('listener rejection after unmount stays silent', async () => {
    const errSpy = vi.spyOn(console, 'error')
    vi.mocked(invoke).mockResolvedValue(emptyResponse)
    holdListen = true
    const { unmount } = renderHook(() => useHistory())
    expect(registry.get('batch:complete')?.size).toBe(1)
    expect(registry.get('history:error')?.size).toBe(1)
    unmount()
    heldRejects.forEach((reject) => reject(new Error('late bus failure')))
    await act(async () => {})
    expect(toast.error).not.toHaveBeenCalled()
    expect(errSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })
})
