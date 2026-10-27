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
import type { HistoryFile, HistorySession } from "@/types"

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { HistoryFilesTable } from "@/components/history/HistoryFilesTable"
import { invoke } from "@tauri-apps/api/core"

const invokeMockTyped = vi.mocked(invoke)

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

function session(files: HistoryFile[]): HistorySession {
  return {
    sessionId: "s1",
    startedAt: Date.now(),
    endedAt: Date.now() + 45_000,
    outputFolder: "/out",
    fileCount: files.length,
    files,
    outcome: {
      done: 0,
      bestEffort: 0,
      failed: 0,
      cancelled: 0,
      unsupported: 0,
      alreadyUnderTarget: 0,
    },
    totalSavedBytes: 0,
    cancelled: false,
    interrupted: false,
    matchedFiles: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("HistoryFilesTable", () => {
  it("renders one row per file with the pinned columns", () => {
    render(<HistoryFilesTable session={session([doneFile()])} />)
    expect(screen.getByRole("columnheader", { name: "File" })).toBeTruthy()
    expect(screen.getByRole("columnheader", { name: "Size" })).toBeTruthy()
    expect(screen.getByRole("columnheader", { name: "Method" })).toBeTruthy()
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy()
    expect(screen.getByText("a.jpg")).toBeTruthy()
    expect(screen.getByText("1 KB → 512 B")).toBeTruthy()
    expect(screen.getByText("quality=70")).toBeTruthy()
  })

  it("truncates long file names with a fixed table layout", () => {
    render(<HistoryFilesTable session={session([doneFile({ name: "x".repeat(300) + ".pdf" })])} />)
    const name = screen.getByText(/\.pdf$/)
    expect(name.className).toContain("truncate")
    const table = document.querySelector('[data-slot="table"]')
    expect(table?.className).toContain("table-fixed")
  })

  it("disables 'Show compressed' for failed rows and keeps 'Show original' enabled", async () => {
    const user = userEvent.setup()
    render(<HistoryFilesTable session={session([failedFile(), doneFile()])} />)
    const kebabs = screen.getAllByRole("button", { name: "File actions" })
    await user.click(kebabs[0])
    const menu = await screen.findByRole("menu")
    const showCompressed = within(menu).getByRole("menuitem", { name: "Show compressed" })
    expect(showCompressed).toHaveAttribute("aria-disabled")
    await user.click(within(menu).getByRole("menuitem", { name: "Show original" }))
    await waitFor(() =>
      expect(invokeMockTyped).toHaveBeenCalledWith("reveal_in_folder", { filePath: "/in/broken.pdf" })
    )
  })

  it("reveals the compressed file for done rows", async () => {
    const user = userEvent.setup()
    invokeMockTyped.mockResolvedValue(undefined)
    render(<HistoryFilesTable session={session([doneFile()])} />)
    await user.click(screen.getByRole("button", { name: "File actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Show compressed" }))
    await waitFor(() =>
      expect(invokeMockTyped).toHaveBeenCalledWith("reveal_in_folder", { filePath: "/out/a.jpg" })
    )
  })

  it("shows the row error text under failed file names", () => {
    render(<HistoryFilesTable session={session([failedFile()])} />)
    expect(screen.getByText("Cannot read file: locked")).toBeTruthy()
  })
})
