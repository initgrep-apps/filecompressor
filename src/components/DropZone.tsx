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

import type { MouseEvent, KeyboardEvent } from 'react'
import { useState, useCallback, useEffect, useRef } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { CategoryIcon } from '@/components/CategoryIcon'
import { CloudUpload } from 'lucide-react'
import type { Category } from '@/types'
import { CATEGORY_TONES } from '@/lib/tokens'

interface DropZoneProps {
  onBrowse: () => void
  onDrop: (paths: string[]) => void
  className?: string
  compact?: boolean
}

const FORMATS: Array<{ ext: string; category: Category }> = [
  { ext: 'JPEG', category: 'image' },
  { ext: 'PNG', category: 'image' },
  { ext: 'WebP', category: 'image' },
  { ext: 'HEIC', category: 'image' },
  { ext: 'MP4', category: 'video' },
  { ext: 'MOV', category: 'video' },
  { ext: 'PDF', category: 'pdf' },
  { ext: 'DOCX', category: 'document' },
  { ext: 'XLSX', category: 'document' },
  { ext: 'PPTX', category: 'document' },
]

const FORMAT_GROUPS: Array<{ label: string; testId: string; categories: Category[]; border: string }> = [
  {
    label: 'IMAGES:',
    testId: 'format-group-images',
    categories: ['image'],
    border: CATEGORY_TONES.image.border,
  },
  {
    label: 'VIDEOS:',
    testId: 'format-group-videos',
    categories: ['video'],
    border: CATEGORY_TONES.video.border,
  },
  {
    label: 'DOCS:',
    testId: 'format-group-docs',
    categories: ['pdf', 'document'],
    border: CATEGORY_TONES.pdf.border,
  },
]

const GROUPED_CATEGORIES = new Set(FORMAT_GROUPS.flatMap((g) => g.categories))
const UNGROUPED_FORMATS = FORMATS.filter((f) => !GROUPED_CATEGORIES.has(f.category))
if (import.meta.env.DEV && UNGROUPED_FORMATS.length > 0) {
  throw new Error(
    `FORMAT_GROUPS missing categories for: ${UNGROUPED_FORMATS.map((f) => `${f.ext} (${f.category})`).join(', ')}`
  )
}

function FormatPill({ ext, category, mini = false }: { ext: string; category: Category; mini?: boolean }) {
  const tone = CATEGORY_TONES[category]
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border font-semibold tracking-[0.01em] ${
        mini ? 'px-2 py-[2px] text-[9.5px]' : 'px-2.5 py-[3.5px] text-[10.5px]'
      } ${tone.border} ${tone.tint} ${tone.text}`}
    >
      <CategoryIcon category={category} />
      {ext}
    </span>
  )
}

function FormatGroups({ mini = false }: { mini?: boolean }) {
  return (
    <div
      className={
        mini
          ? 'flex min-w-0 flex-wrap items-center gap-1.5'
          : 'mt-1.5 flex max-w-[560px] flex-wrap items-center justify-center gap-2'
      }
    >
      {FORMAT_GROUPS.map((group) => (
        <div
          key={group.testId}
          data-testid={group.testId}
          className={
            mini
              ? `flex flex-wrap items-center gap-1 rounded-lg border bg-background/50 px-2 py-1 ${group.border}`
              : 'flex flex-wrap items-center justify-center gap-1.5'
          }
        >
          <span
            className={`px-1 font-bold tracking-wider text-muted-foreground ${
              mini ? 'text-[9px]' : 'text-[10px]'
            }`}
          >
            {group.label}
          </span>
          {FORMATS.filter((f) => group.categories.includes(f.category)).map((f) => (
            <FormatPill key={f.ext} ext={f.ext} category={f.category} mini={mini} />
          ))}
        </div>
      ))}
    </div>
  )
}

export function DropZone({ onBrowse, onDrop, className, compact = false }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [dragCount, setDragCount] = useState(0)
  const onDropRef = useRef(onDrop)

  useEffect(() => {
    onDropRef.current = onDrop
  })

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined

    let subscription: Promise<() => void>
    try {
      subscription = getCurrentWebview().onDragDropEvent((event) => {
        if (cancelled) return
        const payload = event.payload
        if (payload.type === 'enter' || payload.type === 'over') {
          setIsDragging(true)
          if ('paths' in payload && payload.paths.length > 0) {
            setDragCount(payload.paths.length)
          }
        } else if (payload.type === 'drop') {
          setIsDragging(false)
          setDragCount(0)
          if (payload.paths.length > 0) {
            onDropRef.current(payload.paths)
          }
        } else {
          setIsDragging(false)
          setDragCount(0)
        }
      })
    } catch (err) {
      subscription = Promise.reject(err)
    }

    subscription
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch((err) => {
        console.error('Drag-drop listener registration failed', err)
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onBrowse()
    }
  }, [onBrowse])

  const stopBrowseKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
  }, [])

  const handleBrowseClick = useCallback((e: MouseEvent) => {
    e.stopPropagation()
    onBrowse()
  }, [onBrowse])

  const filesDetected = dragCount > 0 ? `${dragCount} files detected` : 'Files detected'

  if (compact) {
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label="Add more files: drop here or press Enter to browse"
        onClick={onBrowse}
        onKeyDown={handleKeyDown}
        className={`flex w-full cursor-pointer flex-col gap-2 px-3.5 py-2.5 transition-colors ${
          isDragging
            ? 'border border-dashed border-primary bg-primary/5'
            : 'border border-dashed border-primary/35 bg-primary/3'
        } ${className ?? ''}`}
      >
        <div className="flex items-center gap-3">
          <div className="flex size-[34px] shrink-0 items-center justify-center rounded-[9px] bg-primary text-primary-foreground">
            <CloudUpload size={16} />
          </div>
          <span
            data-testid="compact-label"
            className="min-w-[144px] whitespace-nowrap text-[13px] font-semibold"
          >
            Drop more files here
          </span>
          <span className="whitespace-nowrap text-xs text-muted-foreground">or</span>
          <Button variant="outline" size="sm" onClick={handleBrowseClick} onKeyDown={stopBrowseKey}>
            Browse
          </Button>
        </div>
        <FormatGroups mini />
      </div>
    )
  }

  return (
    <Empty
      role="button"
      tabIndex={0}
      aria-label="Add files: drop files here or press Enter to browse"
      onClick={onBrowse}
      onKeyDown={handleKeyDown}
      className={`w-full max-w-xl min-h-[320px] flex-none cursor-pointer border bg-muted/20 p-8 outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
        isDragging
          ? 'border-dashed border-primary bg-primary/5'
          : 'border-dashed border-input hover:bg-muted/40'
      } ${className ?? ''}`}
    >
      <EmptyMedia
        className={`size-16 rounded-2xl bg-primary text-primary-foreground shadow-[0_10px_26px_-10px_color-mix(in_oklab,var(--color-primary)_55%,transparent)] transition-transform [&_svg:not([class*=size-])]:size-7 ${
          isDragging ? 'scale-110' : ''
        }`}
      >
        <CloudUpload />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>
          {isDragging ? 'Release to add files' : 'Drag and drop files here'}
        </EmptyTitle>
        <EmptyDescription
          className={isDragging ? 'font-semibold text-primary' : undefined}
        >
          {isDragging ? filesDetected : '…or click anywhere in this card'}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="lg" onClick={handleBrowseClick} onKeyDown={stopBrowseKey}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          Browse your files
        </Button>
        <FormatGroups />
      </EmptyContent>
    </Empty>
  )
}
