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
import { act, render, waitFor } from "@testing-library/react"
import { getCurrentWindow, type CloseRequestedEvent } from "@tauri-apps/api/window"

const { invokeMock, confirmMock, compressionMock, toastErrorMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  confirmMock: vi.fn(),
  compressionMock: vi.fn(),
  toastErrorMock: vi.fn(),
}))

vi.mock("@tauri-apps/api/window", async () => {
  const { mockWindow } = await import("@/lib/test-tauri")
  const win = mockWindow()
  return { getCurrentWindow: () => win }
})
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: confirmMock }))
vi.mock("@/providers/CompressionProvider", () => ({
  useCompressionContext: compressionMock,
}))
vi.mock("sonner", () => ({ toast: { error: toastErrorMock } }))

import { QuitGuard } from "@/components/shell/QuitGuard"
import { mockWindow } from "@/lib/test-tauri"

const win = getCurrentWindow() as unknown as ReturnType<typeof mockWindow>

let consoleError: ReturnType<typeof vi.spyOn>

function closeEvent() {
  const preventDefault = vi.fn()
  return { event: { preventDefault } as unknown as CloseRequestedEvent, preventDefault }
}

function renderGuard(isCompressing = false) {
  compressionMock.mockReturnValue({ isCompressing })
  return render(<QuitGuard />)
}

async function capturedHandler() {
  await waitFor(() => expect(win.onCloseRequested).toHaveBeenCalled())
  return win.onCloseRequested.mock.calls[0][0]
}

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
  invokeMock.mockReset()
  confirmMock.mockReset()
  compressionMock.mockReset()
  toastErrorMock.mockReset()
  win.onCloseRequested.mockReset()
  win.onCloseRequested.mockResolvedValue(vi.fn())
})

afterEach(() => {
  consoleError.mockRestore()
})

describe("QuitGuard", () => {
  it("always prevents the default close", async () => {
    renderGuard()
    const handler = await capturedHandler()
    const { event, preventDefault } = closeEvent()

    await handler(event)

    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it("keeps the window open when the user cancels while compressing", async () => {
    confirmMock.mockResolvedValue(false)
    renderGuard(true)
    const handler = await capturedHandler()
    const { event, preventDefault } = closeEvent()

    await handler(event)

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("quits exactly once when the user confirms while compressing", async () => {
    confirmMock.mockResolvedValue(true)
    renderGuard(true)
    const handler = await capturedHandler()
    const { event, preventDefault } = closeEvent()

    await handler(event)

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith("quit")
  })

  it("quits immediately when idle", async () => {
    renderGuard()
    const handler = await capturedHandler()
    const { event, preventDefault } = closeEvent()

    await handler(event)

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(confirmMock).not.toHaveBeenCalled()
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith("quit")
  })

  it("reads a fresh isCompressing value after rerender", async () => {
    const view = renderGuard(false)
    const handler = await capturedHandler()

    compressionMock.mockReturnValue({ isCompressing: true })
    view.rerender(<QuitGuard />)
    confirmMock.mockResolvedValue(false)

    await handler(closeEvent().event)

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("registers the close handler exactly once across isCompressing changes", async () => {
    const view = renderGuard(false)
    await capturedHandler()

    compressionMock.mockReturnValue({ isCompressing: true })
    view.rerender(<QuitGuard />)

    expect(win.onCloseRequested).toHaveBeenCalledTimes(1)
  })

  it("unlistens on unmount", async () => {
    const stop = vi.fn()
    win.onCloseRequested.mockResolvedValue(stop)
    const { unmount } = renderGuard()
    await capturedHandler()

    unmount()

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
  })

  it("unlistens when registration resolves after unmount", async () => {
    let resolveRegistration: ((stop: () => void) => void) | undefined
    win.onCloseRequested.mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          resolveRegistration = resolve
        }),
    )
    const { unmount } = renderGuard()
    await capturedHandler()

    unmount()
    const stop = vi.fn()
    await act(async () => {
      resolveRegistration?.(stop)
    })

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
  })

  it("reports a failed registration with a pinned toast", async () => {
    win.onCloseRequested.mockRejectedValue(new Error("listen failed"))
    renderGuard()

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1))
    expect(toastErrorMock.mock.calls[0][0]).toContain("Close protection")
    expect(toastErrorMock.mock.calls[0][1]).toMatchObject({
      id: "quit-guard-off",
      duration: Infinity,
    })
    expect(consoleError).toHaveBeenCalled()
  })

  it("keeps the window open and reports a failed quit", async () => {
    invokeMock.mockRejectedValue(new Error("quit failed"))
    renderGuard()
    const handler = await capturedHandler()
    const { event, preventDefault } = closeEvent()

    await expect(handler(event)).resolves.toBeUndefined()

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
  })

  it("keeps the window open and reports a failed confirmation", async () => {
    confirmMock.mockRejectedValue(new Error("dialog failed"))
    renderGuard(true)
    const handler = await capturedHandler()

    await expect(handler(closeEvent().event)).resolves.toBeUndefined()

    expect(invokeMock).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
  })

  it("calls invoke once for a double close", async () => {
    renderGuard()
    const handler = await capturedHandler()

    await handler(closeEvent().event)
    await handler(closeEvent().event)

    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it("allows a retry after a failed quit", async () => {
    invokeMock.mockRejectedValueOnce(new Error("quit failed"))
    renderGuard()
    const handler = await capturedHandler()

    await handler(closeEvent().event)
    await handler(closeEvent().event)

    expect(invokeMock).toHaveBeenCalledTimes(2)
  })

  it("allows a retry after the user cancels", async () => {
    confirmMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    renderGuard(true)
    const handler = await capturedHandler()

    await handler(closeEvent().event)
    await handler(closeEvent().event)

    expect(confirmMock).toHaveBeenCalledTimes(2)
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith("quit")
  })

  it("opens one confirmation dialog for concurrent closes", async () => {
    let resolveConfirm: ((confirmed: boolean) => void) | undefined
    confirmMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirm = resolve
        }),
    )
    renderGuard(true)
    const handler = await capturedHandler()
    const first = closeEvent()
    const second = closeEvent()

    const firstClose = handler(first.event)
    const secondClose = handler(second.event)

    expect(first.preventDefault).toHaveBeenCalledTimes(1)
    expect(second.preventDefault).toHaveBeenCalledTimes(1)
    expect(confirmMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveConfirm?.(false)
    })
    await firstClose
    await secondClose

    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("sends one quit for concurrent closes", async () => {
    let resolveInvoke: ((value: unknown) => void) | undefined
    invokeMock.mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          resolveInvoke = resolve
        }),
    )
    renderGuard()
    const handler = await capturedHandler()

    const firstClose = handler(closeEvent().event)
    const secondClose = handler(closeEvent().event)

    expect(invokeMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveInvoke?.(undefined)
    })
    await firstClose
    await secondClose
  })
})
