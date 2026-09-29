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

import { useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { FileEntry } from '@/types'

const toMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

export function useFileList() {
  const [files, setFiles] = useState<FileEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  const addFiles = useCallback(async (paths: string[]) => {
    try {
      const newEntries = await invoke<FileEntry[]>('add_files', { filePaths: paths })
      setFiles((prev) => [...prev, ...newEntries])
      setError(null)
    } catch (err) {
      setError(`Could not add files: ${toMessage(err)}`)
    }
  }, [])

  const browseFiles = useCallback(async () => {
    try {
      const selected = await open({ multiple: true, filters: [] })
      if (!selected) return
      const paths = Array.isArray(selected) ? selected : [selected]
      await addFiles(paths)
    } catch (err) {
      setError(`Could not open file picker: ${toMessage(err)}`)
    }
  }, [addFiles])

  const removeFile = useCallback(async (fileId: string) => {
    try {
      await invoke('remove_file', { fileId })
      setFiles((prev) => prev.filter((f) => f.id !== fileId))
      setError(null)
    } catch (err) {
      setError(`Could not remove file: ${toMessage(err)}`)
    }
  }, [])

  const clearList = useCallback(async () => {
    try {
      await invoke('clear_list')
      setFiles([])
      setError(null)
    } catch (err) {
      setError(`Could not clear list: ${toMessage(err)}`)
    }
  }, [])

  return { files, error, addFiles, browseFiles, removeFile, clearList, setFiles }
}