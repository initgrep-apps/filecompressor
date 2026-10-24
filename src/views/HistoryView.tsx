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

import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import {
  RiFolder3Line,
  RiFolderOpenLine,
  RiHistoryLine,
} from '@remixicon/react'
import type { Category, FileStatus, HistoryFile, HistorySession } from '@/types'
import {
  activeFilterCount,
  batchLabel,
  countOutcome,
  fileCountLabel,
  formatDuration,
  savedLabel,
  savedPercent,
  sessionSummary,
} from '@/lib/historyFormat'
import { CATEGORY_TONES, STATUS_TONES } from '@/lib/tokens'
import { formatSize } from '@/lib/sizeFormat'
import { CategoryIcon } from '@/components/CategoryIcon'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { useHistoryContext } from '@/providers/HistoryProvider'

const STATUS_LABELS: Record<FileStatus, string> = {
  pending: 'Pending',
  compressing: 'Compressing',
  done: 'Done',
  best_effort: 'Best effort',
  failed: 'Failed',
  cancelled: 'Cancelled',
  unsupported: 'Unsupported',
  already_under_target: 'Already under target',
}

const CATEGORY_LABELS: Record<Category, string> = {
  image: 'Image',
  video: 'Video',
  pdf: 'PDF',
  document: 'Document',
  other: 'Other',
}

const MUTED_TONE = {
  tint: 'bg-muted',
  text: 'text-muted-foreground',
  border: 'border-border',
  accent: 'bg-muted-foreground',
}

function toastOpenError(err: unknown, prefix: string) {
  const message = String(err)
  const alreadyLabeled = /^Could not (reveal file|open folder)/.test(message)
  toast.error(alreadyLabeled ? message : `${prefix}: ${message}`)
}

async function revealFile(filePath: string) {
  try {
    await invoke('reveal_in_folder', { filePath })
  } catch (err) {
    console.error('reveal_in_folder failed:', err)
    toastOpenError(err, 'Could not reveal file')
  }
}

async function openSessionFolder(path: string) {
  try {
    await invoke('open_folder', { path })
  } catch (err) {
    console.error('open_folder failed:', err)
    toastOpenError(err, 'Could not open folder')
  }
}

function StatusMarker({ status }: { status: FileStatus }) {
  const tone = STATUS_TONES[status] ?? MUTED_TONE
  return (
    <Badge variant="secondary" className={`${tone.tint} ${tone.border} ${tone.text}`}>
      <span className={`size-1.5 rounded-full ${tone.accent}`} />
      {STATUS_LABELS[status] ?? status}
    </Badge>
  )
}

function fileDetail(file: HistoryFile): string {
  const category = CATEGORY_LABELS[file.category] ?? file.category
  const detail =
    file.strategyUsed ??
    (file.qualityUsed !== null ? `quality ${file.qualityUsed}` : null)
  return detail === null ? category : `${category} · ${detail}`
}

function fileResult(file: HistoryFile): string {
  if (file.compressedSize === null) return `${formatSize(file.originalSize)} → —`
  return `${formatSize(file.originalSize)} → ${formatSize(file.compressedSize)}`
}

function filePercent(file: HistoryFile): string {
  const percent = savedPercent(file.originalSize, file.compressedSize)
  return percent === null ? '—' : `${percent}%`
}

function Stat({
  label,
  value,
  hint,
  testId,
}: {
  label: string
  value: string | number
  hint?: string
  testId?: string
}) {
  return (
    <div data-testid={testId} className="rounded-xl border bg-muted/30 px-3 py-2">
      <div className="text-base font-medium tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {hint !== undefined && (
        <div className="text-xs text-muted-foreground tabular-nums">{hint}</div>
      )}
    </div>
  )
}

function BatchTitle({ session }: { session: HistorySession }) {
  const summary = sessionSummary(session)
  const duration =
    session.endedAt !== null ? formatDuration(session.endedAt - session.startedAt) : '—'
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="truncate text-base font-medium">
          {batchLabel(session.startedAt, new Date())}
        </span>
        {session.cancelled && <Badge variant="secondary">Cancelled</Badge>}
        {session.interrupted && <Badge variant="secondary">Interrupted</Badge>}
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {fileCountLabel(summary.fileCount)} · {duration} · Output: {session.outputFolder}
      </div>
    </div>
  )
}

function BatchStats({ session }: { session: HistorySession }) {
  const matched = session.matchedFiles !== null
  const summary = sessionSummary(session)
  const outcome = matched ? countOutcome(session.files) : session.outcome
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Stat
        testId="stat-saved"
        label="Saved"
        value={savedLabel(summary.savedBytes)}
        hint={summary.percent === null ? '—' : `${summary.percent}% saved`}
      />
      <Stat
        testId="stat-files"
        label="Files"
        value={
          matched
            ? `${summary.fileCount} / ${session.fileCount}`
            : fileCountLabel(summary.fileCount)
        }
      />
      <Stat testId="stat-best-effort" label="Best effort" value={outcome.bestEffort} />
      <Stat testId="stat-failed" label="Failed" value={outcome.failed} />
    </div>
  )
}

