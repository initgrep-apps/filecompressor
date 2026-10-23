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

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { getCurrentWindow } from "@tauri-apps/api/window"

vi.mock("@tauri-apps/api/window", async () => {
  const { mockWindow } = await import("@/lib/test-tauri")
  const win = mockWindow()
  return { getCurrentWindow: () => win }
})

vi.mock("@/lib/theme", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/theme")>()
  return { ...actual, applyTheme: vi.fn(actual.applyTheme) }
})

import { useTheme } from "@/hooks/useTheme"
import { mockWindow } from "@/lib/test-tauri"
import { applyTheme, THEME_STORAGE_KEY } from "@/lib/theme"

type ChangeListener = (event: MediaQueryListEvent) => void

function mockMatchMedia(initialDark: boolean) {
  const listeners = new Set<ChangeListener>()
  const mediaQuery = {
    matches: initialDark,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((_type: string, listener: ChangeListener) => {
      listeners.add(listener)
    }),
    removeEventListener: vi.fn((_type: string, listener: ChangeListener) => {
      listeners.delete(listener)
    }),
    dispatchEvent: vi.fn(),
  }
  window.matchMedia = vi.fn(() => mediaQuery as unknown as MediaQueryList)
  const setDark = (dark: boolean) => {
    mediaQuery.matches = dark
    listeners.forEach((listener) => listener({ matches: dark } as MediaQueryListEvent))
  }
  return { setDark, listenerCount: () => listeners.size }
}

const win = getCurrentWindow() as unknown as ReturnType<typeof mockWindow>

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove("dark")
  win.setTheme.mockReset()
  win.setTheme.mockResolvedValue(undefined)
  vi.mocked(applyTheme).mockClear()
})

describe("useTheme", () => {
  it("seeds from the dark class main.tsx already applied", () => {
    document.documentElement.classList.add("dark")
    mockMatchMedia(false)

    const { result } = renderHook(() => useTheme())

    expect(result.current.theme).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(applyTheme).not.toHaveBeenCalled()
    expect(win.setTheme).toHaveBeenCalledTimes(1)
    expect(win.setTheme).toHaveBeenCalledWith("dark")
  })

  it("does not re-apply the class on mount but applies it after a toggle", () => {
    document.documentElement.classList.add("dark")
    mockMatchMedia(true)
    const { result } = renderHook(() => useTheme())

    expect(applyTheme).not.toHaveBeenCalled()

    act(() => result.current.toggleTheme())

    expect(applyTheme).toHaveBeenCalledTimes(1)
    expect(applyTheme).toHaveBeenCalledWith("light")
  })

  it("toggles from dark to light, persists the choice, and drops the class", () => {
    document.documentElement.classList.add("dark")
    mockMatchMedia(true)
    const { result } = renderHook(() => useTheme())

    act(() => result.current.toggleTheme())

    expect(result.current.theme).toBe("light")
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(win.setTheme).toHaveBeenLastCalledWith("light")
    expect(win.setTheme).toHaveBeenCalledTimes(2)
  })

  it("toggles from light to dark", () => {
    mockMatchMedia(false)
    const { result } = renderHook(() => useTheme())

    act(() => result.current.toggleTheme())

    expect(result.current.theme).toBe("dark")
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(win.setTheme).toHaveBeenLastCalledWith("dark")
    expect(win.setTheme).toHaveBeenCalledTimes(2)
  })

  it("follows OS changes while no theme is stored", () => {
    const media = mockMatchMedia(false)
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe("light")

    act(() => media.setDark(true))

    expect(result.current.theme).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
    expect(win.setTheme).toHaveBeenLastCalledWith("dark")
  })

  it("follows OS changes when the stored theme is not a valid value", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "sepia")
    const media = mockMatchMedia(false)
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe("light")

    act(() => media.setDark(true))

    expect(result.current.theme).toBe("dark")
  })

  it("stops following the OS after an explicit choice", () => {
    const media = mockMatchMedia(false)
    const { result } = renderHook(() => useTheme())

    act(() => result.current.toggleTheme())
    act(() => media.setDark(false))

    expect(result.current.theme).toBe("dark")
    expect(media.listenerCount()).toBe(0)
  })

  it("lets a stored light theme win over a dark OS preference and stays unsubscribed", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light")
    const media = mockMatchMedia(true)

    const { result } = renderHook(() => useTheme())

    expect(result.current.theme).toBe("light")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(media.listenerCount()).toBe(0)
    expect(win.setTheme).toHaveBeenCalledWith("light")
  })

  it("still toggles for the session when persisting the choice fails", () => {
    const media = mockMatchMedia(false)
    const { result } = renderHook(() => useTheme())
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked")
    })
    try {
      expect(() => act(() => result.current.toggleTheme())).not.toThrow()
    } finally {
      spy.mockRestore()
    }

    expect(result.current.theme).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(media.listenerCount()).toBe(0)
  })

  it("removes the OS listener on unmount without a late update", () => {
    const media = mockMatchMedia(false)
    const { unmount } = renderHook(() => useTheme())
    expect(media.listenerCount()).toBe(1)

    unmount()

    expect(media.listenerCount()).toBe(0)
    const nativeCalls = win.setTheme.mock.calls.length
    act(() => media.setDark(true))
    expect(win.setTheme.mock.calls.length).toBe(nativeCalls)
  })

  it("logs a native setTheme failure once and keeps rendering", async () => {
    win.setTheme.mockRejectedValue(new Error("no tauri window"))
    mockMatchMedia(false)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    try {
      const { result } = renderHook(() => useTheme())
      await act(async () => {})

      expect(result.current.theme).toBe("light")
      expect(win.setTheme).toHaveBeenCalledWith("light")
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(
        "native window theme sync failed",
        expect.any(Error),
      )
    } finally {
      warn.mockRestore()
    }
  })
})
