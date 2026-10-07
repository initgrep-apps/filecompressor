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

import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import {
  RiCheckLine,
  RiCloseCircleLine,
  RiEqualLine,
  RiErrorWarningLine,
  RiFileCopyLine,
  RiFileCopy2Line,
  RiFolder3Line,
  RiFolderOpenLine,
  RiHistoryLine,
  RiPauseCircleLine,
  RiSkipRightLine,
} from '@remixicon/react'
import type { Category, FileStatus, HistoryFile, HistorySession, SessionOutcome } from '@/types'
import { useHistory } from '@/hooks/useHistory'
import {
  dayKey,
  dayLabel,
  formatDuration,
  presetSinceMs,
  type DatePreset,
} from '@/lib/historyFormat'
import { CATEGORY_TONES, STATUS_TONES } from '@/lib/tokens'
import { RESULT_STATUSES } from '@/components/FileList'
import { formatSize } from '@/lib/sizeFormat'
import { HistoryPagination } from '@/components/HistoryPagination'
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
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

type Tone = (typeof STATUS_TONES)[FileStatus]

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

const HISTORY_STATUSES: FileStatus[] = [
  'done',
  'best_effort',
  'failed',
  'cancelled',
  'unsupported',
  'already_under_target',
]

const HISTORY_CATEGORIES: Category[] = ['image', 'video', 'pdf', 'document', 'other']

const OUTCOME_COUNT_KEYS: Partial<Record<FileStatus, keyof SessionOutcome>> = {
  done: 'done',
  best_effort: 'bestEffort',
  failed: 'failed',
  cancelled: 'cancelled',
  unsupported: 'unsupported',
  already_under_target: 'alreadyUnderTarget',
}

const OUTCOME_TONES: Record<keyof SessionOutcome, Tone> = {
  done: STATUS_TONES.done,
  bestEffort: STATUS_TONES.best_effort,
  failed: STATUS_TONES.failed,
  cancelled: STATUS_TONES.cancelled,
  unsupported: STATUS_TONES.unsupported,
  alreadyUnderTarget: STATUS_TONES.already_under_target,
}

const OUTCOME_PRECEDENCE: (keyof SessionOutcome)[] = [
  'failed',
  'bestEffort',
  'done',
  'cancelled',
  'alreadyUnderTarget',
  'unsupported',
]

function dominantOutcome(outcome: SessionOutcome): keyof SessionOutcome | null {
  let best: keyof SessionOutcome | null = null
  let bestCount = 0
  for (const key of OUTCOME_PRECEDENCE) {
    if (outcome[key] > bestCount) {
      best = key
      bestCount = outcome[key]
    }
  }
  return best
}

const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
]

const OUTCOME_ENTRIES: { key: keyof HistorySession['outcome']; icon: typeof RiCheckLine; label: string }[] = [
  { key: 'done', icon: RiCheckLine, label: 'Done' },
  { key: 'bestEffort', icon: RiErrorWarningLine, label: 'Best effort' },
  { key: 'failed', icon: RiCloseCircleLine, label: 'Failed' },
  { key: 'unsupported', icon: RiSkipRightLine, label: 'Skipped' },
  { key: 'cancelled', icon: RiPauseCircleLine, label: 'Cancelled' },
  { key: 'alreadyUnderTarget', icon: RiEqualLine, label: 'Already under target' },
]

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('Path copied')
  } catch (err) {
    console.error('copy to clipboard failed:', err)
    toast.error('Could not copy path')
  }
}

const searchToFilter = (text: string): string | undefined => text.trim() || undefined

