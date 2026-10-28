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

import type { ReactElement } from "react"
import { Search } from "lucide-react"
import { CATEGORIES, type Category } from "@/types"
import type {
  HistoryOutcomeFilter,
  HistoryTypeFilter,
} from "@/lib/historyTable"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const CATEGORY_LABELS: Record<Category, string> = {
  image: "Image",
  video: "Video",
  pdf: "PDF",
  document: "Document",
  other: "Other",
}

const TYPE_ITEMS = [
  { value: "all", label: "All types" },
  ...CATEGORIES.map((category) => ({
    value: category,
    label: CATEGORY_LABELS[category],
  })),
]

const CHIP_BASE =
  "inline-flex h-[22px] items-center gap-[5px] rounded-full border px-2 text-[10.5px] whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
const CHIP_ACTIVE = "border-border bg-muted text-foreground"
const CHIP_INACTIVE =
  "border-border/60 bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground"

function OutcomeChip({
  label,
  count,
  active,
  onClick,
  testId,
  attention = false,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
  testId: string
  attention?: boolean
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      data-testid={testId}
      className={`${CHIP_BASE} ${active ? CHIP_ACTIVE : CHIP_INACTIVE}`}
      onClick={onClick}
    >
      {attention && (
        <span aria-hidden="true" className="size-[5px] rounded-full bg-amber-500" />
      )}
      {label}
      <span
        className={`tabular-nums ${
          attention ? "text-amber-600" : active ? "text-foreground" : "text-muted-foreground"
        }`}
      >
        {count}
      </span>
    </button>
  )
}

export interface HistoryTableToolbarProps {
  search: string
  onSearchChange: (value: string) => void
  type: HistoryTypeFilter
  onTypeChange: (value: HistoryTypeFilter) => void
  outcome: HistoryOutcomeFilter
  onOutcomeChange: (value: HistoryOutcomeFilter) => void
  counts: {
    all: number
    attention: number
    done: number
    underTarget: number
  }
  visibleCount: number
  totalCount: number
  onClear: () => void
}

export function HistoryTableToolbar({
  search,
  onSearchChange,
  type,
  onTypeChange,
  outcome,
  onOutcomeChange,
  counts,
  visibleCount,
  totalCount,
  onClear,
}: HistoryTableToolbarProps): ReactElement {
  const clearSearch = () => {
    if (search.length > 0) onSearchChange("")
  }

  return (
    <div data-testid="history-table-toolbar">
      <div className="flex flex-wrap items-center gap-[7px]">
        <div className="mr-0.5 inline-flex items-center gap-1.5 text-[12.5px] font-semibold">
          Files
        </div>

        <div className="relative min-w-[130px] flex-1 max-w-[300px] @max-[860px]:max-w-[220px]">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            aria-label="Search files"
            placeholder="Search files…"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                clearSearch()
              }
            }}
            className="h-7 w-full rounded-[7px] border border-border bg-background px-2.5 pl-7 text-[10.5px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </div>

        <Select
          items={TYPE_ITEMS}
          value={type}
          onValueChange={(value) => {
            if (value !== null) onTypeChange(value as HistoryTypeFilter)
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label="Filter by type"
            className="h-7 w-fit rounded-[7px] border-border bg-background px-2 text-[10.5px] [&_svg]:size-3"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start" className="min-w-[130px]">
            <SelectGroup>
              <SelectItem value="all">All types</SelectItem>
              {CATEGORIES.map((category) => (
                <SelectItem key={category} value={category}>
                  {CATEGORY_LABELS[category]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        <span
          data-testid="history-table-count"
          className="ml-auto text-[10px] whitespace-nowrap text-muted-foreground tabular-nums"
        >
          {visibleCount} of {totalCount}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-[5px]">
        <OutcomeChip
          label="All"
          count={counts.all}
          active={outcome === "all"}
          onClick={() => onOutcomeChange("all")}
          testId="history-chip-all"
        />
        <OutcomeChip
          label="Needs attention"
          count={counts.attention}
          active={outcome === "attention"}
          onClick={() => onOutcomeChange("attention")}
          testId="history-chip-attention"
          attention
        />
        <OutcomeChip
          label="Done"
          count={counts.done}
          active={outcome === "done"}
          onClick={() => onOutcomeChange("done")}
          testId="history-chip-done"
        />
        <OutcomeChip
          label="Under target"
          count={counts.underTarget}
          active={outcome === "under_target"}
          onClick={() => onOutcomeChange("under_target")}
          testId="history-chip-under"
        />
        <button
          type="button"
          aria-label="Clear"
          className="h-[22px] rounded-full px-1 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          onClick={onClear}
        >
          Clear
        </button>
      </div>
    </div>
  )
}
