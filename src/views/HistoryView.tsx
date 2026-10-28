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

import { invoke } from "@tauri-apps/api/core"
import { toast } from "sonner"
import { FolderOpen, History } from "lucide-react"
import type { HistorySession } from "@/types"
import { activeFilterCount } from "@/lib/historyFormat"
import { completedLabel, formatPreciseDuration, historyOutcomeCounts } from "@/lib/historyTable"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { HistoryFilesTable } from "@/components/history/HistoryFilesTable"
import { HistorySummaryCards } from "@/components/history/HistorySummaryCards"
import { useHistoryContext } from "@/providers/HistoryProvider"

function toastOpenError(err: unknown, prefix: string) {
  const message = String(err)
  const alreadyLabeled = /^Could not (reveal file|open folder)/.test(message)
  toast.error(alreadyLabeled ? message : `${prefix}: ${message}`)
}

async function openSessionFolder(path: string) {
  try {
    await invoke("open_folder", { path })
  } catch (err) {
    console.error("open_folder failed:", err)
    toastOpenError(err, "Could not open folder")
  }
}

function BatchTitle({ session }: { session: HistorySession }) {
  const counts = historyOutcomeCounts(session.files)
  const duration =
    session.endedAt !== null
      ? formatPreciseDuration(session.endedAt - session.startedAt)
      : "—"
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="truncate text-[16px] font-semibold tracking-[-0.015em]">
          {completedLabel(session.startedAt)}
        </span>
        {counts.attention > 0 && (
          <Badge
            variant="secondary"
            className="h-[18px] gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-[7px] text-[10px] font-semibold text-amber-600"
          >
            <span aria-hidden="true" className="size-1 rounded-full bg-amber-500" />
            Needs attention
          </Badge>
        )}
        {session.cancelled && (
          <Badge variant="secondary" className="h-[18px] text-[10px]">
            Cancelled
          </Badge>
        )}
        {session.interrupted && (
          <Badge variant="secondary" className="h-[18px] text-[10px]">
            Interrupted
          </Badge>
        )}
      </div>
      <div className="mt-[3px] truncate text-[10px] text-muted-foreground">
        Completed in {duration}
      </div>
    </div>
  )
}

export function HistoryView() {
  const {
    response,
    loading,
    error,
    filters,
    setFilters,
    selectedSessionId,
    clearError,
    refresh,
  } = useHistoryContext()

  const sessions = response?.sessions ?? []
  const session =
    sessions.find((item) => item.sessionId === selectedSessionId) ?? null
  const initialLoading = loading && response === null
  const refreshing = loading && response !== null
  const filteredEmpty = sessions.length === 0 && activeFilterCount(filters) > 0
  const unreadable =
    response !== null &&
    response.totalSessions === 0 &&
    activeFilterCount(filters) === 0 &&
    response.skippedLines > 0
  const showSession = session !== null && error === null

  const clearFilters = () =>
    setFilters({
      search: undefined,
      statuses: undefined,
      categories: undefined,
      sinceMs: undefined,
      outputFolder: undefined,
      sort: undefined,
    })

  return (
    <TooltipProvider>
      <div
        data-testid="history-content"
        aria-busy={refreshing}
        className={`@container flex min-h-0 flex-1 flex-col gap-3.5 p-6${
          refreshing ? " opacity-60" : ""
        }`}
      >
        {showSession && (
          <>
            <div className="flex items-start justify-between gap-3.5">
              <BatchTitle session={session} />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-label="Reveal folder"
                      onClick={() => void openSessionFolder(session.outputFolder)}
                    />
                  }
                >
                  <FolderOpen />
                </TooltipTrigger>
                <TooltipContent>Reveal folder</TooltipContent>
              </Tooltip>
            </div>
            <HistorySummaryCards session={session} />
          </>
        )}

        {response !== null && response.skippedLines > 0 && error === null && (
          <p className="text-xs text-muted-foreground">
            Some history entries could not be read ({response.skippedLines}).
          </p>
        )}

        {error !== null ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <span className="min-w-0">{error}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                clearError()
                refresh()
              }}
            >
              Retry
            </Button>
          </div>
        ) : initialLoading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-20 w-full" />
            ))}
          </div>
        ) : session === null ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <History />
              </EmptyMedia>
              <EmptyTitle>
                {unreadable
                  ? "History could not be read"
                  : filteredEmpty
                    ? "No batches match these filters."
                    : sessions.length === 0
                      ? "No history yet"
                      : "No batch selected"}
              </EmptyTitle>
              <EmptyDescription>
                {unreadable
                  ? `${response?.skippedLines ?? 0} ${
                      (response?.skippedLines ?? 0) === 1 ? "line" : "lines"
                    } could not be read.`
                  : filteredEmpty
                    ? "Clear filters to see the full history."
                    : sessions.length === 0
                      ? "Compressed files and their results will appear here."
                      : "Choose a batch from the sidebar."}
              </EmptyDescription>
            </EmptyHeader>
            {filteredEmpty && (
              <Button variant="outline" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </Empty>
        ) : session.files.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {session.cancelled
              ? "No files finished before this batch was cancelled."
              : session.interrupted
                ? "No files finished before this batch was interrupted."
                : "No files in this batch."}
          </p>
        ) : (
          <HistoryFilesTable key={session.sessionId} session={session} />
        )}
      </div>
    </TooltipProvider>
  )
}
