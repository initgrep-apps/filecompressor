import { useState, useCallback, useEffect, useRef } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'

interface DropZoneProps {
  onBrowse: () => void
  onDrop: (paths: string[]) => void
  className?: string
}

export function DropZone({ onBrowse, onDrop, className }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const onDropRef = useRef(onDrop)
  onDropRef.current = onDrop

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined

    getCurrentWebview()
      .onDragDropEvent((event) => {
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
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
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
    <div
      onClick={onBrowse}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label="Drop files to compress or click to browse"
      className={`border border-dashed rounded-lg py-7 px-4 text-center cursor-pointer transition-colors ${
        isDragging
          ? 'border-primary bg-primary/5'
          : 'border-input bg-muted/30 hover:bg-muted/50'
      } ${className ?? ''}`}
    >
      <div className="inline-flex items-center justify-center w-10 h-10 rounded-lg border border-border bg-card mb-3">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      </div>
      <p className="text-sm font-medium text-foreground mb-0.5">Drop files to compress</p>
      <p className="text-xs text-muted-foreground">or <span className="text-primary underline">browse from your computer</span></p>
    </div>
  )
}