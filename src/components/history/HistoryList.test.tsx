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
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const { useHistoryMock } = vi.hoisted(() => ({
  useHistoryMock: vi.fn(),
}))

vi.mock("@/hooks/useHistory", () => ({ useHistory: useHistoryMock }))

import { HistoryList } from "@/components/history/HistoryList"
import {
  Sidebar,
  SidebarContent,
  SidebarProvider,
} from "@/components/ui/sidebar"
import {
  HistoryProvider,
  useHistoryContext,
} from "@/providers/HistoryProvider"
import {
  batchLabel,
  fileCountLabel,
  savedLabel,
} from "@/lib/historyFormat"
import type {
  HistoryFile,
  HistoryFilters,
  HistoryResponse,
  HistorySession,
} from "@/types"

function makeFile(
  n: number,
  originalSize: number,
  compressedSize: number | null,
): HistoryFile {
  return {
    name: `f${n}.jpg`,
    path: `/t/f${n}.jpg`,
    outputPath: null,
    category: "image",
    targetBytes: 512,
    originalSize,
    compressedSize,
    status: compressedSize === null ? "failed" : "done",
    qualityUsed: null,
    strategyUsed: null,
    error: null,
    durationMs: 100,
    completedAt: 0,
  }
}

function makeSession({
  id,
  startedAt,
  files = [],
  totalSavedBytes = 0,
  cancelled = false,
}: {
  id: string
  startedAt: number
  files?: HistoryFile[]
  totalSavedBytes?: number
  cancelled?: boolean
}): HistorySession {
  return {
    sessionId: id,
    startedAt,
    endedAt: startedAt + 1_000,
    outputFolder: "/out",
    fileCount: files.length,
    files,
    outcome: {
      done: files.length,
      bestEffort: 0,
      failed: 0,
      cancelled: 0,
      unsupported: 0,
      alreadyUnderTarget: 0,
    },
    totalSavedBytes,
    cancelled,
    interrupted: false,
    matchedFiles: null,
  }
}

function makeResponse(
  sessions: HistorySession[],
  {
    page = 0,
    pageSize = 50,
    totalSessions = sessions.length,
  }: { page?: number; pageSize?: number; totalSessions?: number } = {},
): HistoryResponse {
  return {
    sessions,
    page,
    pageSize,
    totalSessions,
    totalFiles: 0,
    summary: { sessions: totalSessions, files: 0, savedBytes: 0, failedFiles: 0 },
    outputFolders: [],
    skippedLines: 0,
  }
}

function SelectionProbe() {
  const { selectedSessionId } = useHistoryContext()
  return (
    <span data-testid="selected-session">{selectedSessionId ?? "none"}</span>
  )
}

function renderList({
  sessions = [],
  page = 0,
  pageSize = 50,
  totalSessions = sessions.length,
  loading = false,
  error = null,
  filters = {},
  response,
}: {
  sessions?: HistorySession[]
  page?: number
  pageSize?: number
  totalSessions?: number
  loading?: boolean
  error?: string | null
  filters?: HistoryFilters
  response?: HistoryResponse | null
} = {}) {
  const setFilters = vi.fn()
  const setPage = vi.fn()
  const onNavigate = vi.fn()

  useHistoryMock.mockReturnValue({
    response:
      response === undefined
        ? makeResponse(sessions, { page, pageSize, totalSessions })
        : response,
    loading,
    error,
    filters,
    setFilters,
    page,
    setPage,
    refresh: vi.fn(),
    clearHistory: vi.fn().mockResolvedValue(undefined),
    clearError: vi.fn(),
  })

  render(
    <HistoryProvider>
      <SelectionProbe />
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>
            <HistoryList onNavigate={onNavigate} />
          </SidebarContent>
        </Sidebar>
        <main />
      </SidebarProvider>
    </HistoryProvider>,
  )

  return { setFilters, setPage, onNavigate }
}

const scrollArea = () =>
  document.querySelector('[data-slot="scroll-area"]') as HTMLElement | null

beforeEach(() => {
  useHistoryMock.mockReset()
  window.innerWidth = 1024
})

