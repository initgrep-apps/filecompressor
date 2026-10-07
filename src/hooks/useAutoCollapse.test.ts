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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { Mock } from 'vitest'
import type { RefObject } from 'react'
import { useAutoCollapse } from '@/hooks/useAutoCollapse'

const registry = vi.hoisted(() => ({
  open: true,
  spy: null as Mock<(v: boolean) => void> | null,
  setState: null as ((v: boolean) => void) | null,
}))

vi.mock('@/components/ui/sidebar', async () => {
  const { useState } = await import('react')
  return {
    useSidebar: () => {
      const [open, setOpen] = useState(registry.open)
      registry.setState = setOpen
      if (!registry.spy) {
        registry.spy = vi.fn((v: boolean) => {
          registry.open = v
          setOpen(v)
        })
      }
      return {
        open,
        setOpen: registry.spy,
        openMobile: false,
        setOpenMobile: vi.fn(),
        isMobile: false,
        toggleSidebar: vi.fn(),
        state: open ? ('expanded' as const) : ('collapsed' as const),
      }
    },
  }
})

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = []
  callback: (entries: ResizeObserverEntry[]) => void
  observed: Element[] = []
  disconnect = vi.fn()

  constructor(callback: (entries: ResizeObserverEntry[]) => void) {
    this.callback = callback
    ResizeObserverStub.instances.push(this)
  }

  observe(target: Element) {
    this.observed.push(target)
  }

  trigger(target: Element) {
    this.callback([{ target } as ResizeObserverEntry])
  }
}

const setWidths = (el: HTMLElement, scrollWidth: number, clientWidth: number) => {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth })
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth })
}

const spy = () => registry.spy as Mock<(v: boolean) => void>

function setup(scroll: number, client: number) {
  const el = document.createElement('div')
  setWidths(el, scroll, client)
  const contentRef = { current: el } as RefObject<HTMLElement | null>
  const hook = renderHook(() => useAutoCollapse(contentRef))
  const trigger = () => {
    const observer = ResizeObserverStub.instances[0]
    act(() => {
      observer?.trigger(el)
    })
  }
  const manual = (v: boolean) => {
    act(() => {
      registry.setState?.(v)
    })
  }
  return { el, hook, trigger, manual }
}

beforeEach(() => {
  vi.useFakeTimers()
  ResizeObserverStub.instances = []
  registry.open = true
  registry.spy = null
  registry.setState = null
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useAutoCollapse', () => {
  it('collapses when content overflows', () => {
    const { el, trigger } = setup(1000, 800)
    const observer = ResizeObserverStub.instances[0]
    expect(observer.observed).toContain(el)
    trigger()
    expect(spy()).toHaveBeenCalledWith(false)
  })

  it('does not expand when collapse was manual', () => {
    const { el, trigger, manual } = setup(700, 800)
    trigger()
    manual(false)
    vi.advanceTimersByTime(3000)
    setWidths(el, 1000, 800)
    trigger()
    setWidths(el, 700, 800)
    trigger()
    expect(spy()).not.toHaveBeenCalled()
  })

  it('re-collapses when cramped after manual open', () => {
    const { trigger, manual } = setup(1000, 800)
    trigger()
    manual(true)
    expect(spy()).toHaveBeenCalledTimes(2)
    expect(spy()).toHaveBeenLastCalledWith(false)
  })

  it('restores when space returns', () => {
    const { el, trigger } = setup(1000, 800)
    trigger()
    setWidths(el, 700, 800)
    trigger()
    expect(spy().mock.calls.map((c) => c[0])).toEqual([false, true])
  })

  it('suspends auto-collapse for 3 s after manual toggle', () => {
    const { el, trigger, manual } = setup(700, 800)
    trigger()
    manual(false)
    manual(true)
    vi.advanceTimersByTime(1000)
    setWidths(el, 1000, 800)
    trigger()
    expect(spy()).not.toHaveBeenCalled()
  })

  it('suspension lifts — cramped after window fires collapse', () => {
    const { el, trigger, manual } = setup(700, 800)
    trigger()
    manual(false)
    manual(true)
    vi.advanceTimersByTime(1000)
    setWidths(el, 1000, 800)
    trigger()
    expect(spy()).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    trigger()
    expect(spy()).toHaveBeenCalledTimes(1)
    expect(spy()).toHaveBeenLastCalledWith(false)
  })

  it('respected after suspension expiry', () => {
    const { el, trigger, manual } = setup(700, 800)
    trigger()
    manual(false)
    vi.advanceTimersByTime(1000)
    setWidths(el, 1000, 800)
    trigger()
    vi.advanceTimersByTime(2000)
    trigger()
    setWidths(el, 700, 800)
    trigger()
    expect(spy()).not.toHaveBeenCalled()
  })

  it('collapses again after restore cycle', () => {
    const { el, trigger } = setup(1000, 800)
    trigger()
    setWidths(el, 700, 800)
    trigger()
    setWidths(el, 1000, 800)
    trigger()
    expect(spy().mock.calls.map((c) => c[0])).toEqual([false, true, false])
  })

  it('disconnects on unmount', () => {
    const { hook, trigger } = setup(1000, 800)
    trigger()
    const observer = ResizeObserverStub.instances[0]
    hook.unmount()
    expect(observer.disconnect).toHaveBeenCalledTimes(1)
  })

  it('creates no observer when the ref is null', () => {
    const contentRef = { current: null } as RefObject<HTMLElement | null>
    expect(() => renderHook(() => useAutoCollapse(contentRef))).not.toThrow()
    expect(ResizeObserverStub.instances).toHaveLength(0)
  })
})
