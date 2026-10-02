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

import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { toast } from 'sonner'
import type { HistoryFilters, HistoryResponse } from '@/types'

const PAGE_SIZE = 50

const HISTORY_ERROR_TOAST = 'History could not be saved — compression was not affected.'

const toMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

export function useHistory() {
  const [response, setResponse] = useState<HistoryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFiltersState] = useState<HistoryFilters>({})
  const [page, setPageState] = useState(0)
  const [nonce, setNonce] = useState(0)

  const queryKey = JSON.stringify({ filters, page })

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await invoke<HistoryResponse>('get_history', {
          filters,
          page,
          pageSize: PAGE_SIZE,
        })
        if (cancelled) return
        setResponse(res)
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError(`Could not load history: ${toMessage(err)}`)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    setLoading(true)
    load()
    return () => {
      cancelled = true
    }
  }, [queryKey, nonce])

  useEffect(() => {
    let disposed = false
    const unlisteners: UnlistenFn[] = []
    const done = (u: UnlistenFn) => {
      if (disposed) {
        u()
      } else {
        unlisteners.push(u)
      }
    }
    const reportListenFailure = (event: string) => (err: unknown) => {
      console.error(`event listener registration failed: ${event}`, err)
    }

    listen('batch:complete', () => {
      setNonce((n) => n + 1)
    })
      .then(done)
      .catch(reportListenFailure('batch:complete'))

    listen('history:error', () => {
      toast.error(HISTORY_ERROR_TOAST)
    })
      .then(done)
      .catch((err) => {
        console.error('event listener registration failed: history:error', err)
        toast.error('History error notifications are unavailable.')
      })

    return () => {
      disposed = true
      unlisteners.forEach((u) => u())
    }
  }, [])

  const setFilters = useCallback(
    (partial: Partial<HistoryFilters>) => {
      const next = { ...filters, ...partial }
      if (JSON.stringify(filters) === JSON.stringify(next)) return
      setFiltersState(next)
      setPageState(0)
    },
    [filters]
  )

  const setPage = useCallback((next: number) => {
    setPageState(next)
  }, [])

  const refresh = useCallback(() => {
    setNonce((n) => n + 1)
  }, [])

  const clearHistory = useCallback(async () => {
    try {
      await invoke('clear_history')
      refresh()
    } catch (err) {
      console.error('clear_history failed:', err)
      toast.error('Could not clear history')
    }
  }, [refresh])

  const clearError = useCallback(() => {
    setError(null)
  }, [])

  return {
    response,
    loading,
    error,
    filters,
    setFilters,
    page,
    setPage,
    refresh,
    clearHistory,
    clearError,
  }
}
