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

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { useSidebar } from '@/components/ui/sidebar'

const SUSPEND_MS = 3000

export function useAutoCollapse(contentRef: RefObject<HTMLElement | null>): void {
  const { open, setOpen } = useSidebar()
  const openRef = useRef(open)
  const setOpenRef = useRef(setOpen)
  const crampedRef = useRef(false)
  const autoCollapsedRef = useRef(false)
  const lastManualRef = useRef(-Infinity)
  const lastSetRef = useRef<boolean | null>(null)
  const recheckRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useLayoutEffect(() => {
    openRef.current = open
    setOpenRef.current = setOpen
  }, [open, setOpen])

  useEffect(() => {
    if (lastSetRef.current === null) {
      lastSetRef.current = open
      return
    }
    if (open === lastSetRef.current) return
    const now = Date.now()
    const priorManual = lastManualRef.current
    lastManualRef.current = now
    lastSetRef.current = open
    autoCollapsedRef.current = false
    if (open && crampedRef.current && now - priorManual >= SUSPEND_MS) {
      lastSetRef.current = false
      setOpenRef.current(false)
      autoCollapsedRef.current = true
    }
  }, [open])

  useEffect(() => {
    const el = contentRef.current
    if (!el || typeof ResizeObserver === 'undefined') {
      if (import.meta.env.DEV && !el) {
        console.warn(
          'useAutoCollapse: contentRef.current was null at effect time — auto-collapse inactive'
        )
      }
      return
    }
    const evaluate = (target: Element) => {
      const now = Date.now()
      const elapsed = now - lastManualRef.current
      if (elapsed < SUSPEND_MS) {
        if (recheckRef.current !== null) clearTimeout(recheckRef.current)
        recheckRef.current = setTimeout(() => {
          recheckRef.current = null
          evaluate(el)
        }, SUSPEND_MS - elapsed)
        return
      }
      const cramped = target.scrollWidth > target.clientWidth + 1
      if (cramped && !crampedRef.current) {
        if (openRef.current) {
          lastSetRef.current = false
          setOpenRef.current(false)
          autoCollapsedRef.current = true
        }
        crampedRef.current = true
      } else if (cramped && crampedRef.current && openRef.current && !autoCollapsedRef.current) {
        lastSetRef.current = false
        setOpenRef.current(false)
        autoCollapsedRef.current = true
      } else if (!cramped && crampedRef.current) {
        if (autoCollapsedRef.current && !openRef.current) {
          lastSetRef.current = true
          setOpenRef.current(true)
        }
        autoCollapsedRef.current = false
        crampedRef.current = false
      }
    }
    const observer = new ResizeObserver((entries: ResizeObserverEntry[]) => {
      const last = entries[entries.length - 1]
      if (!last) return
      evaluate(last.target)
    })
    observer.observe(el)
    return () => {
      if (recheckRef.current !== null) {
        clearTimeout(recheckRef.current)
        recheckRef.current = null
      }
      observer.disconnect()
    }
  }, [contentRef])
}
