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
import { readInitialTheme, THEME_STORAGE_KEY } from "@/lib/theme"

const mockOsPreference = (dark: boolean) => {
  window.matchMedia = vi.fn(
    () =>
      ({
        matches: dark,
        media: "(prefers-color-scheme: dark)",
      }) as MediaQueryList,
  )
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove("dark")
})

describe("readInitialTheme", () => {
  it("returns the stored theme over a light OS preference", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark")
    mockOsPreference(false)
    expect(readInitialTheme()).toBe("dark")
  })

  it("returns a stored light theme over a dark OS preference", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light")
    mockOsPreference(true)
    expect(readInitialTheme()).toBe("light")
  })

  it("follows a dark OS preference when nothing is stored", () => {
    mockOsPreference(true)
    expect(readInitialTheme()).toBe("dark")
  })

  it("follows a light OS preference when nothing is stored", () => {
    mockOsPreference(false)
    expect(readInitialTheme()).toBe("light")
  })

  it("ignores an invalid stored value", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "sepia")
    mockOsPreference(true)
    expect(readInitialTheme()).toBe("dark")
  })
})
