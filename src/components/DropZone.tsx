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

import { useState, useCallback, useEffect, useRef } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { Card, CardContent } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { RiUploadCloud2Line } from '@remixicon/react'

interface DropZoneProps {
  onBrowse: () => void
  onDrop: (paths: string[]) => void
  className?: string
}

export function DropZone({ onBrowse, onDrop, className }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false)
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
        if (event.payload.type === 'enter') {
          setIsDragging(true)
        } else if (event.payload.type === 'over') {
          setIsDragging(true)
        } else if (event.payload.type === 'drop') {
          setIsDragging(false)
          if (event.payload.paths.length > 0) {
            onDropRef.current(event.payload.paths)
          }
        } else {
          setIsDragging(false)
        }
      })
    } catch (err) {
      console.error('Drag-drop listener registration failed', err)
      return () => {}
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

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onBrowse()
    }
  }, [onBrowse])

  return (
    <Card
      onClick={onBrowse}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label="Drop files to compress or click to browse"
      className={`cursor-pointer border border-dashed transition-colors ${
        isDragging
          ? 'border-primary bg-primary/5'
          : 'border-input bg-muted/30 hover:bg-muted/50'
      } ${className ?? ''}`}
    >
      <CardContent className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 py-8">
        <div className="flex flex-col items-center gap-2">
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <RiUploadCloud2Line size={24} />
          </div>
          <p className="text-sm font-medium">Drag and drop</p>
        </div>
        <Separator orientation="vertical" className="h-20" />
        <div className="flex flex-col items-center gap-2.5">
          <p className="text-sm font-medium">Or choose a file</p>
          <Button
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              onBrowse()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
            }}
          >
            Browse your files
          </Button>
          <p className="text-xs text-muted-foreground">
            Supported: JPEG, PNG, WebP, HEIC, MP4, MOV, PDF, DOCX, XLSX, PPTX
          </p>
        </div>
      </CardContent>
    </Card>
  )
}