// Yard — offline batch file compression
// Copyright (C) 2026 Yard Contributors
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

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useHistory } from '@/hooks/useHistory'
import type { HistoryFilters, HistoryResponse } from '@/types'

export type HistoryContextValue = {
  response: HistoryResponse | null
  loading: boolean
  error: string | null
  filters: HistoryFilters
  setFilters: (partial: Partial<HistoryFilters>) => void
  page: number
  setPage: (page: number) => void
  searchText: string
  setSearchText: (text: string) => void
  selectedSessionId: string | null
  selectSession: (id: string) => void
  expanded: boolean
  setExpanded: (open: boolean) => void
  refresh: () => void
  clearHistory: () => Promise<void>
  clearError: () => void
}

export const HistoryContext = createContext<HistoryContextValue | null>(null)

const searchToFilter = (text: string): string | undefined => text.trim() || undefined

export function HistoryProvider({ children }: { children: ReactNode }) {
  const history = useHistory()
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)
  const [searchText, setSearchText] = useState('')

  useEffect(() => {
    const sessions = history.response?.sessions
    if (!sessions) return
    setSelectedSessionId((current) => {
      if (current !== null && sessions.some((session) => session.sessionId === current)) {
        return current
      }
      return sessions[0]?.sessionId ?? null
    })
  }, [history.response])

  const setFiltersRef = useRef(history.setFilters)

  useEffect(() => {
    setFiltersRef.current = history.setFilters
  }, [history.setFilters])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFiltersRef.current({ search: searchToFilter(searchText) })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [searchText])

  const selectSession = useCallback((id: string) => setSelectedSessionId(id), [])

  const value: HistoryContextValue = {
    response: history.response,
    loading: history.loading,
    error: history.error,
    filters: history.filters,
    setFilters: history.setFilters,
    page: history.page,
    setPage: history.setPage,
    searchText,
    setSearchText,
    selectedSessionId,
    selectSession,
    expanded,
    setExpanded,
    refresh: history.refresh,
    clearHistory: history.clearHistory,
    clearError: history.clearError,
  }

  return <HistoryContext.Provider value={value}>{children}</HistoryContext.Provider>
}

export function useHistoryContext(): HistoryContextValue {
  const ctx = useContext(HistoryContext)
  if (!ctx) {
    throw new Error('useHistoryContext must be used within HistoryProvider')
  }
  return ctx
}
