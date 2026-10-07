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

import type { MouseEvent, KeyboardEvent, ReactNode } from 'react'
import { useState, useCallback, useEffect, useRef } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { Button } from '@/components/ui/button'
import { RiUploadCloud2Line } from '@remixicon/react'
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

const CATEGORY_GLYPHS: Record<Category, ReactNode> = {
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </>
  ),
  video: (
    <>
      <path d="m22 8-6 4 6 4V8Z" />
      <rect x="2" y="6" width="14" height="12" rx="2" />
    </>
  ),
  pdf: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </>
  ),
  document: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </>
  ),
  other: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </>
  ),
}

function CategoryIcon({ category }: { category: Category }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {CATEGORY_GLYPHS[category]}
    </svg>
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
            <RiUploadCloud2Line size={16} />
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
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {FORMAT_GROUPS.map((group) => (
            <div
              key={group.testId}
              data-testid={group.testId}
              className={`flex flex-wrap items-center gap-1 rounded-lg border bg-background/50 px-2 py-1 ${group.border}`}
            >
              <span className="px-1 text-[9px] font-bold tracking-wider text-muted-foreground">
                {group.label}
              </span>
              {FORMATS.filter((f) => group.categories.includes(f.category)).map((f) => (
                <FormatPill key={f.ext} ext={f.ext} category={f.category} mini />
              ))}
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Add files: drop files here or press Enter to browse"
      onClick={onBrowse}
      onKeyDown={handleKeyDown}
      className={`flex w-full cursor-pointer flex-col items-center gap-3 rounded-2xl px-6 py-12 text-center transition-colors ${
        isDragging
          ? 'border border-dashed border-primary bg-primary/5'
          : 'border border-dashed border-input bg-muted/30 hover:bg-muted/50'
      } ${className ?? ''}`}
    >
      <div
        className={`flex size-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-[0_10px_26px_-10px_color-mix(in_oklab,var(--color-primary)_55%,transparent)] transition-transform ${
          isDragging ? 'scale-110' : ''
        }`}
      >
        <RiUploadCloud2Line size={28} />
      </div>
      <p className="text-lg font-bold">{isDragging ? 'Release to add files' : 'Drag and drop files here'}</p>
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
      <p className={`text-[11px] ${isDragging ? 'font-semibold text-primary' : 'text-muted-foreground'}`}>
        {isDragging ? filesDetected : '…or click anywhere in this area'}
      </p>
      <div className="mt-1.5 flex max-w-[560px] flex-wrap items-center justify-center gap-2">
        {FORMAT_GROUPS.map((group) => (
          <div
            key={group.testId}
            data-testid={group.testId}
            className={`flex flex-wrap items-center justify-center gap-1.5 rounded-xl border bg-background/50 px-2.5 py-1.5 ${group.border}`}
          >
            <span className="px-1 text-[10px] font-bold tracking-wider text-muted-foreground">
              {group.label}
            </span>
            {FORMATS.filter((f) => group.categories.includes(f.category)).map((f) => (
              <FormatPill key={f.ext} ext={f.ext} category={f.category} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
