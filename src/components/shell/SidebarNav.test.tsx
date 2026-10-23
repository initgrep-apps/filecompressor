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

import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const { compressionMock, historyMock } = vi.hoisted(() => ({
  compressionMock: vi.fn(),
  historyMock: vi.fn(),
}))

vi.mock("@/providers/CompressionProvider", () => ({
  useCompressionContext: compressionMock,
}))
vi.mock("@/providers/HistoryProvider", () => ({
  useHistoryContext: historyMock,
}))

import { SidebarNav } from "@/components/shell/SidebarNav"
import { SidebarContent, SidebarProvider } from "@/components/ui/sidebar"
import type { FileEntry, ViewId } from "@/types"

const makeEntry = (n: number): FileEntry => ({
  id: `f${n}`,
  name: `f${n}.jpg`,
  path: `/t/f${n}.jpg`,
  category: "image",
  targetBytes: 204800,
  originalSize: 1024,
  status: "pending",
  compressedSize: null,
  outputPath: null,
  error: null,
  strategyUsed: null,
  qualityUsed: null,
})

function renderNav({
  activeView = "compress",
  files = [],
  expanded = false,
}: {
  activeView?: ViewId
  files?: FileEntry[]
  expanded?: boolean
} = {}) {
  compressionMock.mockReturnValue({ files })
  const setExpanded = vi.fn()
  historyMock.mockReturnValue({ expanded, setExpanded })
  const onNavigate = vi.fn()
  const onOpenSettings = vi.fn()

  render(
    <SidebarProvider>
      <SidebarContent>
        <SidebarNav
          activeView={activeView}
          onNavigate={onNavigate}
          onOpenSettings={onOpenSettings}
        />
      </SidebarContent>
    </SidebarProvider>,
  )

  return { onNavigate, onOpenSettings, setExpanded }
}

beforeEach(() => {
  compressionMock.mockReset()
  historyMock.mockReset()
})

describe("SidebarNav", () => {
  it("renders Compress and History, with Settings only in the footer", () => {
    renderNav()

    expect(
      screen.getByRole("button", { name: /Compress/ }),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /History/ })).toBeInTheDocument()
    const settings = screen.getByTestId("nav-settings")
    expect(settings).toHaveTextContent("Settings")
    expect(settings.closest('[data-slot="sidebar-footer"]')).not.toBeNull()
  })

  it("opens Settings from the footer without navigating", async () => {
    const user = userEvent.setup()
    const { onNavigate, onOpenSettings } = renderNav()

    await user.click(screen.getByTestId("nav-settings"))

    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it("navigates to History without collapsing the list from another view", async () => {
    const user = userEvent.setup()
    const { onNavigate, setExpanded } = renderNav()

    await user.click(screen.getByRole("button", { name: /History/ }))

    expect(onNavigate).toHaveBeenCalledWith("history")
    expect(setExpanded).not.toHaveBeenCalled()
  })

  it("toggles the expanded list when History is already active", async () => {
    const user = userEvent.setup()
    const { onNavigate, setExpanded } = renderNav({
      activeView: "history",
      expanded: true,
    })
    const row = screen.getByTestId("nav-history")
    expect(row).toHaveAttribute("aria-expanded", "true")

    await user.click(row)

    expect(setExpanded).toHaveBeenCalledWith(false)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it("navigates to Compress", async () => {
    const user = userEvent.setup()
    const { onNavigate } = renderNav({ activeView: "history" })

    await user.click(screen.getByRole("button", { name: /Compress/ }))

    expect(onNavigate).toHaveBeenCalledWith("compress")
  })

  it("marks the active row", () => {
    renderNav({ activeView: "history" })

    expect(screen.getByTestId("nav-compress").hasAttribute("data-active")).toBe(
      false,
    )
    expect(screen.getByTestId("nav-history").hasAttribute("data-active")).toBe(
      true,
    )
    expect(screen.getByTestId("nav-history")).toHaveAttribute(
      "aria-expanded",
      "false",
    )
  })

  it("shows the staged file count on the Compress row", () => {
    renderNav({ files: [makeEntry(1), makeEntry(2), makeEntry(3)] })

    const badge = screen.getByTestId("nav-count")
    expect(badge).toHaveTextContent("3")
    expect(badge.closest('[data-slot="sidebar-menu-item"]')).not.toBeNull()
    expect(badge.closest('[data-slot="sidebar-menu-button"]')).toBeNull()
  })
})
