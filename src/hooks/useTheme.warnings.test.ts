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
  return { getCurrentWindow: vi.fn(() => win) }
})

import { useTheme } from "@/hooks/useTheme"
import { readInitialTheme, THEME_STORAGE_KEY } from "@/lib/theme"
import { mockWindow } from "@/lib/test-tauri"

const win = getCurrentWindow() as unknown as ReturnType<typeof mockWindow>

const stubMatchMedia = (dark: boolean) => {
  window.matchMedia = vi.fn(
    () =>
      ({
        matches: dark,
        media: "(prefers-color-scheme: dark)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  )
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove("dark")
  win.setTheme.mockReset()
  win.setTheme.mockResolvedValue(undefined)
})

describe("useTheme warnings", () => {
  it("warns once across two blocked storage reads", () => {
    stubMatchMedia(false)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const storage = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked")
    })

    try {
      expect(readInitialTheme()).toBe("light")
      expect(readInitialTheme()).toBe("light")
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(
        "theme storage read failed",
        expect.any(Error),
      )
    } finally {
      storage.mockRestore()
      warn.mockRestore()
    }
  })

  it("warns once across two rejected native setTheme calls", async () => {
    stubMatchMedia(false)
    win.setTheme.mockRejectedValue(new Error("no tauri window"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    try {
      const { result } = renderHook(() => useTheme())
      await act(async () => {})

      act(() => result.current.toggleTheme())
      await act(async () => {})

      expect(win.setTheme).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(
        "native window theme sync failed",
        expect.any(Error),
      )
    } finally {
      warn.mockRestore()
    }
  })

  it("warns once across two blocked storage writes and keeps the session theme", () => {
    stubMatchMedia(false)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { result } = renderHook(() => useTheme())
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked")
    })

    try {
      act(() => result.current.toggleTheme())
      act(() => result.current.toggleTheme())

      expect(result.current.theme).toBe("light")
      expect(document.documentElement.classList.contains("dark")).toBe(false)
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(
        "theme storage write failed",
        expect.any(Error),
      )
    } finally {
      storage.mockRestore()
      warn.mockRestore()
    }
  })
})
