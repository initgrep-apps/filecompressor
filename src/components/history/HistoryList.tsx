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

import { RiArrowLeftSLine, RiArrowRightSLine } from "@remixicon/react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import {
  SidebarInput,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  activeFilterCount,
  batchLabel,
  fileCountLabel,
  savedLabel,
  sessionSummary,
} from "@/lib/historyFormat"
import { useHistoryContext } from "@/providers/HistoryProvider"
import type { HistorySession } from "@/types"

export const HISTORY_LIST_ID = "history-batch-list"

const sessionRow = (session: HistorySession) => {
  const summary = sessionSummary(session)
  const percent =
    summary.percent === null
      ? "—"
      : summary.percent === 0
        ? "0%"
        : `−${summary.percent}%`
  return {
    meta: `${fileCountLabel(summary.fileCount)} · ${savedLabel(summary.savedBytes)} saved`,
    right: session.interrupted
      ? "interrupted"
      : session.cancelled
        ? "cancelled"
        : percent,
  }
}

interface HistoryListProps {
  onOpenHistory: () => void
}

export function HistoryList({ onOpenHistory }: HistoryListProps) {
  const {
    response,
    loading,
    error,
    filters,
    searchText,
    setSearchText,
    page,
    setPage,
    selectedSessionId,
    selectSession,
    clearError,
    refresh,
  } = useHistoryContext()
  const { isMobile, setOpenMobile } = useSidebar()

  const now = new Date()
  const sessions = response?.sessions ?? []
  const totalPages = response
    ? Math.max(1, Math.ceil(response.totalSessions / Math.max(1, response.pageSize)))
    : 1
  const initialLoading = loading && response === null
  const filteredEmpty =
    response !== null &&
    sessions.length === 0 &&
    activeFilterCount(filters) > 0

  const openSession = (sessionId: string) => {
    selectSession(sessionId)
    onOpenHistory()
    if (isMobile) setOpenMobile(false)
  }

  return (
    <>
      <div className="px-2">
        <SidebarInput
          aria-label="Search history"
          placeholder="Search history"
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <SidebarMenuSub
          id={HISTORY_LIST_ID}
          role="group"
          aria-label="Batches"
          aria-busy={loading}
          className={loading && response !== null ? "opacity-60" : undefined}
        >
          {error !== null ? (
            <li
              role="alert"
              className="flex items-start gap-2 px-2 py-1.5 text-xs text-muted-foreground"
            >
              <span className="min-w-0 flex-1">{error}</span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  clearError()
                  refresh()
                }}
              >
                Retry
              </Button>
            </li>
          ) : initialLoading ? (
            Array.from({ length: 3 }, (_, index) => (
              <SidebarMenuSubItem
                key={`skeleton-${index}`}
                data-testid="batch-skeleton"
                aria-hidden
              >
                <div className="flex flex-col gap-1.5 px-3 py-1.5">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-2.5 w-1/2" />
                </div>
              </SidebarMenuSubItem>
            ))
          ) : filteredEmpty ? (
            <li className="px-2 py-1.5 text-xs text-muted-foreground">
              No batches match these filters.
            </li>
          ) : response !== null && sessions.length === 0 ? (
            <li className="px-2 py-1.5 text-xs text-muted-foreground">
              No batches yet.
            </li>
          ) : (
            sessions.map((session) => {
              const row = sessionRow(session)
              return (
                <SidebarMenuSubItem key={session.sessionId}>
                  <SidebarMenuSubButton
                    render={<button type="button" />}
                    isActive={selectedSessionId === session.sessionId}
                    className="h-auto items-start py-1.5"
                    data-testid={`batch-${session.sessionId}`}
                    onClick={() => openSession(session.sessionId)}
                  >
                    <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                      <span className="w-full truncate text-left">
                        {batchLabel(session.startedAt, now)}
                      </span>
                      <span className="w-full truncate text-left text-xs text-muted-foreground">
                        {row.meta}
                      </span>
                    </span>
                    <span
                      className={
                        session.cancelled || session.interrupted
                          ? "ml-auto text-xs text-destructive tabular-nums"
                          : "ml-auto text-xs text-muted-foreground tabular-nums"
                      }
                    >
                      {row.right}
                    </span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              )
            })
          )}
        </SidebarMenuSub>
      </ScrollArea>
      <div className="flex items-center justify-between px-3 pb-1">
        <span className="text-xs text-muted-foreground tabular-nums">
          {response !== null && error === null
            ? `Page ${response.page + 1} of ${totalPages}`
            : null}
        </span>
        <div className="flex gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Previous page"
            disabled={loading || error !== null || page === 0}
            onClick={() => setPage(page - 1)}
          >
            <RiArrowLeftSLine />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Next page"
            disabled={loading || error !== null || page + 1 >= totalPages}
            onClick={() => setPage(page + 1)}
          >
            <RiArrowRightSLine />
          </Button>
        </div>
      </div>
    </>
  )
}
