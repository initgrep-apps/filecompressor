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

import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import { toast } from "sonner"
import type { Settings } from "@/types"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { SettingsDialog } from "@/components/SettingsDialog"

const baseSettings: Settings = {
  outputFolder: "/Users/test/Documents/Compressed",
  categoryTargets: {
    image: { size: 200, unit: "KB" },
    video: { size: 8, unit: "MB" },
    pdf: { size: 1, unit: "MB" },
    document: { size: 2, unit: "MB" },
  },
  qualityFloors: {
    image: { minQuality: 30 },
    video: { minCrf: 28, minResolution: "720p" },
    pdf: { minDpi: 72, minJpegQuality: 15 },
    document: { minMediaQuality: 40 },
  },
  performance: { maxConcurrent: "auto" },
  history: { retentionDays: 90 },
}

const resetDefaults: Settings = {
  ...baseSettings,
  outputFolder: "/defaults/Compressed",
  history: { retentionDays: 30 },
}

const saveCalls = () =>
  vi.mocked(invoke).mock.calls.filter(([command]) => command === "save_settings")

const savedSettings = () =>
  (saveCalls()[0]?.[1] as { settings: Settings }).settings

async function openHistoryTab() {
  render(<SettingsDialog open onOpenChange={vi.fn()} />)
  await screen.findByRole("tab", { name: "General" })
  fireEvent.click(screen.getByRole("tab", { name: "History" }))
  return screen.getByLabelText("History retention (days)")
}

beforeEach(() => {
  vi.mocked(invoke).mockReset()
  vi.mocked(toast.error).mockReset()
  vi.mocked(invoke).mockImplementation(() =>
    Promise.resolve(structuredClone(baseSettings)),
  )
})

afterEach(() => {
  vi.useRealTimers()
})

describe("SettingsDialog", () => {
  it("renders the five section tabs", async () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />)

    const tabs = await screen.findAllByRole("tab")

    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "General",
      "Targets",
      "Quality floors",
      "Performance",
      "History",
    ])
  })

  it("saves once 400 ms after a retention change", async () => {
    const input = await openHistoryTab()
    vi.useFakeTimers()

    fireEvent.change(input, { target: { value: "30" } })

    expect(saveCalls()).toHaveLength(0)

    await act(async () => {
      vi.advanceTimersByTime(400)
    })

    expect(saveCalls()).toHaveLength(1)
    expect(savedSettings().history).toEqual({ retentionDays: 30 })

    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(saveCalls()).toHaveLength(1)
  })

  it("flushes a pending save exactly once when closed inside the debounce window", async () => {
    const onOpenChange = vi.fn()
    render(<SettingsDialog open onOpenChange={onOpenChange} />)
    await screen.findByRole("tab", { name: "General" })
    fireEvent.click(screen.getByRole("tab", { name: "History" }))
    vi.useFakeTimers()

    fireEvent.change(screen.getByLabelText("History retention (days)"), {
      target: { value: "30" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Done" }))

    await act(async () => {})

    expect(saveCalls()).toHaveLength(1)
    expect(savedSettings().history).toEqual({ retentionDays: 30 })
    expect(onOpenChange).toHaveBeenCalledWith(false)

    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(saveCalls()).toHaveLength(1)
  })

  it("keeps the dialog open and toasts when the close flush rejects", async () => {
    vi.mocked(invoke).mockImplementation((command: string) =>
      command === "save_settings"
        ? Promise.reject(new Error("disk full"))
        : Promise.resolve(structuredClone(baseSettings)),
    )
    const onOpenChange = vi.fn()
    render(<SettingsDialog open onOpenChange={onOpenChange} />)
    await screen.findByRole("tab", { name: "General" })
    fireEvent.click(screen.getByRole("tab", { name: "History" }))
    vi.useFakeTimers()

    fireEvent.change(screen.getByLabelText("History retention (days)"), {
      target: { value: "30" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Done" }))

    await act(async () => {})

    expect(toast.error).toHaveBeenCalledWith("Could not save settings")
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByLabelText("History retention (days)")).toHaveDisplayValue(
      "30",
    )
  })

  it("resets the draft to the returned defaults", async () => {
    vi.mocked(invoke).mockImplementation((command: string) =>
      command === "reset_settings"
        ? Promise.resolve(structuredClone(resetDefaults))
        : Promise.resolve(structuredClone(baseSettings)),
    )
    render(<SettingsDialog open onOpenChange={vi.fn()} />)
    await screen.findByRole("tab", { name: "General" })
    fireEvent.click(screen.getByRole("tab", { name: "History" }))
    expect(screen.getByLabelText("History retention (days)")).toHaveDisplayValue(
      "90",
    )

    fireEvent.click(screen.getByRole("button", { name: "Reset defaults" }))
    await act(async () => {})

    expect(invoke).toHaveBeenCalledWith("reset_settings")
    expect(screen.getByLabelText("History retention (days)")).toHaveDisplayValue(
      "30",
    )

    fireEvent.click(screen.getByRole("tab", { name: "General" }))
    expect(screen.getByLabelText("Output folder")).toHaveValue(
      "/defaults/Compressed",
    )
  })
})