describe("HistoryList", () => {
  it("pins the search above, and the pagination below, the only scroller", () => {
    renderList()

    const area = scrollArea()
    expect(area).not.toBeNull()
    expect(area!.className).toContain("min-h-0")
    expect(area!.className).toContain("flex-1")
    expect(
      area!.querySelector('[data-slot="sidebar-menu-sub"]'),
    ).not.toBeNull()
    expect(area).not.toContainElement(
      screen.getByLabelText("Search history"),
    )
    expect(area).not.toContainElement(screen.getByText(/Page 1 of/))

    const root = area!.parentElement!
    const children = [...root.children]
    const search = screen.getByLabelText("Search history").parentElement!
    const pagination = screen.getByText(/Page 1 of/).parentElement!

    expect(children.indexOf(search)).toBeLessThan(children.indexOf(area!))
    expect(children.indexOf(area!)).toBeLessThan(children.indexOf(pagination))
  })

  it("renders each batch with its label, meta line, and saved percent", () => {
    const startedAt = new Date().setHours(14, 31, 0, 0)
    const session = makeSession({
      id: "s1",
      startedAt,
      files: [makeFile(1, 1_000, 250)],
      totalSavedBytes: 750,
    })
    renderList({ sessions: [session] })

    expect(
      screen.getByText(batchLabel(startedAt, new Date())),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        `${fileCountLabel(1)} · ${savedLabel(750)} saved`,
      ),
    ).toBeInTheDocument()
    expect(screen.getByText("−75%")).toBeInTheDocument()
  })

  it("shows 0% for a failed-only batch instead of a full saving", () => {
    const startedAt = new Date().setHours(9, 12, 0, 0)
    renderList({
      sessions: [
        makeSession({
          id: "s1",
          startedAt,
          files: [makeFile(1, 1_000, null)],
        }),
      ],
    })

    expect(screen.getByText("0%")).toBeInTheDocument()
    expect(screen.queryByText("−100%")).toBeNull()
    expect(
      screen.getByText(`${fileCountLabel(1)} · 0 B saved`),
    ).toBeInTheDocument()
  })

  it("shows cancelled instead of a percent for a cancelled batch", () => {
    const startedAt = new Date().setHours(9, 12, 0, 0)
    renderList({
      sessions: [
        makeSession({
          id: "s1",
          startedAt,
          files: [makeFile(1, 1_000, null)],
          cancelled: true,
        }),
      ],
    })

    expect(screen.getByText("cancelled")).toBeInTheDocument()
    expect(screen.queryByText("0%")).toBeNull()
  })

  it("selects a batch and navigates to History when its row is clicked", async () => {
    const user = userEvent.setup()
    const first = makeSession({ id: "s1", startedAt: Date.now() })
    const second = makeSession({ id: "s2", startedAt: Date.now() - 60_000 })
    const { onNavigate } = renderList({ sessions: [first, second] })

    const row = screen.getByTestId("batch-s2")
    await user.click(row)

    expect(screen.getByTestId("selected-session")).toHaveTextContent("s2")
    expect(onNavigate).toHaveBeenCalledWith("history")
  })

  it("debounces the search into the history filters", async () => {
    const user = userEvent.setup()
    const { setFilters } = renderList()

    await user.type(screen.getByLabelText("Search history"), "hero")

    await waitFor(
      () =>
        expect(setFilters).toHaveBeenCalledWith(
          expect.objectContaining({ search: "hero" }),
        ),
      { timeout: 2_000 },
    )
  })

  it("disables Previous on the first page and pages forward", async () => {
    const user = userEvent.setup()
    const { setPage } = renderList({ totalSessions: 120 })

    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled()

    const next = screen.getByRole("button", { name: "Next page" })
    expect(next).toBeEnabled()
    await user.click(next)
    expect(setPage).toHaveBeenCalledWith(1)
  })

  it("disables Next on the last page and pages back", async () => {
    const user = userEvent.setup()
    const { setPage } = renderList({ page: 2, totalSessions: 120 })

    expect(screen.getByText("Page 3 of 3")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled()

    const previous = screen.getByRole("button", { name: "Previous page" })
    expect(previous).toBeEnabled()
    await user.click(previous)
    expect(setPage).toHaveBeenCalledWith(1)
  })

  it("renders skeleton rows and hides the page count on the first load", () => {
    renderList({ response: null, loading: true })

    expect(screen.getByRole("group", { name: "Batches" })).toHaveAttribute(
      "aria-busy",
      "true",
    )
    expect(
      document.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText(/Page \d+ of/)).toBeNull()
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled()
  })

  it("shows the empty state when no filters are active", () => {
    renderList()

    expect(screen.getByText("No batches yet.")).toBeInTheDocument()
    expect(scrollArea()).not.toBeNull()
  })

  it("distinguishes an empty filtered result", () => {
    renderList({ filters: { statuses: ["failed"] } })

    expect(
      screen.getByText("No batches match these filters."),
    ).toBeInTheDocument()
    expect(screen.queryByText("No batches yet.")).toBeNull()
  })

  it("renders a muted load error", () => {
    renderList({
      response: null,
      error: "Could not load history: boom",
    })

    const message = screen.getByText("Could not load history: boom")
    expect(message).toBeInTheDocument()
    expect(message.className).toContain("text-muted-foreground")
  })
})
