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
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { getCurrentWindow } from "@tauri-apps/api/window"

const { invokeMock, toastErrorMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  toastErrorMock: vi.fn(),
}))

vi.mock("@tauri-apps/api/window", async () => {
  const { mockWindow } = await import("@/lib/test-tauri")
  const win = mockWindow()
  return { getCurrentWindow: () => win }
})
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))
vi.mock("sonner", () => ({ toast: { error: toastErrorMock } }))

import { WindowControls } from "@/components/shell/WindowControls"
import { mockWindow } from "@/lib/test-tauri"

const win = getCurrentWindow() as unknown as ReturnType<typeof mockWindow>

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
  invokeMock.mockReset()
  toastErrorMock.mockReset()
  win.minimize.mockReset()
  win.toggleMaximize.mockReset()
  win.close.mockReset()
  win.minimize.mockResolvedValue(undefined)
  win.toggleMaximize.mockResolvedValue(undefined)
  win.close.mockResolvedValue(undefined)
})

afterEach(() => {
  consoleError.mockRestore()
})

describe("WindowControls", () => {
  it("renders three icon buttons with accessible names and native titles", () => {
    render(<WindowControls />)

    const minimize = screen.getByRole("button", { name: "Minimize" })
    const maximize = screen.getByRole("button", { name: "Maximize" })
    const close = screen.getByRole("button", { name: "Close" })

    expect(minimize).toHaveAttribute("title", "Minimize")
    expect(maximize).toHaveAttribute("title", "Maximize")
    expect(close).toHaveAttribute("title", "Close")
    expect(minimize.querySelector("svg")).not.toBeNull()
    expect(maximize.querySelector("svg")).not.toBeNull()
    expect(close.querySelector("svg")).not.toBeNull()
  })

  it("minimizes on Minimize", async () => {
    const user = userEvent.setup()
    render(<WindowControls />)

    await user.click(screen.getByRole("button", { name: "Minimize" }))

    expect(win.minimize).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it("toggles maximize on Maximize", async () => {
    const user = userEvent.setup()
    render(<WindowControls />)

    await user.click(screen.getByRole("button", { name: "Maximize" }))

    expect(win.toggleMaximize).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it("closes the window through the close API on Close", async () => {
    const user = userEvent.setup()
    render(<WindowControls />)

    await user.click(screen.getByRole("button", { name: "Close" }))

    expect(win.close).toHaveBeenCalledTimes(1)
    expect(win.minimize).not.toHaveBeenCalled()
    expect(win.toggleMaximize).not.toHaveBeenCalled()
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it("never invokes the quit command from any control", async () => {
    const user = userEvent.setup()
    render(<WindowControls />)

    for (const name of ["Minimize", "Maximize", "Close"]) {
      await user.click(screen.getByRole("button", { name }))
    }

    expect(invokeMock).not.toHaveBeenCalled()
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it("stops mousedown and double click propagation from every button", () => {
    const onMouseDown = vi.fn()
    const onDoubleClick = vi.fn()
    render(
      <div onMouseDown={onMouseDown} onDoubleClick={onDoubleClick}>
        <WindowControls />
      </div>,
    )

    for (const name of ["Minimize", "Maximize", "Close"]) {
      const button = screen.getByRole("button", { name })
      fireEvent.mouseDown(button)
      fireEvent.doubleClick(button)
    }

    expect(onMouseDown).not.toHaveBeenCalled()
    expect(onDoubleClick).not.toHaveBeenCalled()
  })

  it("reports a failed minimize instead of crashing", async () => {
    win.minimize.mockRejectedValue(new Error("minimize failed"))
    const user = userEvent.setup()
    render(<WindowControls />)

    await user.click(screen.getByRole("button", { name: "Minimize" }))

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Could not minimize the window",
        expect.objectContaining({ id: "window-minimize-failed" }),
      ),
    )
    expect(consoleError).toHaveBeenCalled()
  })

  it("reports a failed maximize instead of crashing", async () => {
    win.toggleMaximize.mockRejectedValue(new Error("maximize failed"))
    const user = userEvent.setup()
    render(<WindowControls />)

    await user.click(screen.getByRole("button", { name: "Maximize" }))

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Could not resize the window",
        expect.objectContaining({ id: "window-resize-failed" }),
      ),
    )
    expect(consoleError).toHaveBeenCalled()
  })

  it("reports a failed close instead of crashing", async () => {
    win.close.mockRejectedValue(new Error("close failed"))
    const user = userEvent.setup()
    render(<WindowControls />)

    await user.click(screen.getByRole("button", { name: "Close" }))

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Could not close the window: close failed",
        expect.objectContaining({ id: "window-close-failed" }),
      ),
    )
    expect(consoleError).toHaveBeenCalled()
  })

  it("includes a non-Error close rejection in the toast", async () => {
    win.close.mockRejectedValue("denied by window policy")
    const user = userEvent.setup()
    render(<WindowControls />)

    await user.click(screen.getByRole("button", { name: "Close" }))

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1))
    const [message, options] = toastErrorMock.mock.calls[0]
    expect(message).toContain("denied by window policy")
    expect(options).toMatchObject({ id: "window-close-failed" })
    expect(consoleError).toHaveBeenCalled()
  })
})