async function revealFile(filePath: string) {
  try {
    await invoke('reveal_in_folder', { filePath })
  } catch (err) {
    console.error('reveal_in_folder failed:', err)
    toast.error(`Could not open folder: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function openSessionFolder(path: string) {
  try {
    await invoke('open_folder', { path })
  } catch (err) {
    console.error('open_folder failed:', err)
    toast.error(`Could not open folder: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function parentDir(path: string): string {
  const parts = path.split(/[\\/]/)
  const dir = parts.slice(0, -1).join('/')
  return dir.length > 0 ? dir : path
}

function savedLabel(bytes: number): string {
  return bytes === 0 ? '0 B' : formatSize(bytes)
}

function fileCountLabel(count: number): string {
  return count === 1 ? '1 file' : `${count} files`
}

function matchLabel(count: number): string {
  return count === 1 ? '1 match' : `${count} matches`
}

function savedPercent(original: number, compressed: number): number {
  return original > 0
    ? Math.max(0, Math.round(((original - compressed) / original) * 100))
    : 0
}

function fileResult(file: HistoryFile): string {
  if (!RESULT_STATUSES.includes(file.status) || file.compressedSize === null) return '—'
  const pct = savedPercent(file.originalSize, file.compressedSize)
  return `${formatSize(file.originalSize)} → ${formatSize(file.compressedSize)} · ${pct}%`
}

function StatusMarker({ status }: { status: FileStatus }) {
  const tone = STATUS_TONES[status]
  return (
    <span className={`flex items-center gap-1.5 text-xs ${tone.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${tone.accent}`} />
      {STATUS_LABELS[status]}
    </span>
  )
}

function nextFilterList<T>(current: T[] | undefined, value: T): T[] {
  return current?.includes(value)
    ? current.filter((item) => item !== value)
    : [...(current ?? []), value]
}

function Chip({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean
  tone: Tone
  onClick: () => void
  children: string
}) {
  return (
    <Button
      type="button"
      variant={active ? 'secondary' : 'outline'}
      size="xs"
      aria-pressed={active}
      className={active ? `${tone.tint} ${tone.border} ${tone.text}` : undefined}
      onClick={onClick}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tone.accent}`} />
      {children}
    </Button>
  )
}

interface SessionRowProps {
  session: HistorySession
  expanded: boolean
  onToggle: () => void
}

function countOutcome(files: HistoryFile[]): SessionOutcome {
  const counts: SessionOutcome = {
    done: 0,
    bestEffort: 0,
    failed: 0,
    cancelled: 0,
    unsupported: 0,
    alreadyUnderTarget: 0,
  }
  return files.reduce((acc, file) => {
    const key = OUTCOME_COUNT_KEYS[file.status]
    if (key !== undefined) acc[key] += 1
    return acc
  }, counts)
}

function SessionRow({ session, expanded, onToggle }: SessionRowProps) {
  const panelId = `session-${session.sessionId}-files`
  const files = session.files
  const sumOriginal = files.reduce((acc, f) => acc + f.originalSize, 0)
  const sumCompressed = files.reduce((acc, f) => acc + (f.compressedSize ?? 0), 0)
  const pct = savedPercent(sumOriginal, sumCompressed)
  const duration = session.endedAt !== null ? formatDuration(session.endedAt - session.startedAt) : '—'
  const startedAtDate = new Date(session.startedAt)
  const startedAtLabel = Number.isFinite(startedAtDate.getTime())
    ? new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }).format(startedAtDate)
    : '—'
  const matchedFiles = session.matchedFiles
  const matched = matchedFiles !== null
  const outcome = matched ? countOutcome(files) : session.outcome
  const hasOutput = files.some((f) => f.outputPath !== null)
  const countLabel = matched ? matchLabel(matchedFiles) : fileCountLabel(session.fileCount)
  const accentKey = dominantOutcome(outcome)
  const accent = accentKey ? OUTCOME_TONES[accentKey].accent : null

  return (
    <div className="flex overflow-hidden rounded-2xl border bg-card">
      {accent && (
        <span
          aria-hidden
          data-testid="session-accent"
          className={`w-1 shrink-0 ${accent}`}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-1.5 p-2">
          <button
            type="button"
            className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-xl px-1.5 py-0.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
            aria-expanded={expanded}
            aria-controls={panelId}
            aria-label="Toggle session details"
            onClick={onToggle}
          >
            <div className="flex flex-wrap items-center gap-x-0.5 text-sm tabular-nums">
              <span className="text-muted-foreground">{startedAtLabel}</span>
              {matched && (
                <>
                  {' · '}
                  <span>{countLabel}</span>
                </>
              )}
              {' · '}
              <span>
                {!matched ? `${countLabel} · ` : ''}
                {formatSize(sumOriginal)} → {formatSize(sumCompressed)} · {pct}% saved ·{' '}
                {duration}
              </span>
              {session.interrupted && (
                <Badge variant="secondary">
                  <RiErrorWarningLine />
                  Interrupted
                </Badge>
              )}
              {session.cancelled && (
                <Badge variant="secondary">
                  <RiPauseCircleLine />
                  Cancelled
                </Badge>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {OUTCOME_ENTRIES.filter(({ key }) => outcome[key] > 0).map(
                ({ key, icon: Icon, label }) => {
                  const tone = OUTCOME_TONES[key]
                  return (
                    <Badge
                      key={key}
                      variant="secondary"
                      className={`${tone.tint} ${tone.border} ${tone.text}`}
                    >
                      <Icon />
                      {label} {outcome[key]}
                    </Badge>
                  )
                }
              )}
            </div>
          </button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open output folder"
            disabled={!hasOutput}
            onClick={() => void openSessionFolder(session.outputFolder)}
          >
            <RiFolderOpenLine />
          </Button>
        </div>
        {expanded && (
          <div id={panelId} className="border-t px-3 pb-3 pt-2">
            <Table aria-label="Session files">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[36%]">File</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="w-28 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {files.map((file) => {
                  const tone = CATEGORY_TONES[file.category]
                  return (
                    <TableRow key={`${file.path}:${file.completedAt}`} className="group align-top">
                      <TableCell>
                        <div className="max-w-[220px] truncate text-sm font-medium" title={file.path}>
                          {file.name}
                        </div>
                        <div className="max-w-[220px] truncate text-xs text-muted-foreground" title={file.path}>
                          {parentDir(file.path)}
                        </div>
                        {file.error !== null && (
                          <div className="max-w-[220px] text-xs text-destructive">{file.error}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={`${tone.tint} ${tone.border} ${tone.text}`}
                        >
                          {CATEGORY_LABELS[file.category]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <StatusMarker status={file.status} />
                      </TableCell>
                      <TableCell className="tabular-nums">{formatSize(file.targetBytes)}</TableCell>
                      <TableCell className="tabular-nums" title={file.strategyUsed ?? undefined}>
                        {fileResult(file)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-0.5">
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
                            aria-label="Copy output path"
                            disabled={file.outputPath === null}
                            onClick={() =>
                              file.outputPath && copyToClipboard(file.outputPath)
                            }
                          >
                            <RiFileCopyLine />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label="Reveal source"
                            onClick={() => void revealFile(file.path)}
                          >
                            <RiFolder3Line />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label="Copy source path"
                            onClick={() => copyToClipboard(file.path)}
                          >
                            <RiFileCopy2Line />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
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
    page,
    setPage,
    refresh,
    clearHistory,
    clearError,
  } = useHistory()

  const [searchText, setSearchText] = useState('')
  const [datePreset, setDatePreset] = useState<DatePreset>('all')
  const [expandState, setExpandState] = useState<Record<string, boolean>>({})
  const [confirmOpen, setConfirmOpen] = useState(false)

  useEffect(() => {
    setExpandState({})
  }, [response])

  const setFiltersRef = useRef(setFilters)

  useEffect(() => {
    setFiltersRef.current = setFilters
  }, [setFilters])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFiltersRef.current({ search: searchToFilter(searchText) })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [searchText])

  const activeCount =
    (filters.search ? 1 : 0) +
    (filters.statuses?.length ? 1 : 0) +
    (filters.categories?.length ? 1 : 0) +
    (filters.sinceMs !== undefined ? 1 : 0) +
    (filters.outputFolder ? 1 : 0)

  const clearAllFilters = () => {
    setSearchText('')
    setDatePreset('all')
    setFilters({
      search: undefined,
      statuses: undefined,
      categories: undefined,
      sinceMs: undefined,
      outputFolder: undefined,
    })
  }

  const applySearch = (text: string) => {
    setSearchText(text)
    setFiltersRef.current({ search: searchToFilter(text) })
  }

  const applyDatePreset = (preset: DatePreset) => {
    setDatePreset(preset)
    setFilters({ sinceMs: presetSinceMs(preset, new Date()) })
  }

  const now = useMemo(() => new Date(), [])

  const dayGroups = useMemo(() => {
    if (!response) return []
    const map = new Map<string, { label: string; items: HistorySession[] }>()
    for (const session of response.sessions) {
      const key = dayKey(session.startedAt)
      if (!map.has(key)) map.set(key, { label: dayLabel(session.startedAt, now), items: [] })
      map.get(key)!.items.push(session)
    }
    return [...map.values()]
  }, [response, now])

  const isSessionExpanded = (session: HistorySession) =>
    expandState[session.sessionId] ?? session.matchedFiles !== null

  const toggleSession = (session: HistorySession) =>
    setExpandState((prev) => ({
      ...prev,
      [session.sessionId]: !isSessionExpanded(session),
    }))

  const initialLoading = loading && response === null
  const busy = loading && response !== null
  const hasActiveFilters = activeCount > 0
  const emptySessions = response !== null && response.sessions.length === 0

  return (
    <div className="flex min-h-0 flex-1 flex-col p-6">
      <Card className="flex min-h-0 flex-1 flex-col">
        <CardHeader className="gap-3 [.border-b]:pb-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Search history"
              placeholder="Search name, path, error…"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') applySearch('')
              }}
              className="w-56"
            />
            <Select
              value={datePreset}
              onValueChange={(v) => {
                if (v !== null) applyDatePreset(v)
              }}
            >
              <SelectTrigger aria-label="Date range" className="w-32">
                {DATE_PRESETS.find((p) => p.value === datePreset)?.label}
              </SelectTrigger>
              <SelectContent>
                {DATE_PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={filters.outputFolder ?? ''}
              onValueChange={(v) => {
                if (v !== null) setFilters({ outputFolder: v || undefined })
              }}
            >
              <SelectTrigger aria-label="Output folder" className="max-w-44 min-w-32">
                <span className="truncate">{filters.outputFolder ?? 'All folders'}</span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">All folders</SelectItem>
                {(response?.outputFolders ?? []).map((folder) => (
                  <SelectItem key={folder} value={folder}>
                    {folder}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {hasActiveFilters && (
              <>
                <span className="text-xs text-muted-foreground">{activeCount} active</span>
                <Button variant="ghost" size="sm" onClick={clearAllFilters}>
                  Clear filters
                </Button>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {HISTORY_STATUSES.map((status) => (
              <Chip
                key={status}
                active={filters.statuses?.includes(status) === true}
                tone={STATUS_TONES[status]}
                onClick={() => {
                  const next = nextFilterList(filters.statuses, status)
                  setFilters({ statuses: next.length > 0 ? next : undefined })
                }}
              >
                {STATUS_LABELS[status]}
              </Chip>
            ))}
            {HISTORY_CATEGORIES.map((category) => (
              <Chip
                key={category}
                active={filters.categories?.includes(category) === true}
                tone={CATEGORY_TONES[category]}
                onClick={() => {
                  const next = nextFilterList(filters.categories, category)
                  setFilters({ categories: next.length > 0 ? next : undefined })
                }}
              >
                {CATEGORY_LABELS[category]}
              </Chip>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              {response?.summary && (
                <>
                  <span>{response.summary.sessions} sessions</span>
                  <span aria-hidden>·</span>
                  <span>{response.summary.files} files</span>
                  <span aria-hidden>·</span>
                  <span>{savedLabel(response.summary.savedBytes)} saved</span>
                  <span aria-hidden>·</span>
                  <span>{response.summary.failedFiles} failed</span>
                </>
              )}
            </div>
            <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
              <AlertDialogTrigger render={<Button variant="destructive" size="sm" />}>
                Clear history
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear history?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Permanently deletes all compression history. Files on disk are not
                    affected.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={() => clearHistory()}
                  >
                    Delete history
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardHeader>
        {response !== null && response.skippedLines > 0 && (
          <p className="px-(--card-spacing) text-xs text-muted-foreground">
            Some history entries could not be read.
          </p>
        )}
        <CardContent className="min-h-0 flex-1 overflow-y-auto" aria-busy={busy}>
          {error !== null ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <p className="text-sm text-destructive">{error}</p>
              <Button
                variant="outline"
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
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : emptySessions && !hasActiveFilters ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <RiHistoryLine />
                </EmptyMedia>
                <EmptyTitle>No history yet</EmptyTitle>
                <EmptyDescription>
                  Compressed files and their results will appear here.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : emptySessions && hasActiveFilters ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No matches</EmptyTitle>
                <EmptyDescription>No sessions match the active filters.</EmptyDescription>
              </EmptyHeader>
              <Button
                variant="outline"
                size="sm"
                aria-label="Clear all filters"
                onClick={clearAllFilters}
              >
                Clear filters
              </Button>
            </Empty>
          ) : (
            response && (
              <div className="flex flex-col gap-3">
                {dayGroups.map((group) => (
                  <div key={group.label + group.items[0].sessionId} className="flex flex-col gap-2">
                    <div className="sticky top-0 z-10 bg-card py-1 text-xs font-medium text-muted-foreground">
                      {group.label}
                    </div>
                    {group.items.map((session) => (
                      <SessionRow
                        key={session.sessionId}
                        session={session}
                        expanded={isSessionExpanded(session)}
                        onToggle={() => toggleSession(session)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )
          )}
        </CardContent>
        {response !== null && error === null && !emptySessions && (
          <div className="px-(--card-spacing)">
            <HistoryPagination
              page={page}
              pageSize={response.pageSize}
              totalSessions={response.totalSessions}
              onPageChange={setPage}
            />
          </div>
        )}
      </Card>
    </div>
  )
}
