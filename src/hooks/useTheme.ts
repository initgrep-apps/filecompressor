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

import { useCallback, useEffect, useRef, useState } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import {
  applyTheme,
  hasStoredTheme,
  readAppliedTheme,
  THEME_STORAGE_KEY,
  type Theme,
} from "@/lib/theme"

const syncNativeTheme = (theme: Theme) => {
  try {
    void getCurrentWindow().setTheme(theme).catch(() => {})
  } catch {
    return
  }
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(readAppliedTheme)
  const bootstrapped = useRef(false)

  useEffect(() => {
    if (bootstrapped.current) applyTheme(theme)
    bootstrapped.current = true
    syncNativeTheme(theme)
  }, [theme])

  useEffect(() => {
    if (hasStoredTheme()) return
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
    const handleChange = (event: MediaQueryListEvent) => {
      setTheme(event.matches ? "dark" : "light")
    }
    mediaQuery.addEventListener("change", handleChange)
    return () => mediaQuery.removeEventListener("change", handleChange)
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark"
      localStorage.setItem(THEME_STORAGE_KEY, next)
      return next
    })
  }, [])

  return { theme, toggleTheme }
}
