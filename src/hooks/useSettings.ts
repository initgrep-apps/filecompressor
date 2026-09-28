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

import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { Settings } from '@/types'

const toMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const s = await invoke<Settings>('get_settings')
        if (!cancelled) setSettings(s)
      } catch (err) {
        if (!cancelled) setError(`Could not load settings: ${toMessage(err)}`)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const saveSettings = useCallback(async (s: Settings) => {
    try {
      await invoke('save_settings', { settings: s })
      setSettings(s)
      setError(null)
    } catch (err) {
      setError(`Could not save settings: ${toMessage(err)}`)
    }
  }, [])

  const resetSettings = useCallback(async (): Promise<Settings | null> => {
    try {
      const defaults = await invoke<Settings>('reset_settings')
      setSettings(defaults)
      setError(null)
      return defaults
    } catch (err) {
      setError(`Could not reset settings: ${toMessage(err)}`)
      return null
    }
  }, [])

  const browseFolder = useCallback(async (): Promise<string | null> => {
    try {
      const selected = await open({ directory: true, multiple: false })
      return typeof selected === 'string' ? selected : null
    } catch {
      return null
    }
  }, [])

  return { settings, loading, error, saveSettings, resetSettings, browseFolder }
}