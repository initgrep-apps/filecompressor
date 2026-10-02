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

import { Button } from '@/components/ui/button'
import { RiArrowLeftSLine, RiArrowRightSLine } from '@remixicon/react'

interface HistoryPaginationProps {
  page: number
  pageSize: number
  totalSessions: number
  onPageChange: (page: number) => void
}

export function HistoryPagination({
  page,
  pageSize,
  totalSessions,
  onPageChange,
}: HistoryPaginationProps) {
  const totalPages = Math.max(1, Math.ceil(totalSessions / Math.max(1, pageSize)))
  return (
    <div className="flex items-center justify-between border-t pt-3">
      <span className="text-xs text-muted-foreground tabular-nums">
        Page {page + 1} of {totalPages}
      </span>
      <div className="flex gap-1.5">
        <Button
          variant="outline"
          size="sm"
          aria-label="Previous page"
          disabled={page === 0}
          onClick={() => onPageChange(page - 1)}
        >
          <RiArrowLeftSLine data-icon="inline-start" />
          Prev
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label="Next page"
          disabled={page + 1 >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
          <RiArrowRightSLine data-icon="inline-end" />
        </Button>
      </div>
    </div>
  )
}
