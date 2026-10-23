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

export const THEMES = ["light", "dark"] as const

export type Theme = (typeof THEMES)[number]

export const THEME_STORAGE_KEY = "yard-theme"

export const DARK_QUERY = "(prefers-color-scheme: dark)"

let storageReadWarned = false
let mediaQueryWarned = false
let invalidStoredWarned = false

const warnStorageReadOnce = (error: unknown) => {
  if (storageReadWarned) return
  storageReadWarned = true
  console.warn("theme storage read failed", error)
}

const warnMediaQueryOnce = (error: unknown) => {
  if (mediaQueryWarned) return
  mediaQueryWarned = true
  console.warn("theme media query failed", error)
}

const warnInvalidStoredOnce = (value: string) => {
  if (invalidStoredWarned) return
  invalidStoredWarned = true
  console.warn("theme storage value invalid", value)
}

export function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    const theme = THEMES.find((candidate) => candidate === stored) ?? null
    if (theme === null && stored !== null) warnInvalidStoredOnce(stored)
    return theme
  } catch (error) {
    warnStorageReadOnce(error)
    return null
  }
}

export function getDarkMediaQuery(): MediaQueryList | null {
  try {
    return window.matchMedia(DARK_QUERY)
  } catch (error) {
    warnMediaQueryOnce(error)
    return null
  }
}

export function readInitialTheme(): Theme {
  const stored = readStoredTheme()
  if (stored) return stored
  return getDarkMediaQuery()?.matches ? "dark" : "light"
}

export function readAppliedTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light"
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark")
}
