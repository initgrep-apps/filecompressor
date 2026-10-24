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

import { useEffect, useRef, useState } from "react"
import {
  RiArrowDownSLine,
  RiCalendarLine,
  RiCloseLine,
} from "@remixicon/react"
import { startOfDay, startOfMonth, subDays, subMonths } from "date-fns"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FieldLegend, FieldSet } from "@/components/ui/field"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { CategoryIcon } from "@/components/CategoryIcon"
import { describeSince } from "@/lib/historyFormat"
import { CATEGORY_TONES, STATUS_TONES } from "@/lib/tokens"
import { cn } from "@/lib/utils"
import type { Category, FileStatus, HistoryFilters } from "@/types"

const STATUS_CHOICES: readonly { value: FileStatus; label: string }[] = [
  { value: "done", label: "Done" },
  { value: "best_effort", label: "Best effort" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "already_under_target", label: "Already under target" },
  { value: "unsupported", label: "Unsupported" },
]

const CATEGORY_CHOICES: readonly { value: Category; label: string }[] = [
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
  { value: "pdf", label: "PDF" },
  { value: "document", label: "Document" },
  { value: "other", label: "Other" },
]

const SINCE_PRESETS = [
  { value: "all", label: "All time" },
  { value: "today", label: "Today" },
  { value: "last7", label: "Last 7 days" },
  { value: "last30", label: "Last 30 days" },
  { value: "month", label: "This month" },
  { value: "last3months", label: "Last 3 months" },
] as const

type SincePreset = (typeof SINCE_PRESETS)[number]["value"]

function presetSince(preset: SincePreset, now: Date): number | undefined {
  switch (preset) {
    case "all":
      return undefined
    case "today":
      return startOfDay(now).getTime()
    case "last7":
      return startOfDay(subDays(now, 6)).getTime()
    case "last30":
      return startOfDay(subDays(now, 29)).getTime()
    case "month":
      return startOfMonth(now).getTime()
    case "last3months":
      return startOfDay(subMonths(now, 3)).getTime()
  }
}

function activeFilterCount(filters: HistoryFilters): number {
  return (
    (filters.statuses?.length ?? 0) +
    (filters.categories?.length ?? 0) +
    (filters.sinceMs !== undefined ? 1 : 0) +
    (filters.sort !== undefined && filters.sort !== "newest" ? 1 : 0)
  )
}

interface HistoryFilterDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  applied: HistoryFilters
  onApply: (filters: HistoryFilters) => void
}

