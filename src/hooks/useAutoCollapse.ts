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

import { useEffect, useRef, type RefObject } from 'react'
import { useSidebar } from '@/components/ui/sidebar'

const SUSPEND_MS = 3000

export function useAutoCollapse(contentRef: RefObject<HTMLElement | null>): void {
  const { open, setOpen } = useSidebar()
  const openRef = useRef(open)
  const crampedRef = useRef(false)
  const autoCollapsedRef = useRef(false)
  const lastManualRef = useRef(-Infinity)
  const lastSetRef = useRef<boolean | null>(null)

  openRef.current = open

  useEffect(() => {
    if (lastSetRef.current === null) {
      lastSetRef.current = open
      return
    }
    if (open === lastSetRef.current) return
    const now = Date.now()
    const priorManual = lastManualRef.current
    lastManualRef.current = now
    autoCollapsedRef.current = false
    if (open && crampedRef.current && now - priorManual >= SUSPEND_MS) {
      setOpen(false)
      lastSetRef.current = false
      autoCollapsedRef.current = true
    }
  }, [open, setOpen])

  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const evaluate = (entries: ResizeObserverEntry[]) => {
      const last = entries[entries.length - 1]
      if (!last) return
      const now = Date.now()
      if (now - lastManualRef.current < SUSPEND_MS) return
      const cramped = last.target.scrollWidth > last.target.clientWidth + 1
      if (cramped && !crampedRef.current) {
        if (openRef.current) {
          setOpen(false)
          lastSetRef.current = false
          autoCollapsedRef.current = true
        }
        crampedRef.current = true
      } else if (cramped && crampedRef.current && openRef.current && !autoCollapsedRef.current) {
        setOpen(false)
        lastSetRef.current = false
        autoCollapsedRef.current = true
      } else if (!cramped && crampedRef.current) {
        if (autoCollapsedRef.current && !openRef.current) {
          setOpen(true)
          lastSetRef.current = true
        }
        autoCollapsedRef.current = false
        crampedRef.current = false
      }
    }
    const observer = new ResizeObserver(evaluate)
    observer.observe(el)
    return () => {
      observer.disconnect()
    }
  }, [contentRef, setOpen])
}
