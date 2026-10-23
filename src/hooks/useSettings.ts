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
import { toast } from 'sonner'
import type { Settings } from '@/types'

const PICKER_ERROR = 'Could not open folder picker'
const PICKER_ERROR_ID = 'settings-folder-picker'

const toMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return JSON.stringify(err)
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const lastErrorRef = useRef<string | null>(null)
  const mutationCountRef = useRef(0)
  const bumpMutations = () => {
    mutationCountRef.current += 1
  }
  const getLastError = useCallback(() => lastErrorRef.current, [])

  useEffect(() => {
    let cancelled = false
    const mutationsBeforeLoad = mutationCountRef.current
    const load = async () => {
      try {
        const s = await invoke<Settings>('get_settings')
        if (cancelled) return
        if (mutationCountRef.current > mutationsBeforeLoad) return
        lastErrorRef.current = null
        setSettings(s)
      } catch (err) {
        if (cancelled) return
        if (mutationCountRef.current > mutationsBeforeLoad) return
        const message = `Could not load settings: ${toMessage(err)}`
        lastErrorRef.current = message
        setError(message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const saveSettings = useCallback(async (s: Settings): Promise<boolean> => {
    bumpMutations()
    try {
      await invoke('save_settings', { settings: s })
      lastErrorRef.current = null
      setSettings(s)
      setError(null)
      return true
    } catch (err) {
      console.error('Save settings failed:', err)
      const message = `Could not save settings: ${toMessage(err)}`
      lastErrorRef.current = message
      setError(message)
      return false
    }
  }, [])

  const resetSettings = useCallback(async (): Promise<Settings | null> => {
    bumpMutations()
    try {
      const defaults = await invoke<Settings>('reset_settings')
      lastErrorRef.current = null
      setSettings(defaults)
      setError(null)
      return defaults
    } catch (err) {
      console.error('Reset settings failed:', err)
      const message = `Could not reset settings: ${toMessage(err)}`
      lastErrorRef.current = message
      setError(message)
      return null
    }
  }, [])

  const browseFolder = useCallback(async (): Promise<string | null> => {
    try {
      const selected = await open({ directory: true, multiple: false })
      return typeof selected === 'string' ? selected : null
    } catch (err) {
      console.error('Folder picker failed:', err)
      toast.error(PICKER_ERROR, {
        id: PICKER_ERROR_ID,
        description: toMessage(err),
      })
      return null
    }
  }, [])

  return {
    settings,
    loading,
    error,
    getLastError,
    saveSettings,
    resetSettings,
    browseFolder,
  }
}