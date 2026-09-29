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

import type { FileEntry, Category, FileStatus } from '@/types'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'

interface FileListProps {
  files: FileEntry[]
  onRemove: (fileId: string) => void
  progress?: Record<string, number>
  onReveal?: (outputPath: string) => void
  onCancel?: (fileId: string) => void
  removeDisabled?: boolean
}

export const RESULT_STATUSES: FileStatus[] = ['done', 'best_effort', 'already_under_target']

const categoryVariant: Record<Category, string> = {
  image: 'bg-secondary text-secondary-foreground',
  video: 'bg-secondary text-secondary-foreground',
  pdf: 'bg-secondary text-secondary-foreground',
  document: 'bg-secondary text-secondary-foreground',
  other: 'bg-muted text-muted-foreground',
}

const categoryLabel: Record<Category, string> = {
  image: 'Image',
  video: 'Video',
  pdf: 'PDF',
  document: 'Document',
  other: 'Other',
}

export function formatSize(bytes: number): string {
  if (bytes === 0) return '—'
  const KB = 1024
  const MB = 1024 * 1024
  const GB = 1024 * 1024 * 1024
  if (bytes < KB) return `${bytes} B`
  if (bytes < MB) return `${(bytes / KB).toFixed(0)} KB`
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`
  return `${(bytes / GB).toFixed(2)} GB`
}

function reductionPercent(file: FileEntry): number {
  if (file.originalSize === 0 || file.compressedSize === null) return 0
  return Math.max(
    0,
    Math.round(((file.originalSize - file.compressedSize) / file.originalSize) * 100)
  )
}

function StatusBadge({ status }: { status: FileStatus }) {
  const styles: Record<FileStatus, string> = {
    pending: 'text-muted-foreground',
    compressing: 'text-primary',
    done: 'text-primary',
    best_effort: 'text-destructive',
    failed: 'text-destructive',
    cancelled: 'text-muted-foreground',
    unsupported: 'text-muted-foreground',
    already_under_target: 'text-primary',
  }
  const labels: Record<FileStatus, string> = {
    pending: 'Pending',
    compressing: 'Compressing',
    done: 'Done',
    best_effort: 'Best effort',
    failed: 'Failed',
    cancelled: 'Cancelled',
    unsupported: 'Unsupported',
    already_under_target: 'Already under target',
  }
  const dotColors: Record<FileStatus, string> = {
    pending: 'bg-muted-foreground/50',
    compressing: 'bg-primary',
    done: 'bg-primary',
    best_effort: 'bg-destructive',
    failed: 'bg-destructive',
    cancelled: 'bg-muted-foreground/50',
    unsupported: 'bg-muted-foreground/30',
    already_under_target: 'bg-primary',
  }
  return (
    <span className={`flex items-center gap-1.5 text-xs ${styles[status]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dotColors[status]}`} />
      {labels[status]}
    </span>
  )
}

export function FileList({ files, onRemove, progress, onReveal, onCancel, removeDisabled }: FileListProps) {
  if (files.length === 0) return null

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-background/50">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[40%]">File</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Target</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-8"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {files.map((file) => {
            const hasResult =
              RESULT_STATUSES.includes(file.status) && file.compressedSize !== null
            const canReveal = hasResult && !!onReveal && !!file.outputPath
            const percent = progress?.[file.id] ?? 0
            return (
              <TableRow
                key={file.id}
                className={`group ${file.status === 'unsupported' ? 'opacity-40' : ''}`}
              >
                <TableCell>
                  <div className="text-sm font-medium truncate max-w-[200px]">{file.name}</div>
                  {hasResult ? (
                    <div
                      className={`text-xs mt-0.5 tabular-nums ${
                        file.status === 'best_effort' ? 'text-destructive' : 'text-muted-foreground'
                      }`}
                    >
                      {formatSize(file.originalSize)} → {formatSize(file.compressedSize!)} ·{' '}
                      {reductionPercent(file)}% smaller
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground mt-0.5 tabular-nums">
                      {formatSize(file.originalSize)}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className={categoryVariant[file.category]}>
                    {categoryLabel[file.category]}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground tabular-nums">
                  {formatSize(file.targetBytes)}
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1.5">
                    <StatusBadge status={file.status} />
                    {file.status === 'compressing' && (
                      <div
                        className="w-24"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={percent}
                      >
                        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full bg-primary transition-[width]"
                            style={{ width: `${percent}%` }}
                          />
                        </div>
                      </div>
                    )}
                    {file.status === 'failed' && file.error && (
                      <div className="text-xs text-destructive max-w-[180px] truncate" title={file.error}>
                        {file.error}
                      </div>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-0.5">
                    {canReveal && (
                      <button
                        onClick={() => onReveal?.(file.outputPath!)}
                        aria-label={`Reveal ${file.name}`}
                        title="Reveal in folder"
                        className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>
                      </button>
                    )}
                    {file.status === 'compressing' && onCancel ? (
                      <button
                        onClick={() => onCancel(file.id)}
                        aria-label={`Cancel ${file.name}`}
                        title="Cancel"
                        className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-muted transition-colors"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="6" y="6" width="12" height="12" rx="1" />
                        </svg>
                      </button>
                    ) : (
                      <button
                        onClick={() => onRemove(file.id)}
                        disabled={removeDisabled && file.status === 'pending'}
                        aria-label={`Remove ${file.name}`}
                        className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted-foreground disabled:hover:bg-transparent"
                        title="Remove from list"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
