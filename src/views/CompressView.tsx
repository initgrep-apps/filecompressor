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

import { useCompressionContext } from '@/providers/CompressionProvider'
import { DropZone } from '@/components/DropZone'
import { FileList } from '@/components/FileList'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { RiFileAddLine } from '@remixicon/react'
import type { FileStatus } from '@/types'

export function CompressView() {
  const {
    files,
    error,
    isCompressing,
    progressByFile,
    compressAll,
    cancelFile,
    cancelAll,
    revealInFolder,
    removeFile,
    clearList,
    addFiles,
    browseFiles,
  } = useCompressionContext()

  const pendingCount = files.filter((f) => f.status === 'pending').length
  const doneCount = files.filter(
    (f) => f.status === 'done' || f.status === 'already_under_target'
  ).length
  const canCompress = pendingCount > 0 && !isCompressing
  const hasFiles = files.length > 0

  const statusCount = (status: FileStatus) => files.filter((f) => f.status === status).length

  const summarySegments: string[] = [`${files.length} files`]
  if (doneCount > 0) summarySegments.push(`${doneCount} done`)
  if (statusCount('compressing') > 0)
    summarySegments.push(`${statusCount('compressing')} compressing`)
  if (pendingCount > 0) summarySegments.push(`${pendingCount} pending`)
  if (statusCount('best_effort') > 0)
    summarySegments.push(`${statusCount('best_effort')} warning`)
  if (statusCount('unsupported') > 0)
    summarySegments.push(`${statusCount('unsupported')} skipped`)
  if (statusCount('failed') > 0) summarySegments.push(`${statusCount('failed')} failed`)
  if (statusCount('cancelled') > 0)
    summarySegments.push(`${statusCount('cancelled')} cancelled`)
  const summaryText = summarySegments.join(' · ')

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-hidden p-5">
      {error && (
        <div
          role="alert"
          className="shrink-0 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </div>
      )}

      <DropZone onBrowse={browseFiles} onDrop={addFiles} className="shrink-0" />

      {hasFiles ? (
        <Card className="flex min-h-0 flex-1 flex-col">
          <CardContent className="min-h-0 flex-1 p-0">
            <ScrollArea className="h-full">
              <FileList
                files={files}
                onRemove={removeFile}
                progress={progressByFile}
                onReveal={revealInFolder}
                onCancel={cancelFile}
                removeDisabled={isCompressing}
              />
            </ScrollArea>
          </CardContent>
          <CardFooter className="justify-between gap-2 border-t px-4">
            <div
              data-testid="batch-summary"
              className="text-xs text-muted-foreground tabular-nums"
            >
              {summaryText}
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={compressAll} disabled={!canCompress} aria-busy={isCompressing}>
                {isCompressing && <Spinner data-icon="inline-start" />}
                Compress
              </Button>
              {isCompressing && (
                <Button size="sm" variant="destructive" onClick={cancelAll}>
                  Cancel All
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={clearList}
                disabled={isCompressing}
              >
                Clear List
              </Button>
            </div>
          </CardFooter>
        </Card>
      ) : (
        <Card className="flex flex-1 flex-col justify-center">
          <CardContent>
            <Empty className="border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <RiFileAddLine />
                </EmptyMedia>
                <EmptyTitle>No files yet</EmptyTitle>
                <EmptyDescription>
                  Drop files above to get started.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