function ClearHistoryButton({
  disabled,
  onClear,
}: {
  disabled: boolean
  onClear: () => Promise<void>
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" disabled={disabled} />}>
        Clear history
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Clear history?</AlertDialogTitle>
          <AlertDialogDescription>
            Permanently deletes all compression history. Files on disk are not affected.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => void onClear()}>
            Delete history
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function BatchFiles({ session }: { session: HistorySession }) {
  if (session.files.length === 0) {
    const message = session.cancelled
      ? 'No files finished before this batch was cancelled.'
      : session.interrupted
        ? 'No files finished before this batch was interrupted.'
        : 'No files in this batch.'
    return <p className="text-sm text-muted-foreground">{message}</p>
  }
  return (
    <div className="overflow-hidden rounded-2xl border bg-card">
      <div
        data-testid="files-header"
        className="flex items-center justify-between border-b px-4 py-2 text-xs font-medium text-muted-foreground"
      >
        <span>Files</span>
        <span>{fileCountLabel(sessionSummary(session).fileCount)}</span>
      </div>
      <ul>
        {session.files.map((file) => {
          const tone = CATEGORY_TONES[file.category] ?? MUTED_TONE
          return (
            <li
              key={`${file.path}:${file.completedAt}`}
              className="flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0"
            >
              <span
                className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${tone.tint} ${tone.text}`}
              >
                <CategoryIcon category={file.category} size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium" title={file.path}>
                  {file.name}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {fileDetail(file)}
                </div>
                {file.error !== null && (
                  <div className="truncate text-xs text-destructive" title={file.error}>
                    {file.error}
                  </div>
                )}
              </div>
              <div className="shrink-0 text-right text-xs tabular-nums">
                <div>{fileResult(file)}</div>
                <div className="text-muted-foreground">{filePercent(file)}</div>
              </div>
              <StatusMarker status={file.status} />
              <div className="flex shrink-0 gap-0.5">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Reveal output"
                  disabled={file.outputPath === null}
                  onClick={() => {
                    if (file.outputPath) void revealFile(file.outputPath)
                  }}
                >
                  <RiFolderOpenLine />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Reveal source"
                  onClick={() => void revealFile(file.path)}
                >
                  <RiFolder3Line />
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
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
    clearHistory,
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
  const clearDisabled =
    response !== null &&
    response.totalSessions === 0 &&
    activeFilterCount(filters) === 0 &&
    response.skippedLines === 0
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
    <div className="flex min-h-0 flex-1 flex-col p-6">
      <Card className="flex min-h-0 flex-1 flex-col">
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            {showSession ? <BatchTitle session={session} /> : <div />}
            <div className="flex shrink-0 items-center gap-1.5">
              {showSession && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void openSessionFolder(session.outputFolder)}
                >
                  <RiFolderOpenLine data-icon="inline-start" />
                  Reveal folder
                </Button>
              )}
              {(showSession || unreadable) && (
                <ClearHistoryButton disabled={clearDisabled} onClear={clearHistory} />
              )}
            </div>
          </div>
          {showSession && <BatchStats session={session} />}
        </CardHeader>
        {response !== null && response.skippedLines > 0 && error === null && (
          <p className="px-(--card-spacing) text-xs text-muted-foreground">
            Some history entries could not be read ({response.skippedLines}).
          </p>
        )}
        <CardContent
          aria-busy={refreshing}
          className={`flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto${refreshing ? ' opacity-60' : ''}`}
        >
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
                  <RiHistoryLine />
                </EmptyMedia>
                <EmptyTitle>
                  {unreadable
                    ? 'History could not be read'
                    : filteredEmpty
                      ? 'No batches match these filters.'
                      : sessions.length === 0
                        ? 'No history yet'
                        : 'No batch selected'}
                </EmptyTitle>
                <EmptyDescription>
                  {unreadable
                    ? `${response?.skippedLines ?? 0} ${
                        (response?.skippedLines ?? 0) === 1 ? 'line' : 'lines'
                      } could not be read.`
                    : filteredEmpty
                      ? 'Clear filters to see the full history.'
                      : sessions.length === 0
                        ? 'Compressed files and their results will appear here.'
                        : 'Choose a batch from the sidebar.'}
                </EmptyDescription>
              </EmptyHeader>
              {filteredEmpty && (
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              )}
            </Empty>
          ) : (
            <BatchFiles session={session} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
