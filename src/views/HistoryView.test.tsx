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
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type {
  Category,
  FileStatus,
  HistoryFile,
  HistoryFilters,
  HistoryResponse,
  HistorySession,
} from "@/types"

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
import { toast } from "sonner"
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
  const setFilters = vi.fn()
  const setPage = vi.fn()

  useHistoryContextMock.mockReturnValue({
    response: response === undefined ? responseWith(sessions) : response,
    loading,
    error,
    filters,
    setFilters,
    page: 0,
    setPage,
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
  return {
    ...view,
    clearHistory,
    clearError,
    refresh,
    setFilters,
    setPage,
  }
}

const stat = (name: string) => screen.getByTestId(`stat-${name}`)

beforeEach(() => {
  vi.clearAllMocks()
  useHistoryContextMock.mockReset()
})

describe("HistoryView", () => {
  it("renders the selected batch label, meta, and reveal action", () => {
    const startedAt = new Date().setHours(14, 31, 0, 0)
    const { container } = renderView({ sessions: [session({ startedAt })] })

    expect(screen.getByText(batchLabel(startedAt, new Date()))).toBeInTheDocument()
    expect(screen.getByText(/2 files · 45s · Output: \/out/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reveal folder" })).toBeInTheDocument()
    const content = container.querySelector('[data-slot="card-content"]')!
    expect(content).toHaveAttribute("aria-busy", "false")
    expect(content.className).not.toContain("opacity-60")
  })

  it("renders file rows with glyph, strategy, sizes, percent, and status", () => {
    renderView({ sessions: [session()] })

    const row = screen.getByText("a.jpg").closest("li")!
    expect(within(row).getByText("Image · quality=70")).toBeInTheDocument()
    expect(within(row).getByText("1 KB → 512 B")).toBeInTheDocument()
    expect(within(row).getByText("50%")).toBeInTheDocument()
    expect(within(row).getByText("Done")).toBeInTheDocument()
    expect(row.querySelector('svg[data-category="image"]')).not.toBeNull()

    const failedRow = screen.getByText("broken.pdf").closest("li")!
    expect(within(failedRow).getByText("PDF")).toBeInTheDocument()
    expect(within(failedRow).getByText("10 B → —")).toBeInTheDocument()
    expect(within(failedRow).getByText("—")).toBeInTheDocument()
    expect(within(failedRow).getByText("Failed")).toBeInTheDocument()
    expect(within(failedRow).getByText("Cannot read file: locked")).toBeInTheDocument()
  })

  it("renders 0% for a grown-file row", () => {
    renderView({
      sessions: [
        session({
          fileCount: 1,
          files: [doneFile({ originalSize: 1024, compressedSize: 2048 })],
        }),
      ],
    })

    const row = screen.getByText("a.jpg").closest("li")!
    expect(within(row).getByText("0%")).toBeInTheDocument()
  })

  it("falls back to the quality when no strategy is recorded", () => {
    renderView({
      sessions: [
        session({
          fileCount: 1,
          files: [doneFile({ strategyUsed: null, qualityUsed: 72 })],
        }),
      ],
    })

    expect(screen.getByText("Image · quality 72")).toBeInTheDocument()
  })

  it("renders only the selected batch and never touches filters or pagination", async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue(undefined)
    const first = new Date().setHours(10, 0, 0, 0)
    const second = new Date().setHours(14, 31, 0, 0)
    const { setFilters, setPage } = renderView({
      sessions: [
        session({
          sessionId: "s1",
          startedAt: first,
          outputFolder: "/out-a",
          fileCount: 1,
          files: [doneFile({ name: "a.jpg", path: "/in/a.jpg", outputPath: "/out/a.jpg" })],
          outcome: {
            done: 1,
            bestEffort: 0,
            failed: 0,
            cancelled: 0,
            unsupported: 0,
            alreadyUnderTarget: 0,
          },
          totalSavedBytes: 512,
        }),
        session({
          sessionId: "s2",
          startedAt: second,
          outputFolder: "/out-b",
          fileCount: 1,
          files: [doneFile({ name: "b.jpg", path: "/in/b.jpg", outputPath: "/out/b.jpg" })],
          outcome: {
            done: 1,
            bestEffort: 0,
            failed: 0,
            cancelled: 0,
            unsupported: 0,
            alreadyUnderTarget: 0,
          },
          totalSavedBytes: 512,
        }),
      ],
      selectedSessionId: "s2",
    })

    expect(screen.getByText(batchLabel(second, new Date()))).toBeInTheDocument()
    expect(screen.getByText(/1 file · 45s · Output: \/out-b/)).toBeInTheDocument()
    expect(screen.getByText("b.jpg")).toBeInTheDocument()
    expect(screen.queryByText("a.jpg")).not.toBeInTheDocument()
    expect(screen.queryByRole("textbox", { name: /search/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/Page \d+ of/)).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Reveal folder" }))
    expect(invokeMock).toHaveBeenCalledWith("open_folder", { path: "/out-b" })
    expect(setFilters).not.toHaveBeenCalled()
    expect(setPage).not.toHaveBeenCalled()
  })

  it("shows the empty state when no batch is selected", () => {
    renderView({ sessions: [session()], selectedSessionId: null })

    expect(screen.getByText("No batch selected")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Clear history" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument()
  })

  it("shows the empty history state without a clear action", () => {
    renderView({ sessions: [] })

    expect(screen.getByText("No history yet")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Clear history" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument()
  })

  it("shows a filtered-empty state with a clear filters action", async () => {
    const user = userEvent.setup()
    const { setFilters } = renderView({
      response: responseWith([]),
      filters: { statuses: ["failed"] },
    })

    expect(screen.getByText("No batches match these filters.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Clear history" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(setFilters).toHaveBeenCalledTimes(1)
    expect(setFilters.mock.calls[0][0]).toStrictEqual({
      search: undefined,
      statuses: undefined,
      categories: undefined,
      sinceMs: undefined,
      outputFolder: undefined,
      sort: undefined,
    })
  })

  it("shows a corruption empty state and keeps clearing enabled when all lines were skipped", () => {
    renderView({ response: { ...responseWith([]), skippedLines: 3 } })

    expect(screen.getByText("History could not be read")).toBeInTheDocument()
    expect(screen.getByText("3 lines could not be read.")).toBeInTheDocument()
    expect(
      screen.getByText("Some history entries could not be read (3)."),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Clear history" })).toBeEnabled()
    expect(screen.queryByText("No history yet")).not.toBeInTheDocument()
  })

  it("uses the singular skipped count", () => {
    renderView({ response: { ...responseWith([]), skippedLines: 1 } })

    expect(screen.getByText("1 line could not be read.")).toBeInTheDocument()
  })

  it("prefers the filtered-empty state over corruption when filters hide everything", () => {
    renderView({
      response: { ...responseWith([]), skippedLines: 1 },
      filters: { statuses: ["failed"] },
    })

    expect(screen.getByText("No batches match these filters.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument()
    expect(screen.queryByText("History could not be read")).not.toBeInTheDocument()
  })

  it("does not treat skipped lines as corruption when batches exist", () => {
    renderView({
      response: { ...responseWith([session()]), skippedLines: 3 },
      selectedSessionId: null,
    })

    expect(screen.getByText("No batch selected")).toBeInTheDocument()
    expect(screen.queryByText("History could not be read")).not.toBeInTheDocument()
  })

  it("shows skeleton rows while loading", () => {
    const { container } = renderView({ response: null, loading: true })

    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3)
  })

  it("keeps the batch visible and marks it busy while refreshing", () => {
    const { container } = renderView({ sessions: [session()], loading: true })

    expect(screen.getByText("a.jpg")).toBeInTheDocument()
    expect(container.querySelector('[data-slot="card-content"]')).toHaveAttribute(
      "aria-busy",
      "true",
    )
    expect(container.querySelector('[data-slot="card-content"]')).toHaveClass(
      "opacity-60",
    )
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0)
  })

  it("shows the provider error in a banner", () => {
    renderView({ response: null, error: "Could not load history: disk error" })

    const banner = screen.getByRole("alert")
    expect(
      within(banner).getByText("Could not load history: disk error"),
    ).toBeInTheDocument()
    expect(within(banner).getByRole("button", { name: "Retry" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Clear history" })).not.toBeInTheDocument()
  })

  it("hides stale stats and files when an error follows a loaded response", () => {
    renderView({ sessions: [session()], error: "refresh failed" })

    expect(screen.getByRole("alert")).toHaveTextContent("refresh failed")
    expect(screen.queryByTestId("stat-saved")).not.toBeInTheDocument()
    expect(screen.queryByText("a.jpg")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Reveal folder" })).not.toBeInTheDocument()
  })

  it("retries by clearing the error and refreshing", async () => {
    const user = userEvent.setup()
    const { clearError, refresh } = renderView({ response: null, error: "boom" })

    await user.click(screen.getByRole("button", { name: "Retry" }))

    expect(clearError).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("uses matched files for the stats of a filtered batch", () => {
    renderView({
      sessions: [
        session({
          fileCount: 9,
          matchedFiles: 2,
          totalSavedBytes: 999_999,
          files: [
            doneFile({ originalSize: 4096, compressedSize: 2048 }),
            doneFile({
              name: "b.jpg",
              path: "/in/b.jpg",
              outputPath: "/out/b.jpg",
              status: "best_effort",
              originalSize: 4096,
              compressedSize: 2048,
            }),
          ],
          outcome: {
            done: 5,
            bestEffort: 9,
            failed: 7,
            cancelled: 0,
            unsupported: 0,
            alreadyUnderTarget: 0,
          },
        }),
      ],
    })

    expect(within(stat("saved")).getByText("4 KB")).toBeInTheDocument()
    expect(within(stat("saved")).getByText("50% saved")).toBeInTheDocument()
    expect(within(stat("files")).getByText("2 / 9")).toBeInTheDocument()
    expect(within(stat("best-effort")).getByText("1")).toBeInTheDocument()
    expect(within(stat("failed")).getByText("0")).toBeInTheDocument()
    expect(
      within(screen.getByTestId("files-header")).getByText("2 files"),
    ).toBeInTheDocument()
  })

  it("guards clear history behind a confirmation dialog", async () => {
    const user = userEvent.setup()
    const { clearHistory } = renderView({ sessions: [session()] })

    await user.click(screen.getByRole("button", { name: "Clear history" }))
    expect(screen.getByRole("alertdialog")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Delete history" }))
    expect(clearHistory).toHaveBeenCalledTimes(1)
  })

  it("leaves history intact when clearing is cancelled", async () => {
    const user = userEvent.setup()
    const { clearHistory } = renderView({ sessions: [session()] })

    await user.click(screen.getByRole("button", { name: "Clear history" }))
    await user.click(screen.getByRole("button", { name: "Cancel" }))

    expect(clearHistory).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    )
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

    expect(within(stat("saved")).getByText("0 B")).toBeInTheDocument()
    expect(within(stat("saved")).getByText("0% saved")).toBeInTheDocument()
    expect(within(stat("saved")).queryByText("100% saved")).not.toBeInTheDocument()
  })

  it("renders an em dash for a null aggregate percent", () => {
    renderView({
      sessions: [session({ fileCount: 0, files: [], totalSavedBytes: 0 })],
    })

    expect(within(stat("saved")).getByText("—")).toBeInTheDocument()
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

  it("toasts a backend reveal/open error exactly once without duplicating its prefix", async () => {
    const user = userEvent.setup()
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const row = () => screen.getByText("a.jpg").closest("li")!

    invokeMock.mockImplementation((command: unknown) =>
      command === "open_folder"
        ? Promise.reject("Could not open folder /x: denied")
        : Promise.reject("Could not reveal file: gone"),
    )
    const view = renderView({ sessions: [session()] })

    await user.click(screen.getByRole("button", { name: "Reveal folder" }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not open folder /x: denied"),
    )
    expect(toast.error).toHaveBeenCalledTimes(1)

    await user.click(within(row()).getByRole("button", { name: "Reveal output" }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not reveal file: gone"),
    )
    expect(toast.error).toHaveBeenCalledTimes(2)

    view.unmount()
    invokeMock.mockImplementation(() => Promise.reject("denied"))
    renderView({ sessions: [session()] })
    await user.click(screen.getByRole("button", { name: "Reveal folder" }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not open folder: denied"),
    )
    expect(toast.error).toHaveBeenCalledTimes(3)
    errSpy.mockRestore()
  })

  it("disables reveal output without an output path but keeps reveal source", () => {
    renderView({
      sessions: [session({ files: [failedFile()], fileCount: 1 })],
    })

    const row = screen.getByText("broken.pdf").closest("li")!
    expect(within(row).getByRole("button", { name: "Reveal output" })).toBeDisabled()
    expect(within(row).getByRole("button", { name: "Reveal source" })).toBeEnabled()
  })

  it("shows the cancelled badge without the interrupted badge", () => {
    const view = renderView({ sessions: [session({ cancelled: true })] })

    expect(screen.getByText("Cancelled")).toBeInTheDocument()
    expect(screen.queryByText("Interrupted")).not.toBeInTheDocument()

    view.unmount()
    renderView({ sessions: [session({ interrupted: true })] })
    expect(screen.getByText("Interrupted")).toBeInTheDocument()
    expect(screen.queryByText("Cancelled")).not.toBeInTheDocument()
  })

  it("uses a status-specific message when no files finished", () => {
    const cancelled = renderView({
      sessions: [session({ files: [], fileCount: 0, cancelled: true })],
    })
    expect(
      screen.getByText("No files finished before this batch was cancelled."),
    ).toBeInTheDocument()
    cancelled.unmount()

    const interrupted = renderView({
      sessions: [session({ files: [], fileCount: 0, interrupted: true })],
    })
    expect(
      screen.getByText("No files finished before this batch was interrupted."),
    ).toBeInTheDocument()
    interrupted.unmount()

    renderView({ sessions: [session({ files: [], fileCount: 0 })] })
    expect(screen.getByText("No files in this batch.")).toBeInTheDocument()
  })

  it("renders an em dash duration for an unfinished batch", () => {
    renderView({ sessions: [session({ endedAt: null })] })

    expect(screen.getByText(/2 files · — · Output: \/out/)).toBeInTheDocument()
  })

  it("shows the skipped lines notice only when lines were skipped and there is no error", () => {
    const clean = renderView({ response: responseWith([session()]) })
    expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument()
    clean.unmount()

    const skipped = renderView({
      response: { ...responseWith([session()]), skippedLines: 3 },
    })
    expect(
      screen.getByText("Some history entries could not be read (3)."),
    ).toBeInTheDocument()
    skipped.unmount()

    renderView({
      response: { ...responseWith([session()]), skippedLines: 3 },
      error: "boom",
    })
    expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument()
  })

  it("does not throw for unknown runtime statuses or categories", () => {
    renderView({
      sessions: [
        session({
          files: [
            doneFile({
              status: "mystery" as FileStatus,
              category: "mystery" as Category,
            }),
          ],
          fileCount: 1,
        }),
      ],
    })

    expect(screen.getAllByText("mystery").length).toBeGreaterThan(0)
  })
})
