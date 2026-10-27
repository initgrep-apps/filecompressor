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

import { useMemo, type ReactElement } from "react"
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table"
import { invoke } from "@tauri-apps/api/core"
import { toast } from "sonner"
import { Ellipsis, Folder, FolderOpen } from "lucide-react"
import type { FileStatus, HistoryFile, HistorySession } from "@/types"
import { formatSize } from "@/lib/sizeFormat"
import { CATEGORY_TONES, STATUS_TONES } from "@/lib/tokens"
import { cn } from "@/lib/utils"
import { CategoryIcon } from "@/components/CategoryIcon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

const STATUS_LABELS: Record<FileStatus, string> = {
  pending: "Pending",
  compressing: "Compressing",
  done: "Done",
  best_effort: "Best effort",
  failed: "Failed",
  cancelled: "Cancelled",
  unsupported: "Unsupported",
  already_under_target: "Already under target",
}

const MUTED_TONE = {
  tint: "bg-muted",
  text: "text-muted-foreground",
  border: "border-border",
  accent: "bg-muted-foreground",
}

function toastOpenError(err: unknown, prefix: string) {
  const message = String(err)
  const alreadyLabeled = /^Could not (reveal file|open folder)/.test(message)
  toast.error(alreadyLabeled ? message : `${prefix}: ${message}`)
}

async function revealFile(filePath: string) {
  try {
    await invoke("reveal_in_folder", { filePath })
  } catch (err) {
    console.error("reveal_in_folder failed:", err)
    toastOpenError(err, "Could not reveal file")
  }
}

function StatusMarker({ status }: { status: FileStatus }) {
  const tone = STATUS_TONES[status] ?? MUTED_TONE
  return (
    <Badge variant="secondary" className={`${tone.tint} ${tone.border} ${tone.text}`}>
      <span className={`size-1.5 rounded-full ${tone.accent}`} />
      {STATUS_LABELS[status] ?? status}
    </Badge>
  )
}

function fileMethod(file: HistoryFile): string {
  return (
    file.strategyUsed ??
    (file.qualityUsed !== null ? `quality ${file.qualityUsed}` : null) ??
    "—"
  )
}

export function HistoryFilesTable({
  session,
}: {
  session: HistorySession
}): ReactElement {
  const data = session.files
  const columns = useMemo<ColumnDef<HistoryFile>[]>(
    () => [
      {
        id: "file",
        header: "File",
        cell: ({ row }) => {
          const file = row.original
          const tone = CATEGORY_TONES[file.category] ?? MUTED_TONE
          return (
            <div className="flex items-center gap-3">
              <span
                className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${tone.tint} ${tone.text}`}
              >
                <CategoryIcon category={file.category} size={14} />
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium" title={file.name}>
                  {file.name}
                </div>
                {file.error !== null && (
                  <div
                    className="truncate text-xs text-destructive"
                    title={file.error}
                  >
                    {file.error}
                  </div>
                )}
              </div>
            </div>
          )
        },
      },
      {
        id: "size",
        header: "Size",
        cell: ({ row }) => {
          const file = row.original
          return (
            <span className="tabular-nums">
              {formatSize(file.originalSize)} →{" "}
              {file.compressedSize === null
                ? "—"
                : formatSize(file.compressedSize)}
            </span>
          )
        },
      },
      {
        id: "method",
        header: "Method",
        cell: ({ row }) => {
          const file = row.original
          return (
            <span className="text-muted-foreground">{fileMethod(file)}</span>
          )
        },
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => <StatusMarker status={row.original.status} />,
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const file = row.original
          return (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="File actions"
                  />
                }
              >
                <Ellipsis />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  disabled={file.outputPath === null}
                  onClick={() =>
                    file.outputPath && void revealFile(file.outputPath)
                  }
                >
                  <FolderOpen />
                  Show compressed
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => void revealFile(file.path)}
                >
                  <Folder />
                  Show original
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        },
      },
    ],
    []
  )

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  const columnWidths: Record<string, string> = {
    file: "w-[38%]",
    size: "w-[15%]",
    method: "w-[20%]",
    status: "w-[15%]",
    actions: "w-12",
  }

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border bg-card">
      <div className="min-h-0 flex-1 overflow-auto">
        <Table className="overflow-visible" tableClassName="min-w-[640px] table-fixed">
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={cn(
                      "sticky top-0 z-10 bg-card",
                      columnWidths[header.column.id]
                    )}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(
                      cell.column.columnDef.cell,
                      cell.getContext()
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
