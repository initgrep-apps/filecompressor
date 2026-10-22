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

import { useState, useEffect, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { Settings } from '@/types'

const toMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return JSON.stringify(err)
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mutationCountRef = useRef(0)
  const bumpMutations = () => {
    mutationCountRef.current += 1
  }

  useEffect(() => {
    let cancelled = false
    const mutationsBeforeLoad = mutationCountRef.current
    const load = async () => {
      try {
        const s = await invoke<Settings>('get_settings')
        if (cancelled) return
        if (mutationCountRef.current > mutationsBeforeLoad) return
        setSettings(s)
      } catch (err) {
        if (cancelled) return
        if (mutationCountRef.current > mutationsBeforeLoad) return
        setError(`Could not load settings: ${toMessage(err)}`)
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
    bumpMutations()
    try {
      await invoke('save_settings', { settings: s })
      setSettings(s)
      setError(null)
    } catch (err) {
      setError(`Could not save settings: ${toMessage(err)}`)
    }
  }, [])

  const resetSettings = useCallback(async (): Promise<Settings | null> => {
    bumpMutations()
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
    } catch (err) {
      console.error('Folder picker failed:', err)
      return null
    }
  }, [])

  return { settings, loading, error, saveSettings, resetSettings, browseFolder }
}