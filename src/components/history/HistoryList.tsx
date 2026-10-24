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
import {
  SidebarInput,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  batchLabel,
  fileCountLabel,
  savedLabel,
  savedPercent,
} from "@/lib/historyFormat"
import { useHistoryContext } from "@/providers/HistoryProvider"
import type { HistorySession } from "@/types"

export const HISTORY_LIST_ID = "history-batch-list"

const sessionPercent = (session: HistorySession): number | null => {
  const original = session.files.reduce((sum, file) => sum + file.originalSize, 0)
  const compressed = session.files.reduce(
    (sum, file) => sum + (file.compressedSize ?? 0),
    0,
  )
  return savedPercent(original, compressed)
}

const sessionMeta = (session: HistorySession): string =>
  `${fileCountLabel(session.fileCount)} · ${savedLabel(session.totalSavedBytes)} saved`

const sessionRightLabel = (session: HistorySession): string => {
  if (session.cancelled) return "cancelled"
  const percent = sessionPercent(session)
  return percent === null ? "—" : `−${percent}%`
}

export function HistoryList() {
  const {
    response,
    error,
    searchText,
    setSearchText,
    page,
    setPage,
    selectedSessionId,
    selectSession,
  } = useHistoryContext()
  const { isMobile, setOpenMobile } = useSidebar()

  const now = new Date()
  const sessions = response?.sessions ?? []
  const totalPages = response
    ? Math.max(1, Math.ceil(response.totalSessions / Math.max(1, response.pageSize)))
    : 1

  const openSession = (sessionId: string) => {
    selectSession(sessionId)
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
        >
          {error !== null ? (
            <li className="px-2 py-1.5 text-xs text-muted-foreground">
              {error}
            </li>
          ) : response !== null && sessions.length === 0 ? (
            <li className="px-2 py-1.5 text-xs text-muted-foreground">
              No batches yet.
            </li>
          ) : (
            sessions.map((session) => (
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
                      {sessionMeta(session)}
                    </span>
                  </span>
                  <span
                    className={
                      session.cancelled
                        ? "ml-auto text-xs text-destructive tabular-nums"
                        : "ml-auto text-xs text-muted-foreground tabular-nums"
                    }
                  >
                    {sessionRightLabel(session)}
                  </span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))
          )}
        </SidebarMenuSub>
      </ScrollArea>
      <div className="flex items-center justify-between px-3 pb-1">
        <span className="text-xs text-muted-foreground tabular-nums">
          Page {page + 1} of {totalPages}
        </span>
        <div className="flex gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Previous page"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            <RiArrowLeftSLine />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Next page"
            disabled={page + 1 >= totalPages}
            onClick={() => setPage(page + 1)}
          >
            <RiArrowRightSLine />
          </Button>
        </div>
      </div>
    </>
  )
}
