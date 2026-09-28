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
}

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

function formatSize(bytes: number): string {
  if (bytes === 0) return '—'
  const KB = 1024
  const MB = 1024 * 1024
  const GB = 1024 * 1024 * 1024
  if (bytes < KB) return `${bytes} B`
  if (bytes < MB) return `${(bytes / KB).toFixed(0)} KB`
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`
  return `${(bytes / GB).toFixed(2)} GB`
}

function formatTarget(bytes: number): string {
  if (bytes === 0) return '—'
  return formatSize(bytes)
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

export function FileList({ files, onRemove }: FileListProps) {
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
          {files.map((file) => (
            <TableRow
              key={file.id}
              className={file.status === 'unsupported' ? 'opacity-40' : ''}
            >
              <TableCell>
                <div className="text-sm font-medium truncate max-w-[200px]">{file.name}</div>
                <div className="text-xs text-muted-foreground mt-0.5 tabular-nums">
                  {formatSize(file.originalSize)}
                </div>
              </TableCell>
              <TableCell>
                <Badge variant="secondary" className={categoryVariant[file.category]}>
                  {categoryLabel[file.category]}
                </Badge>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground tabular-nums">
                {formatTarget(file.targetBytes)}
              </TableCell>
              <TableCell>
                <StatusBadge status={file.status} />
              </TableCell>
              <TableCell>
                <button
                  onClick={() => onRemove(file.id)}
                  aria-label={`Remove ${file.name}`}
                  className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title="Remove from list"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}