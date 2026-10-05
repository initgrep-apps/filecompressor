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

import { useEffect, useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { toast } from 'sonner'
import type { FileEntry, FileStatus } from '@/types'

interface ProgressPayload {
  fileId: string
  percent: number
}

interface CompletePayload {
  fileId: string
  outputPath: string
  originalSize: number
  compressedSize: number
  status: FileStatus
  metTarget: boolean
  strategyUsed?: string | null
  qualityUsed?: number | null
}

interface ErrorPayload {
  fileId: string
  errorMessage: string
}

interface CancelledPayload {
  fileId: string
}

interface BatchCompletePayload {
  batchId: string
  totalSavedBytes: number
}

interface BatchErrorPayload {
  batchId: string
  errorMessage: string
}

export interface CompressionCallbacks {
  onBatchComplete?: (totalSavedBytes: number, processedCount: number, errorCount: number) => void
  onBatchError?: (errorMessage: string) => void
}

const toMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

export function useCompression(
  files: FileEntry[],
  setFiles: Dispatch<SetStateAction<FileEntry[]>>,
  callbacks?: CompressionCallbacks
) {
  const [isCompressing, setIsCompressing] = useState(false)
  const [progressByFile, setProgressByFile] = useState<Record<string, number>>({})
  const processedCountRef = useRef(0)
  const errorCountRef = useRef(0)
  const cancelledRef = useRef(false)

  const filesRef = useRef(files)
  filesRef.current = files
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  useEffect(() => {
    let disposed = false
    const unlisteners: UnlistenFn[] = []
    const done = (u: UnlistenFn) => {
      if (disposed) {
        u()
      } else {
        unlisteners.push(u)
      }
    }
    const dropProgress = (fileId: string) =>
      setProgressByFile((prev) => {
        if (!(fileId in prev)) return prev
        const next = { ...prev }
        delete next[fileId]
        return next
      })
    const reportListenFailure = (event: string) => (err: unknown) => {
      console.error(`event listener registration failed: ${event}`, err)
      callbacksRef.current?.onBatchError?.('Lost connection to compression worker')
    }

    listen<ProgressPayload>('file:progress', (e) => {
      const { fileId, percent } = e.payload
      const file = filesRef.current.find((f) => f.id === fileId)
      if (!file) return
      if (file.status !== 'pending' && file.status !== 'compressing') return
      setProgressByFile((prev) => ({ ...prev, [fileId]: percent }))
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId && f.status === 'pending' ? { ...f, status: 'compressing' } : f
        )
      )
    })
      .then(done)
      .catch(reportListenFailure('file:progress'))

    listen<CompletePayload>('file:complete', (e) => {
      const { fileId, outputPath, compressedSize, status, strategyUsed = null, qualityUsed = null } = e.payload
      if (filesRef.current.some((f) => f.id === fileId)) {
        processedCountRef.current += 1
      }
      dropProgress(fileId)
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? { ...f, status, compressedSize, outputPath, strategyUsed, qualityUsed }
            : f
        )
      )
    })
      .then(done)
      .catch(reportListenFailure('file:complete'))

    listen<ErrorPayload>('file:error', (e) => {
      const { fileId, errorMessage } = e.payload
      if (filesRef.current.some((f) => f.id === fileId)) {
        processedCountRef.current += 1
        errorCountRef.current += 1
      }
      dropProgress(fileId)
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId ? { ...f, status: 'failed', error: errorMessage } : f
        )
      )
    })
      .then(done)
      .catch(reportListenFailure('file:error'))

    listen<CancelledPayload>('file:cancelled', (e) => {
      const { fileId } = e.payload
      dropProgress(fileId)
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId ? { ...f, status: 'cancelled' } : f
        )
      )
    })
      .then(done)
      .catch(reportListenFailure('file:cancelled'))

    listen<BatchCompletePayload>('batch:complete', (e) => {
      setIsCompressing(false)
      const processed = processedCountRef.current
      const errors = errorCountRef.current
      processedCountRef.current = 0
      errorCountRef.current = 0
      if (cancelledRef.current) {
        toast.info('Batch cancelled')
        cancelledRef.current = false
      }
      if (processed > 0) {
        callbacksRef.current?.onBatchComplete?.(e.payload.totalSavedBytes, processed, errors)
      }
    })
      .then(done)
      .catch(reportListenFailure('batch:complete'))

    listen<BatchErrorPayload>('batch:error', (e) => {
      setIsCompressing(false)
      processedCountRef.current = 0
      errorCountRef.current = 0
      if (cancelledRef.current) {
        toast.info('Batch cancelled')
        cancelledRef.current = false
      }
      callbacksRef.current?.onBatchError?.(e.payload.errorMessage)
    })
      .then(done)
      .catch(reportListenFailure('batch:error'))

    return () => {
      disposed = true
      unlisteners.forEach((u) => u())
    }
  }, [setFiles])

  const compressAll = useCallback(async () => {
    const pendingCount = filesRef.current.filter((f) => f.status === 'pending').length
    if (pendingCount === 0) return
    setIsCompressing(true)
    cancelledRef.current = false
    try {
      const batchId = await invoke<string>('compress_all')
      if (batchId === '') {
        setIsCompressing(false)
        callbacksRef.current?.onBatchError?.('No pending files')
      }
    } catch (err) {
      setIsCompressing(false)
      callbacksRef.current?.onBatchError?.(toMessage(err))
    }
  }, [])

  const cancelFile = useCallback(async (fileId: string) => {
    try {
      await invoke('cancel_file', { fileId })
    } catch (err) {
      toast.error(`Could not cancel file: ${toMessage(err)}`)
    }
  }, [])

  const cancelAll = useCallback(async () => {
    try {
      await invoke('cancel_all')
      cancelledRef.current = true
    } catch (err) {
      toast.error(`Could not cancel: ${toMessage(err)}`)
    }
  }, [])

  const revealInFolder = useCallback(async (filePath: string) => {
    try {
      await invoke('reveal_in_folder', { filePath })
    } catch (err) {
      toast.error(`Could not open folder: ${toMessage(err)}`)
    }
  }, [])

  return { isCompressing, progressByFile, compressAll, cancelFile, cancelAll, revealInFolder }
}
