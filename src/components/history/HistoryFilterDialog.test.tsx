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

import { useState } from "react"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { startOfDay, subDays } from "date-fns"
import { HistoryFilterDialog } from "@/components/history/HistoryFilterDialog"
import type { HistoryFilters } from "@/types"

const NEWEST: HistoryFilters = { sort: "newest" }

const button = (name: string) => screen.getByRole("button", { name })

function setup(applied: HistoryFilters = NEWEST) {
  const onApply = vi.fn()
  const onOpenChange = vi.fn()
  render(
    <HistoryFilterDialog
      open
      onOpenChange={onOpenChange}
      applied={applied}
      onApply={onApply}
    />,
  )
  return { onApply, onOpenChange }
}

function ControlledDialog({ onApply }: { onApply: (next: HistoryFilters) => void }) {
  const [open, setOpen] = useState(true)
  const [applied, setApplied] = useState<HistoryFilters>(NEWEST)

  return (
    <>
      <button onClick={() => setOpen(true)}>Open filters</button>
      <HistoryFilterDialog
        open={open}
        onOpenChange={setOpen}
        applied={applied}
        onApply={(next) => {
          setApplied(next)
          onApply(next)
        }}
      />
    </>
  )
}

afterEach(() => {
  vi.useRealTimers()
})

describe("HistoryFilterDialog", () => {
  it("renders exactly two sort segments with the applied sort pressed", () => {
    setup()

    expect(button("Newest first")).toHaveAttribute("aria-pressed", "true")
    expect(button("Oldest first")).toHaveAttribute("aria-pressed", "false")
  })

  it("keeps a sort set when the pressed segment is clicked again", () => {
    setup({ sort: "oldest" })

    fireEvent.click(button("Oldest first"))

    expect(button("Oldest first")).toHaveAttribute("aria-pressed", "true")
  })

  it("toggles statuses independently and counts the active filters", () => {
    const { onApply } = setup()

    fireEvent.click(button("Cancelled"))
    expect(button("Cancelled")).toHaveAttribute("aria-pressed", "true")
    expect(button("Done")).toHaveAttribute("aria-pressed", "false")

    fireEvent.click(button("Done"))
    expect(button("Done")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByText("2 active")).toBeInTheDocument()

    fireEvent.click(button("Apply"))
    expect(onApply).toHaveBeenCalledWith({
      sort: "newest",
      statuses: ["cancelled", "done"],
    })
  })

  it("renders five category chips with the shared glyphs", () => {
    setup()

    const categories = [
      ["Image", "image"],
      ["Video", "video"],
      ["PDF", "pdf"],
      ["Document", "document"],
      ["Other", "other"],
    ] as const

    for (const [label, category] of categories) {
      const chip = button(label)
      expect(chip.querySelector(`[data-category="${category}"]`)).not.toBeNull()
    }
  })

  it("toggles Image and Other", () => {
    const { onApply } = setup()

    fireEvent.click(button("Image"))
    fireEvent.click(button("Other"))

    expect(button("Image")).toHaveAttribute("aria-pressed", "true")
    expect(button("Other")).toHaveAttribute("aria-pressed", "true")
    expect(button("Video")).toHaveAttribute("aria-pressed", "false")

    fireEvent.click(button("Apply"))
    expect(onApply).toHaveBeenCalledWith({
      sort: "newest",
      categories: ["image", "other"],
    })
  })

  it("sets sinceMs to the start of the day six days ago for Last 7 days", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const now = new Date(2026, 9, 23, 14, 30)
    vi.setSystemTime(now)
    const { onApply } = setup()

    fireEvent.click(button("All time"))
    fireEvent.click(button("Last 7 days"))

    expect(
      within(
        screen.getByRole("dialog", { name: "Filter history" }),
      ).getByRole("button", {
        name: "Last 7 days",
      }),
    ).toBeInTheDocument()
    fireEvent.click(button("Apply"))
    expect(onApply).toHaveBeenCalledWith({
      sort: "newest",
      sinceMs: startOfDay(subDays(now, 6)).getTime(),
    })
  })

  it("maps a custom calendar date to that day's start", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(2026, 9, 23, 14, 30))
    const { onApply } = setup()

    fireEvent.click(button("All time"))
    const cell = document.querySelector('[data-day="2026-10-16"]')
    expect(cell).not.toBeNull()
    fireEvent.click(cell!.querySelector("button")!)

    fireEvent.click(button("Apply"))
    expect(onApply).toHaveBeenCalledWith({
      sort: "newest",
      sinceMs: new Date(2026, 9, 16).getTime(),
    })
  })

  it("applies the draft and closes", () => {
    const { onApply, onOpenChange } = setup()

    fireEvent.click(button("Oldest first"))
    fireEvent.click(button("Done"))
    fireEvent.click(button("Apply"))

    expect(onApply).toHaveBeenCalledWith({
      sort: "oldest",
      statuses: ["done"],
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("closes from the title-row close button", () => {
    const { onApply, onOpenChange } = setup()

    fireEvent.click(button("Close"))

    expect(onApply).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything())
  })

  it("discards the draft on Cancel", () => {
    const { onApply, onOpenChange } = setup()

    fireEvent.click(button("Done"))
    fireEvent.click(button("Cancel"))

    expect(onApply).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("clears only the draft on Clear all", () => {
    const { onApply, onOpenChange } = setup({
      sort: "oldest",
      statuses: ["done"],
      categories: ["image"],
      sinceMs: 1_790_000_000_000,
    })

    fireEvent.click(button("Clear all"))

    expect(button("Newest first")).toHaveAttribute("aria-pressed", "true")
    expect(button("Oldest first")).toHaveAttribute("aria-pressed", "false")
    expect(button("Done")).toHaveAttribute("aria-pressed", "false")
    expect(button("Image")).toHaveAttribute("aria-pressed", "false")
    expect(button("All time")).toBeInTheDocument()
    expect(onApply).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()

    fireEvent.click(button("Apply"))
    expect(onApply).toHaveBeenCalledWith({ sort: "newest" })
  })

  it("seeds the draft from the applied filters on reopen", () => {
    const onApply = vi.fn()
    render(<ControlledDialog onApply={onApply} />)

    fireEvent.click(button("Oldest first"))
    fireEvent.click(button("Image"))
    fireEvent.click(button("Apply"))

    fireEvent.click(button("Open filters"))

    expect(button("Oldest first")).toHaveAttribute("aria-pressed", "true")
    expect(button("Newest first")).toHaveAttribute("aria-pressed", "false")
    expect(button("Image")).toHaveAttribute("aria-pressed", "true")
    expect(button("Video")).toHaveAttribute("aria-pressed", "false")
  })
})
