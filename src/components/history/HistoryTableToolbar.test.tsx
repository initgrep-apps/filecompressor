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

import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HistoryTableToolbar } from "@/components/history/HistoryTableToolbar"

const counts = { all: 13, attention: 2, done: 7, underTarget: 4 }

function renderToolbar(overrides: Partial<Parameters<typeof HistoryTableToolbar>[0]> = {}) {
  const props = {
    search: "",
    onSearchChange: vi.fn(),
    type: "all" as const,
    onTypeChange: vi.fn(),
    outcome: "all" as const,
    onOutcomeChange: vi.fn(),
    counts,
    visibleCount: 13,
    totalCount: 13,
    onClear: vi.fn(),
    ...overrides,
  }
  return { ...render(<HistoryTableToolbar {...props} />), props }
}

describe("HistoryTableToolbar", () => {
  it("renders search, type filter, count and outcome chips", () => {
    renderToolbar()

    expect(screen.getByRole("searchbox", { name: "Search files" })).toHaveAttribute(
      "placeholder",
      "Search files…"
    )
    const typeFilter = screen.getByRole("combobox", { name: "Filter by type" })
    expect(typeFilter).toHaveAttribute("data-slot", "select-trigger")
    expect(typeFilter).toHaveTextContent("All types")
    expect(screen.getByTestId("history-table-count")).toHaveTextContent("13 of 13")
    expect(screen.getByRole("button", { name: /^All/ })).toHaveTextContent("13")
    expect(screen.getByRole("button", { name: /Needs attention/ })).toHaveTextContent("2")
    expect(screen.getByRole("button", { name: /^Done/ })).toHaveTextContent("7")
    expect(screen.getByRole("button", { name: /Under target/ })).toHaveTextContent("4")
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument()
  })

  it("calls search, type and outcome handlers", async () => {
    const user = userEvent.setup()
    const { props } = renderToolbar()

    fireEvent.change(screen.getByRole("searchbox", { name: "Search files" }), {
      target: { value: "png" },
    })
    expect(props.onSearchChange).toHaveBeenLastCalledWith("png")

    await user.click(screen.getByRole("combobox", { name: "Filter by type" }))
    await user.click(await screen.findByRole("option", { name: "PDF" }))
    expect(props.onTypeChange).toHaveBeenCalledWith("pdf")

    await user.click(screen.getByRole("button", { name: /^Done/ }))
    expect(props.onOutcomeChange).toHaveBeenCalledWith("done")
  })

  it("marks the active chip and calls Clear", async () => {
    const user = userEvent.setup()
    const { props } = renderToolbar({ outcome: "attention" })

    expect(screen.getByRole("button", { name: /Needs attention/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    expect(screen.getByRole("button", { name: /^All/ })).toHaveAttribute(
      "aria-pressed",
      "false"
    )

    await user.click(screen.getByRole("button", { name: "Clear" }))
    expect(props.onClear).toHaveBeenCalledTimes(1)
  })

  it("does not render or capture the / shortcut", () => {
    renderToolbar()
    const search = screen.getByRole("searchbox", { name: "Search files" })

    expect(screen.queryByText("/")).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: "/" })
    expect(search).not.toHaveFocus()
  })

  it("clears search with Escape", () => {
    const { props } = renderToolbar({ search: "png" })
    const search = screen.getByRole("searchbox", { name: "Search files" })

    fireEvent.keyDown(search, { key: "Escape" })
    expect(props.onSearchChange).toHaveBeenCalledWith("")
  })

  it("keeps the Needs attention chip neutral with an amber dot and count", () => {
    renderToolbar()
    const chip = screen.getByRole("button", { name: /Needs attention/ })

    expect(chip.className).not.toContain("bg-amber")
    expect(chip.querySelector(".bg-amber-500")).not.toBeNull()
    expect(chip.querySelector(".text-amber-600")).not.toBeNull()
  })

  it("shows the filtered count when filters reduce the rows", () => {
    renderToolbar({ visibleCount: 2, totalCount: 13 })
    expect(screen.getByTestId("history-table-count")).toHaveTextContent("2 of 13")
  })
})
