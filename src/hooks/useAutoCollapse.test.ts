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
        setOpen: (v: boolean) => {
          registry.spy?.(v)
        },
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

  trigger(target: Element, entries?: ResizeObserverEntry[]) {
    this.callback(entries ?? [{ target } as ResizeObserverEntry])
  }
}

const setWidths = (el: HTMLElement, scrollWidth: number, clientWidth: number) => {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth })
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth })
}

const spy = () => registry.spy as Mock<(v: boolean) => void>

function attachRectChild(el: HTMLElement, contentRight: number): HTMLElement {
  const child = document.createElement('div')
  el.appendChild(child)
  vi.spyOn(child, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    right: contentRight,
    width: contentRight,
    top: 0,
    bottom: 0,
    x: 0,
    y: 0,
  } as DOMRect)
  return child
}

function setup(scroll: number, client: number) {
  const el = document.createElement('div')
  setWidths(el, scroll, client)
  const contentRef: RefObject<HTMLElement | null> = { current: el }
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

  it('ignores one-pixel overflow', () => {
    const { el, trigger } = setup(801, 800)
    trigger()
    expect(spy()).not.toHaveBeenCalled()
    setWidths(el, 802, 800)
    trigger()
    expect(spy()).toHaveBeenCalledTimes(1)
    expect(spy()).toHaveBeenLastCalledWith(false)
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
    act(() => {
      vi.advanceTimersByTime(300)
    })
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

  it('re-checks suspended cramped state at expiry', () => {
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
    expect(spy()).toHaveBeenCalledTimes(1)
    expect(spy()).toHaveBeenLastCalledWith(false)
  })

  it('keeps grace window churn-free and converges at expiry', () => {
    const { el, trigger, manual } = setup(700, 800)
    manual(false)
    expect(spy()).not.toHaveBeenCalled()
    setWidths(el, 1000, 800)
    trigger()
    manual(true)
    expect(spy()).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(spy()).toHaveBeenCalledTimes(1)
    expect(spy()).toHaveBeenLastCalledWith(false)
  })

  it('evaluates the last entry when a batch is delivered', () => {
    const { el } = setup(1000, 800)
    const thin = document.createElement('div')
    setWidths(thin, 700, 800)
    const observer = ResizeObserverStub.instances[0]
    act(() => {
      observer.trigger(el, [
        { target: thin } as unknown as ResizeObserverEntry,
        { target: el } as unknown as ResizeObserverEntry,
      ])
    })
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
    act(() => {
      vi.advanceTimersByTime(300)
    })
    setWidths(el, 700, 800)
    trigger()
    act(() => {
      vi.advanceTimersByTime(300)
    })
    setWidths(el, 1000, 800)
    trigger()
    expect(spy().mock.calls.map((c) => c[0])).toEqual([false, true, false])
  })

  it('defers restore until the collapse transition settles', () => {
    const { el, trigger } = setup(1000, 800)
    trigger()
    expect(spy()).toHaveBeenLastCalledWith(false)
    setWidths(el, 700, 800)
    trigger()
    expect(spy()).toHaveBeenCalledTimes(1)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(spy()).toHaveBeenCalledTimes(2)
    expect(spy()).toHaveBeenLastCalledWith(true)
  })

  it('does not restore while content would cramp the expanded sidebar', () => {
    const { el, trigger } = setup(1002, 620)
    attachRectChild(el, 1002)
    trigger()
    expect(spy()).toHaveBeenLastCalledWith(false)
    setWidths(el, 1002, 990)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(spy()).toHaveBeenCalledTimes(1)
    setWidths(el, 1002, 1150)
    trigger()
    expect(spy()).toHaveBeenCalledTimes(1)
    setWidths(el, 1002, 990)
    trigger()
    setWidths(el, 1002, 1150)
    trigger()
    expect(spy()).toHaveBeenCalledTimes(1)
  })

  it('restores only when content fits the expanded sidebar', () => {
    const { el, trigger } = setup(1002, 620)
    attachRectChild(el, 1002)
    trigger()
    setWidths(el, 1002, 990)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    setWidths(el, 1002, 1400)
    trigger()
    expect(spy().mock.calls.map((c) => c[0])).toEqual([false, true])
  })

  it('disconnects on unmount', () => {
    const { hook, trigger } = setup(1000, 800)
    trigger()
    const observer = ResizeObserverStub.instances[0]
    hook.unmount()
    expect(observer.disconnect).toHaveBeenCalledTimes(1)
  })

  it('creates no observer when the ref is null', () => {
    const contentRef: RefObject<HTMLElement | null> = { current: null }
    expect(() => renderHook(() => useAutoCollapse(contentRef))).not.toThrow()
    expect(ResizeObserverStub.instances).toHaveLength(0)
  })

  it('does not re-observe when open changes', () => {
    const { el, trigger, manual } = setup(700, 800)
    trigger()
    manual(false)
    manual(true)
    expect(ResizeObserverStub.instances).toHaveLength(1)
    expect(ResizeObserverStub.instances[0].observed).toEqual([el])
    expect(ResizeObserverStub.instances[0].disconnect).not.toHaveBeenCalled()
  })

  it('creates no observer when ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const contentRef: RefObject<HTMLElement | null> = { current: document.createElement('div') }
    expect(() => renderHook(() => useAutoCollapse(contentRef))).not.toThrow()
    expect(ResizeObserverStub.instances).toHaveLength(0)
  })
})
