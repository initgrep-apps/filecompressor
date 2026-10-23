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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { getCurrentWindow } from "@tauri-apps/api/window"

vi.mock("@tauri-apps/api/window", async () => {
  const { mockWindow } = await import("@/lib/test-tauri")
  const win = mockWindow()
  return { getCurrentWindow: () => win }
})

import { DragSurface } from "@/components/shell/DragSurface"
import { mockWindow } from "@/lib/test-tauri"

const win = getCurrentWindow() as unknown as ReturnType<typeof mockWindow>

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
  win.startDragging.mockReset()
  win.toggleMaximize.mockReset()
  win.startDragging.mockResolvedValue(undefined)
  win.toggleMaximize.mockResolvedValue(undefined)
})

afterEach(() => {
  consoleError.mockRestore()
})

describe("DragSurface", () => {
  it("starts dragging on a single left mousedown", () => {
    render(<DragSurface data-testid="drag-surface">content</DragSurface>)

    fireEvent.mouseDown(screen.getByTestId("drag-surface"), { detail: 1, buttons: 1 })

    expect(win.startDragging).toHaveBeenCalledTimes(1)
  })

  it("does not start dragging on the second click of a double click", () => {
    render(<DragSurface data-testid="drag-surface">content</DragSurface>)

    fireEvent.mouseDown(screen.getByTestId("drag-surface"), { detail: 2, buttons: 1 })

    expect(win.startDragging).not.toHaveBeenCalled()
  })

  it("does not start dragging on a non-left mousedown", () => {
    render(<DragSurface data-testid="drag-surface">content</DragSurface>)

    fireEvent.mouseDown(screen.getByTestId("drag-surface"), { detail: 1, buttons: 2 })

    expect(win.startDragging).not.toHaveBeenCalled()
  })

  it("does not start dragging on a third click", () => {
    render(<DragSurface data-testid="drag-surface">content</DragSurface>)

    fireEvent.mouseDown(screen.getByTestId("drag-surface"), { detail: 3, buttons: 1 })

    expect(win.startDragging).not.toHaveBeenCalled()
  })

  it("starts one drag and toggles maximize across a double click sequence", () => {
    render(<DragSurface data-testid="drag-surface">content</DragSurface>)
    const surface = screen.getByTestId("drag-surface")

    fireEvent.mouseDown(surface, { detail: 1, buttons: 1 })
    fireEvent.mouseDown(surface, { detail: 2, buttons: 1 })
    fireEvent.doubleClick(surface)

    expect(win.startDragging).toHaveBeenCalledTimes(1)
    expect(win.toggleMaximize).toHaveBeenCalledTimes(1)
  })

  it("toggles maximize on double click", () => {
    render(<DragSurface data-testid="drag-surface">content</DragSurface>)

    fireEvent.doubleClick(screen.getByTestId("drag-surface"))

    expect(win.toggleMaximize).toHaveBeenCalledTimes(1)
  })

  it("does not start dragging when a child stops mousedown propagation", () => {
    render(
      <DragSurface>
        <button type="button" onMouseDown={(event) => event.stopPropagation()}>
          child
        </button>
      </DragSurface>,
    )

    fireEvent.mouseDown(screen.getByRole("button", { name: "child" }), {
      detail: 1,
      buttons: 1,
    })

    expect(win.startDragging).not.toHaveBeenCalled()
  })

  it("reports a failed drag start instead of throwing", async () => {
    win.startDragging.mockRejectedValue(new Error("drag failed"))
    render(<DragSurface data-testid="drag-surface">content</DragSurface>)

    expect(() =>
      fireEvent.mouseDown(screen.getByTestId("drag-surface"), { detail: 1, buttons: 1 }),
    ).not.toThrow()
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalled())
  })
})
