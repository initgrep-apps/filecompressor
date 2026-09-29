import { useEffect, useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
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
  onBatchComplete?: (totalSavedBytes: number, processedCount: number) => void
  onBatchError?: (errorMessage: string) => void
}

export function useCompression(
  files: FileEntry[],
  setFiles: Dispatch<SetStateAction<FileEntry[]>>,
  callbacks?: CompressionCallbacks
) {
  const [isCompressing, setIsCompressing] = useState(false)
  const [progressByFile, setProgressByFile] = useState<Record<string, number>>({})
  const processedCountRef = useRef(0)

  const filesRef = useRef(files)
  filesRef.current = files
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  useEffect(() => {
    const unlisteners: UnlistenFn[] = []
    const done = (u: UnlistenFn) => unlisteners.push(u)

    listen<ProgressPayload>('file:progress', (e) => {
      const { fileId, percent } = e.payload
      if (!filesRef.current.some((f) => f.id === fileId)) return
      setProgressByFile((prev) => ({ ...prev, [fileId]: percent }))
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId && f.status === 'pending' ? { ...f, status: 'compressing' } : f
        )
      )
    }).then(done)

    listen<CompletePayload>('file:complete', (e) => {
      const { fileId, outputPath, compressedSize, status } = e.payload
      processedCountRef.current += 1
      setProgressByFile((prev) => {
        const next = { ...prev }
        delete next[fileId]
        return next
      })
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? { ...f, status, compressedSize, outputPath }
            : f
        )
      )
    }).then(done)

    listen<ErrorPayload>('file:error', (e) => {
      const { fileId, errorMessage } = e.payload
      processedCountRef.current += 1
      setProgressByFile((prev) => {
        const next = { ...prev }
        delete next[fileId]
        return next
      })
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId ? { ...f, status: 'failed', error: errorMessage } : f
        )
      )
    }).then(done)

    listen<CancelledPayload>('file:cancelled', (e) => {
      const { fileId } = e.payload
      processedCountRef.current += 1
      setProgressByFile((prev) => {
        const next = { ...prev }
        delete next[fileId]
        return next
      })
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId ? { ...f, status: 'cancelled' } : f
        )
      )
    }).then(done)

    listen<BatchCompletePayload>('batch:complete', (e) => {
      setIsCompressing(false)
      const processed = processedCountRef.current
      processedCountRef.current = 0
      callbacksRef.current?.onBatchComplete?.(e.payload.totalSavedBytes, processed)
    }).then(done)

    listen<BatchErrorPayload>('batch:error', (e) => {
      setIsCompressing(false)
      processedCountRef.current = 0
      callbacksRef.current?.onBatchError?.(e.payload.errorMessage)
    }).then(done)

    return () => {
      unlisteners.forEach((u) => u())
    }
  }, [setFiles])

  const compressAll = useCallback(async () => {
    const pendingCount = filesRef.current.filter((f) => f.status === 'pending').length
    if (pendingCount === 0) return
    setIsCompressing(true)
    await invoke('compress_all')
  }, [])

  const cancelFile = useCallback(async (fileId: string) => {
    await invoke('cancel_file', { fileId })
  }, [])

  const cancelAll = useCallback(async () => {
    await invoke('cancel_all')
  }, [])

  const revealInFolder = useCallback(async (filePath: string) => {
    await invoke('reveal_in_folder', { filePath })
  }, [])

  return { isCompressing, progressByFile, compressAll, cancelFile, cancelAll, revealInFolder }
}
