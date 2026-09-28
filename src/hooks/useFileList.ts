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

export function useFileList() {
  const [files, setFiles] = useState<FileEntry[]>([])

  const addFiles = useCallback(async (paths: string[]) => {
    const newEntries = await invoke<FileEntry[]>('add_files', { filePaths: paths })
    setFiles((prev) => [...prev, ...newEntries])
    return newEntries
  }, [])

  const browseFiles = useCallback(async () => {
    const selected = await open({
      multiple: true,
      filters: [],
    })
    if (!selected) return
    const paths = Array.isArray(selected) ? selected : [selected]
    await addFiles(paths)
  }, [addFiles])

  const removeFile = useCallback(async (fileId: string) => {
    await invoke('remove_file', { fileId })
    setFiles((prev) => prev.filter((f) => f.id !== fileId))
  }, [])

  const clearList = useCallback(async () => {
    await invoke('clear_list')
    setFiles([])
  }, [])

  return { files, addFiles, browseFiles, removeFile, clearList }
}