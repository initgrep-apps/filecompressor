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
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { getCurrentWindow } from "@tauri-apps/api/window"

vi.mock("@tauri-apps/api/window", async () => {
  const { mockWindow } = await import("@/lib/test-tauri")
  const win = mockWindow()
  return { getCurrentWindow: () => win }
})

import { ThemeToggle } from "@/components/shell/ThemeToggle"
import { mockWindow } from "@/lib/test-tauri"
import { THEME_STORAGE_KEY } from "@/lib/theme"

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

describe("ThemeToggle", () => {
  it("renders a different icon for light and dark", () => {
    stubMatchMedia(false)
    const light = render(<ThemeToggle />)
    const lightMarkup = screen.getByRole("button", { name: "Toggle theme" }).innerHTML
    light.unmount()

    document.documentElement.classList.add("dark")
    stubMatchMedia(true)
    render(<ThemeToggle />)
    const darkMarkup = screen.getByRole("button", { name: "Toggle theme" }).innerHTML

    expect(lightMarkup).toContain("<svg")
    expect(darkMarkup).toContain("<svg")
    expect(darkMarkup).not.toBe(lightMarkup)
  })

  it("renders an icon-only button with an accessible name and native title", () => {
    stubMatchMedia(false)

    render(<ThemeToggle />)

    const button = screen.getByRole("button", { name: "Toggle theme" })
    expect(button).toHaveAttribute("title", "Toggle theme")
    expect(button.querySelector("svg")).not.toBeNull()
  })

  it("writes light and removes the dark class when starting dark", async () => {
    document.documentElement.classList.add("dark")
    stubMatchMedia(true)
    const user = userEvent.setup()
    render(<ThemeToggle />)

    await user.click(screen.getByRole("button", { name: "Toggle theme" }))

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(win.setTheme).toHaveBeenLastCalledWith("light")
  })

  it("writes dark and applies the class when starting light", async () => {
    stubMatchMedia(false)
    const user = userEvent.setup()
    render(<ThemeToggle />)

    await user.click(screen.getByRole("button", { name: "Toggle theme" }))

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(win.setTheme).toHaveBeenLastCalledWith("dark")
  })

  it("flips back on a double click without a stale closure", async () => {
    stubMatchMedia(false)
    const user = userEvent.setup()
    render(<ThemeToggle />)
    const button = screen.getByRole("button", { name: "Toggle theme" })

    await user.click(button)
    await user.click(button)

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(win.setTheme).toHaveBeenLastCalledWith("light")
  })
})
