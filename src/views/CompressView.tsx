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
import { DropZone } from '@/components/DropZone'
import { FileList } from '@/components/FileList'
import { Button } from '@/components/ui/button'

export function CompressView() {
  const { files, error, addFiles, browseFiles, removeFile, clearList } = useFileList()

  const hasFiles = files.length > 0

  const handleBrowse = () => {
    browseFiles().catch(() => {})
  }
  const handleDrop = (paths: string[]) => {
    addFiles(paths).catch(() => {})
  }
  const handleRemove = (id: string) => {
    removeFile(id).catch(() => {})
  }
  const handleClear = () => {
    clearList().catch(() => {})
  }

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

      <DropZone onBrowse={handleBrowse} onDrop={handleDrop} className="shrink-0" />

      {hasFiles && (
        <>
          <FileList files={files} onRemove={handleRemove} />
          <div className="flex justify-between items-center pt-0.5 shrink-0">
            <span className="text-xs text-muted-foreground">
              <strong className="text-foreground font-semibold">{files.length} files</strong>
            </span>
            <Button variant="ghost" size="sm" onClick={handleClear}>
              Clear List
            </Button>
          </div>
        </>
      )}
    </div>
  )
}