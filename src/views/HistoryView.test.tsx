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
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { HistoryFile, HistoryFilters, HistoryResponse, HistorySession } from "@/types"

const { useHistoryContextMock } = vi.hoisted(() => ({
  useHistoryContextMock: vi.fn(),
}))

vi.mock("@/providers/HistoryProvider", () => ({
  useHistoryContext: useHistoryContextMock,
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { HistoryView } from "@/views/HistoryView"
import { invoke } from "@tauri-apps/api/core"
import { batchLabel } from "@/lib/historyFormat"

const invokeMock = vi.mocked(invoke)

function doneFile(overrides: Partial<HistoryFile> = {}): HistoryFile {
  return {
    name: "a.jpg",
    path: "/in/a.jpg",
    outputPath: "/out/a.jpg",
    category: "image",
    targetBytes: 204_800,
    originalSize: 1024,
    compressedSize: 512,
    status: "done",
    qualityUsed: 70,
    strategyUsed: "quality=70",
    error: null,
    durationMs: 120,
    completedAt: 1,
    ...overrides,
  }
}

function failedFile(overrides: Partial<HistoryFile> = {}): HistoryFile {
  return {
    name: "broken.pdf",
    path: "/in/broken.pdf",
    outputPath: null,
    category: "pdf",
    targetBytes: 2_097_152,
    originalSize: 10,
    compressedSize: null,
    status: "failed",
    qualityUsed: null,
    strategyUsed: null,
    error: "Cannot read file: locked",
    durationMs: 3,
    completedAt: 2,
    ...overrides,
  }
}

function session(overrides: Partial<HistorySession> = {}): HistorySession {
  const startedAt = overrides.startedAt ?? Date.now()
  return {
    sessionId: "s1",
    startedAt,
    endedAt: startedAt + 45_000,
    outputFolder: "/out",
    fileCount: 2,
    files: [doneFile(), failedFile()],
    outcome: {
      done: 1,
      bestEffort: 0,
      failed: 1,
      cancelled: 0,
      unsupported: 0,
      alreadyUnderTarget: 0,
    },
    totalSavedBytes: 512,
    cancelled: false,
    interrupted: false,
    matchedFiles: null,
    ...overrides,
  }
}

function responseWith(sessions: HistorySession[]): HistoryResponse {
  return {
    sessions,
    page: 0,
    pageSize: 50,
    totalSessions: sessions.length,
    totalFiles: sessions.reduce((acc, item) => acc + item.files.length, 0),
    summary: {
      sessions: sessions.length,
      files: sessions.reduce((acc, item) => acc + item.files.length, 0),
      savedBytes: sessions.reduce((acc, item) => acc + item.totalSavedBytes, 0),
      failedFiles: sessions.reduce(
        (acc, item) => acc + item.files.filter((file) => file.status === "failed").length,
        0,
      ),
    },
    outputFolders: [...new Set(sessions.map((item) => item.outputFolder))],
    skippedLines: 0,
  }
}

function renderView({
  sessions = [],
  selectedSessionId,
  loading = false,
  error = null,
  filters = {},
  response,
}: {
  sessions?: HistorySession[]
  selectedSessionId?: string | null
  loading?: boolean
  error?: string | null
  filters?: HistoryFilters
  response?: HistoryResponse | null
} = {}) {
  const clearHistory = vi.fn().mockResolvedValue(undefined)
  const clearError = vi.fn()
  const refresh = vi.fn()

  useHistoryContextMock.mockReturnValue({
    response: response === undefined ? responseWith(sessions) : response,
    loading,
    error,
    filters,
    setFilters: vi.fn(),
    page: 0,
    setPage: vi.fn(),
    searchText: "",
    setSearchText: vi.fn(),
    selectedSessionId:
      selectedSessionId === undefined
        ? (sessions[0]?.sessionId ?? null)
        : selectedSessionId,
    selectSession: vi.fn(),
    expanded: true,
    setExpanded: vi.fn(),
    refresh,
    clearHistory,
    clearError,
  })

  const view = render(<HistoryView />)
  return { ...view, clearHistory, clearError, refresh }
}

beforeEach(() => {
  vi.clearAllMocks()
  useHistoryContextMock.mockReset()
})

describe("HistoryView", () => {
  it("renders the selected batch label, meta, and reveal action", () => {
    const startedAt = new Date().setHours(14, 31, 0, 0)
    renderView({ sessions: [session({ startedAt })] })

    expect(screen.getByText(batchLabel(startedAt, new Date()))).toBeInTheDocument()
    expect(screen.getByText(/2 files · 45s · Output: \/out/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reveal folder" })).toBeInTheDocument()
  })

  it("renders file rows with glyph, strategy, sizes, percent, and status", () => {
    const { container } = renderView({ sessions: [session()] })

    const row = screen.getByText("a.jpg").closest("li")!
    expect(within(row).getByText("Image · quality=70")).toBeInTheDocument()
    expect(within(row).getByText("1 KB → 512 B")).toBeInTheDocument()
    expect(within(row).getByText("50%")).toBeInTheDocument()
    expect(within(row).getByText("Done")).toBeInTheDocument()
    expect(container.querySelector('svg[data-category="image"]')).not.toBeNull()

    const failedRow = screen.getByText("broken.pdf").closest("li")!
    expect(within(failedRow).getByText("10 B")).toBeInTheDocument()
    expect(within(failedRow).getByText("—")).toBeInTheDocument()
    expect(within(failedRow).getByText("Failed")).toBeInTheDocument()
    expect(within(failedRow).getByText("Cannot read file: locked")).toBeInTheDocument()
  })

  it("shows the empty state when no batch is selected", () => {
    renderView({ sessions: [session()], selectedSessionId: null })

    expect(screen.getByText("No batch selected")).toBeInTheDocument()
  })

  it("shows the empty history state and disables clearing", () => {
    renderView({ sessions: [] })

    expect(screen.getByText("No history yet")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Clear history" })).toBeDisabled()
  })

  it("shows skeleton rows while loading", () => {
    const { container } = renderView({ response: null, loading: true })

    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3)
  })

  it("shows the provider error in a banner", () => {
    renderView({ response: null, error: "Could not load history: disk error" })

    const banner = screen.getByRole("alert")
    expect(
      within(banner).getByText("Could not load history: disk error"),
    ).toBeInTheDocument()
    expect(within(banner).getByRole("button", { name: "Retry" })).toBeInTheDocument()
  })

  it("shows matched and total counts for a filtered batch", () => {
    const files = [
      doneFile(),
      doneFile({ name: "b.jpg", path: "/in/b.jpg", outputPath: "/out/b.jpg" }),
      doneFile({ name: "c.jpg", path: "/in/c.jpg", outputPath: "/out/c.jpg" }),
    ]
    renderView({ sessions: [session({ fileCount: 9, matchedFiles: 3, files })] })

    expect(screen.getByText("3 / 9")).toBeInTheDocument()
  })

  it("guards clear history behind a confirmation dialog", async () => {
    const user = userEvent.setup()
    const { clearHistory } = renderView({ sessions: [session()] })

    await user.click(screen.getByRole("button", { name: "Clear history" }))
    expect(screen.getByRole("alertdialog")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Delete history" }))
    expect(clearHistory).toHaveBeenCalledTimes(1)
  })

  it("never reports 100% saved for a failed-only batch", () => {
    renderView({
      sessions: [
        session({
          fileCount: 1,
          files: [failedFile()],
          totalSavedBytes: 0,
          outcome: {
            done: 0,
            bestEffort: 0,
            failed: 1,
            cancelled: 0,
            unsupported: 0,
            alreadyUnderTarget: 0,
          },
        }),
      ],
    })

    expect(screen.getByText("0% saved")).toBeInTheDocument()
    expect(screen.queryByText(/100%/)).not.toBeInTheDocument()
  })

  it("renders an em dash for a null aggregate percent", () => {
    renderView({
      sessions: [session({ fileCount: 0, files: [], totalSavedBytes: 0 })],
    })

    expect(
      within(screen.getByTestId("stat-saved")).getByText("—"),
    ).toBeInTheDocument()
  })

  it("opens the batch folder and reveals output and source files", async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue(undefined)
    renderView({ sessions: [session()] })

    await user.click(screen.getByRole("button", { name: "Reveal folder" }))
    expect(invokeMock).toHaveBeenCalledWith("open_folder", { path: "/out" })

    const row = screen.getByText("a.jpg").closest("li")!
    await user.click(within(row).getByRole("button", { name: "Reveal output" }))
    expect(invokeMock).toHaveBeenCalledWith("reveal_in_folder", {
      filePath: "/out/a.jpg",
    })

    await user.click(within(row).getByRole("button", { name: "Reveal source" }))
    expect(invokeMock).toHaveBeenCalledWith("reveal_in_folder", {
      filePath: "/in/a.jpg",
    })
  })
})
