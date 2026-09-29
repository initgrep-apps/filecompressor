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

import { useFileList } from '@/hooks/useFileList'
import { useCompression } from '@/hooks/useCompression'
import { DropZone } from '@/components/DropZone'
import { FileList, formatSize, RESULT_STATUSES } from '@/components/FileList'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

function formatSavedBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  return formatSize(bytes)
}

export function CompressView() {
  const { files, error, addFiles, browseFiles, removeFile, clearList, setFiles } = useFileList()
  const {
    isCompressing,
    progressByFile,
    compressAll,
    cancelFile,
    cancelAll,
    revealInFolder,
  } = useCompression(files, setFiles, {
    onBatchComplete: (saved, count) =>
      toast.success(`Compressed ${count} files. Saved ${formatSavedBytes(saved)} total.`),
    onBatchError: (message) => toast.error(message),
  })

  const hasFiles = files.length > 0
  const pendingCount = files.filter((f) => f.status === 'pending').length
  const doneCount = files.filter((f) => RESULT_STATUSES.includes(f.status)).length
  const canCompress = pendingCount > 0 && !isCompressing

  return (
    <div className="flex flex-1 flex-col gap-3.5 p-5 min-h-0 overflow-hidden">
      <div className="flex items-center justify-between shrink-0">
        <h1 className="text-base font-semibold">Compress Files</h1>
        <span className="text-xs text-muted-foreground">Drag files into the area below</span>
      </div>

      {error && (
        <div
          role="alert"
          className="shrink-0 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </div>
      )}

      <DropZone onBrowse={browseFiles} onDrop={addFiles} className="shrink-0" />

      {hasFiles && (
        <>
          <div className="flex gap-2 shrink-0">
            <Button className="flex-1" onClick={compressAll} disabled={!canCompress}>
              Compress
            </Button>
            {isCompressing && (
              <Button variant="destructive" onClick={cancelAll}>
                Cancel All
              </Button>
            )}
          </div>
          <FileList
            files={files}
            onRemove={removeFile}
            progress={progressByFile}
            onReveal={revealInFolder}
            onCancel={cancelFile}
            removeDisabled={isCompressing}
          />
          <div className="flex justify-between items-center pt-0.5 shrink-0">
            <span className="text-xs text-muted-foreground">
              <strong className="text-foreground font-semibold">{files.length} files</strong>
              <span className="ml-2 tabular-nums">
                {doneCount} done · {pendingCount} pending
              </span>
            </span>
            <Button variant="ghost" size="sm" onClick={clearList} disabled={isCompressing}>
              Clear List
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
