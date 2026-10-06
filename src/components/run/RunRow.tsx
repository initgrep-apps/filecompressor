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

import { motion } from 'motion/react'
import { formatSize, RESULT_STATUSES } from '@/components/FileList'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { strategyLabel } from '@/lib/strategyLabels'
import type { FileEntry, FileStatus } from '@/types'

export interface RunRowProps {
  file: FileEntry
  percent?: number
  onCancel?: (fileId: string) => void
  onReveal?: (outputPath: string) => void
  onRemove?: (fileId: string) => void
}

type ChipTone = 'primary' | 'amber' | 'fail' | 'muted'

const CHIP_TONES: Record<ChipTone, string> = {
  primary: 'bg-primary/10 text-primary',
  amber: 'bg-amber-500/10 text-amber-600',
  fail: 'bg-destructive/10 text-destructive',
  muted: 'bg-muted text-muted-foreground',
}

const ICON_BUTTON =
  'inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'

const NAME_TONES: Partial<Record<FileStatus, string>> = {
  compressing: 'text-primary font-semibold',
  pending: 'text-muted-foreground',
}

function reductionPercent(file: FileEntry): number | null {
  if (file.originalSize === 0 || file.compressedSize === null) return null
  return Math.max(
    0,
    Math.round(((file.originalSize - file.compressedSize) / file.originalSize) * 100)
  )
}

function safePercent(percent: number | undefined): number {
  return percent !== undefined && Number.isFinite(percent)
    ? Math.min(100, Math.max(0, percent))
    : 0
}

function chipFor(file: FileEntry): { label: string; tone: ChipTone } | null {
  switch (file.status) {
    case 'done':
    case 'best_effort': {
      const pct = reductionPercent(file)
      if (pct === null) return null
      return { label: `-${pct}%`, tone: file.status === 'done' ? 'primary' : 'amber' }
    }
    case 'already_under_target':
      return { label: '≤ target', tone: 'primary' }
    case 'failed':
      return { label: 'Failed', tone: 'fail' }
    case 'cancelled':
      return { label: 'Cancelled', tone: 'muted' }
    case 'pending':
      return { label: 'Queued', tone: 'muted' }
    default:
      return null
  }
}

function sizesFor(file: FileEntry): string {
  switch (file.status) {
    case 'compressing':
      return `${formatSize(file.originalSize)} → …`
    case 'already_under_target':
      return formatSize(file.originalSize)
    case 'failed':
      return ''
    default:
      return file.compressedSize === null
        ? formatSize(file.originalSize)
        : `${formatSize(file.originalSize)} → ${formatSize(file.compressedSize)}`
  }
}

function strategyLineFor(file: FileEntry): string {
  if (file.status === 'already_under_target') {
    return `Already under ${formatSize(file.targetBytes)}`
  }
  const label = strategyLabel(file.strategyUsed, file.category)
  if (file.status === 'best_effort') {
    if (!label || label === 'Best effort') return 'Best effort'
    return `Best effort · ${label}`
  }
  return label
}

export function RunRow({ file, percent, onCancel, onReveal, onRemove }: RunRowProps) {
  const { status, outputPath, error } = file
  const tone = chipFor(file)
  const sizes = sizesFor(file)
  const note = strategyLineFor(file)
  const hasResult = RESULT_STATUSES.includes(status)
  const dimmed = status === 'cancelled'
  const nameTone = NAME_TONES[status] ?? 'text-foreground'

  return (
    <motion.div
      layout
      layoutId={`file-${file.id}`}
      data-testid={`run-row-${status}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: dimmed ? 0.6 : 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className={cn(
        'relative rounded-[calc(var(--radius)+2px)] border bg-card px-2.5 py-[9px]',
        status === 'compressing' && 'border-primary/30 bg-primary/5 shadow-[inset_3px_0_0_var(--primary)]',
        status === 'failed' && 'border-destructive/25 bg-destructive/5 shadow-[inset_3px_0_0_var(--destructive)]',
        status === 'pending' && 'border-dashed'
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn('min-w-0 flex-1 truncate text-[13px]', nameTone)} title={file.name}>
          {file.name}
        </span>
        {tone && (
          <span
            data-testid="run-chip"
            className={cn(
              'inline-flex shrink-0 items-center rounded-[5px] px-1.5 py-px font-mono text-[10px] font-bold leading-4',
              CHIP_TONES[tone.tone]
            )}
          >
            {tone.label}
          </span>
        )}
        {status === 'compressing' && onCancel && (
          <button
            type="button"
            aria-label={`Cancel ${file.name}`}
            className={ICON_BUTTON}
            onClick={() => onCancel(file.id)}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <rect x="6" y="6" width="12" height="12" rx="1.5" />
            </svg>
          </button>
        )}
        {hasResult && onReveal && outputPath && (
          <button
            type="button"
            aria-label={`Reveal ${file.name}`}
            title="Reveal in Finder"
            className={ICON_BUTTON}
            onClick={() => onReveal(outputPath)}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>
        )}
        {status === 'pending' && onRemove && (
          <button
            type="button"
            aria-label={`Remove ${file.name}`}
            className={ICON_BUTTON}
            onClick={() => onRemove(file.id)}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>
      {(sizes || hasResult) && (
        <div className="mt-[5px] flex flex-wrap items-center gap-x-2 gap-y-1">
          {sizes && (
            <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">{sizes}</span>
          )}
          {hasResult && note && (
            <span className="font-mono text-[10px] text-muted-foreground">{note}</span>
          )}
        </div>
      )}
      {status === 'compressing' && (
        <>
          <div className="mt-[7px] h-1 overflow-hidden rounded-full bg-primary/15">
            <div
              data-testid="run-progress-fill"
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${safePercent(percent)}%` }}
            />
          </div>
          <div className="mt-1.5 flex items-center gap-[7px] font-mono text-[10.5px] text-primary">
            <Spinner className="size-2.5" />
            <span>{Math.round(safePercent(percent))}%</span>
          </div>
        </>
      )}
      {(status === 'failed' || status === 'best_effort') && error && (
        <p
          className="mt-[5px] line-clamp-2 text-[10.5px] leading-[1.45] text-destructive"
          title={error}
        >
          {error}
        </p>
      )}
    </motion.div>
  )
}
