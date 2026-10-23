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
  getDarkMediaQuery,
  readAppliedTheme,
  readStoredTheme,
  THEME_STORAGE_KEY,
  type Theme,
} from "@/lib/theme"

let storageWriteWarned = false
let nativeSyncWarned = false
let mediaListenerWarned = false

const persistTheme = (theme: Theme) => {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch (error) {
    if (storageWriteWarned) return
    storageWriteWarned = true
    console.warn("theme storage write failed", error)
  }
}

const warnNativeSyncOnce = (error: unknown) => {
  if (nativeSyncWarned) return
  nativeSyncWarned = true
  console.warn("native window theme sync failed", error)
}

const warnMediaListenerOnce = (error: unknown) => {
  if (mediaListenerWarned) return
  mediaListenerWarned = true
  console.warn("theme media listener failed", error)
}

const syncNativeTheme = (theme: Theme | null) => {
  try {
    void getCurrentWindow().setTheme(theme).catch(warnNativeSyncOnce)
  } catch (error) {
    warnNativeSyncOnce(error)
  }
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(readAppliedTheme)
  const bootstrapped = useRef(false)
  const explicitChoice = useRef(readStoredTheme() !== null)

  useEffect(() => {
    if (bootstrapped.current) applyTheme(theme)
    bootstrapped.current = true
    syncNativeTheme(explicitChoice.current ? theme : null)
  }, [theme])

  useEffect(() => {
    if (explicitChoice.current) return
    const mediaQuery = getDarkMediaQuery()
    if (!mediaQuery) return
    const handleChange = (event: MediaQueryListEvent) => {
      if (explicitChoice.current) return
      setTheme(event.matches ? "dark" : "light")
    }
    try {
      mediaQuery.addEventListener("change", handleChange)
    } catch (error) {
      warnMediaListenerOnce(error)
      return
    }
    return () => {
      try {
        mediaQuery.removeEventListener("change", handleChange)
      } catch (error) {
        warnMediaListenerOnce(error)
      }
    }
  }, [theme])

  const toggleTheme = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark"
    explicitChoice.current = true
    persistTheme(next)
    setTheme(next)
  }, [theme])

  return { theme, toggleTheme }
}