export function HistoryFilterDialog({
  open,
  onOpenChange,
  applied,
  onApply,
}: HistoryFilterDialogProps) {
  const [draft, setDraft] = useState<HistoryFilters>({ sort: "newest" })
  const [sinceOpen, setSinceOpen] = useState(false)
  const wasOpen = useRef(false)

  useEffect(() => {
    if (open && !wasOpen.current) {
      setDraft({ ...applied })
      setSinceOpen(false)
    }
    wasOpen.current = open
  }, [open, applied])

  const update = (patch: Partial<HistoryFilters>) =>
    setDraft((current) => ({ ...current, ...patch }))

  const now = new Date()
  const sortValue = draft.sort === "oldest" ? "oldest" : "newest"
  const activeCount = activeFilterCount(draft)

  const apply = () => {
    onApply(draft)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[90%] gap-0 overflow-hidden p-0 sm:max-w-[600px]"
      >
        <DialogHeader className="flex h-[54px] shrink-0 flex-row items-center gap-2.5 border-b border-border px-5">
          <DialogTitle>Filter history</DialogTitle>
          {activeCount > 0 && (
            <Badge
              variant="secondary"
              className={cn(
                "border",
                STATUS_TONES.done.tint,
                STATUS_TONES.done.border,
                STATUS_TONES.done.text,
              )}
            >
              {activeCount} active
            </Badge>
          )}
          <DialogClose
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto"
                aria-label="Close"
                title="Close"
              />
            }
          >
            <RiCloseLine />
          </DialogClose>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto px-5">
          <FieldSet className="min-w-0 gap-2.5 border-b border-border py-3">
            <FieldLegend className="mb-0 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Sort by
            </FieldLegend>
            <ToggleGroup
              value={[sortValue]}
              onValueChange={(value) => update({ sort: value[0] ?? sortValue })}
              className="w-full rounded-xl border border-border bg-muted/40 p-0.5"
            >
              <ToggleGroupItem value="newest" size="sm" className="flex-1">
                Newest first
              </ToggleGroupItem>
              <ToggleGroupItem value="oldest" size="sm" className="flex-1">
                Oldest first
              </ToggleGroupItem>
            </ToggleGroup>
          </FieldSet>

          <FieldSet className="min-w-0 gap-2.5 border-b border-border py-3">
            <FieldLegend className="mb-0 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Status
            </FieldLegend>
            <ToggleGroup
              multiple
              value={draft.statuses ?? []}
              onValueChange={(value) =>
                update({ statuses: value.length > 0 ? value : undefined })
              }
              className="flex w-full flex-wrap gap-1.5"
            >
              {STATUS_CHOICES.map(({ value, label }) => (
                <ToggleGroupItem
                  key={value}
                  value={value}
                  variant="outline"
                  size="sm"
                  className="rounded-full px-3"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      STATUS_TONES[value].accent,
                    )}
                  />
                  {label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </FieldSet>

          <FieldSet className="min-w-0 gap-2.5 border-b border-border py-3">
            <FieldLegend className="mb-0 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Category
            </FieldLegend>
            <ToggleGroup
              multiple
              value={draft.categories ?? []}
              onValueChange={(value) =>
                update({ categories: value.length > 0 ? value : undefined })
              }
              className="flex w-full flex-wrap gap-1.5"
            >
              {CATEGORY_CHOICES.map(({ value, label }) => (
                <ToggleGroupItem
                  key={value}
                  value={value}
                  variant="outline"
                  size="sm"
                  className="rounded-full px-3"
                >
                  <CategoryIcon
                    category={value}
                    className={CATEGORY_TONES[value].text}
                  />
                  {label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </FieldSet>

          <FieldSet className="min-w-0 gap-2.5 py-3">
            <FieldLegend className="mb-0 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Since
            </FieldLegend>
            <Popover open={sinceOpen} onOpenChange={setSinceOpen}>
              <PopoverTrigger
                render={
                  <Button
                    variant="outline"
                    className="w-full justify-start gap-2 font-normal"
                  />
                }
              >
                <RiCalendarLine aria-hidden="true" />
                {describeSince(draft.sinceMs, now)}
                <RiArrowDownSLine className="ml-auto" aria-hidden="true" />
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-auto flex-row gap-0 p-0"
              >
                <div className="flex w-32 flex-col gap-0.5 border-r border-border p-1.5">
                  {SINCE_PRESETS.map((preset) => {
                    const active =
                      draft.sinceMs === presetSince(preset.value, now)
                    return (
                      <Button
                        key={preset.value}
                        variant={active ? "secondary" : "ghost"}
                        size="sm"
                        aria-pressed={active}
                        className="justify-start"
                        onClick={() => {
                          update({ sinceMs: presetSince(preset.value, now) })
                          setSinceOpen(false)
                        }}
                      >
                        {preset.label}
                      </Button>
                    )
                  })}
                </div>
                <Calendar
                  mode="single"
                  selected={
                    draft.sinceMs !== undefined
                      ? new Date(draft.sinceMs)
                      : undefined
                  }
                  onSelect={(date) => {
                    if (!date) return
                    update({ sinceMs: startOfDay(date).getTime() })
                    setSinceOpen(false)
                  }}
                />
              </PopoverContent>
            </Popover>
          </FieldSet>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-border px-5 py-3">
          <Button
            variant="ghost"
            onClick={() => setDraft({ sort: "newest" })}
          >
            Clear all
          </Button>
          <span className="flex-1" />
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={apply}>Apply</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
