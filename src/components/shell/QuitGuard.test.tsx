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
import { render, waitFor } from "@testing-library/react"
import { getCurrentWindow, type CloseRequestedEvent } from "@tauri-apps/api/window"

const { invokeMock, confirmMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  confirmMock: vi.fn(),
}))

vi.mock("@tauri-apps/api/window", async () => {
  const { mockWindow } = await import("@/lib/test-tauri")
  const win = mockWindow()
  return { getCurrentWindow: () => win }
})
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: confirmMock, open: vi.fn() }))

import { QuitGuard } from "@/components/shell/QuitGuard"
import {
  CompressionContext,
  type CompressionContextValue,
} from "@/providers/CompressionProvider"
import { mockWindow } from "@/lib/test-tauri"

const win = getCurrentWindow() as unknown as ReturnType<typeof mockWindow>

function closeEvent() {
  const preventDefault = vi.fn()
  return { event: { preventDefault } as unknown as CloseRequestedEvent, preventDefault }
}

async function mountGuard(isCompressing: boolean) {
  render(
    <CompressionContext.Provider value={{ isCompressing } as CompressionContextValue}>
      <QuitGuard />
    </CompressionContext.Provider>,
  )
  await waitFor(() => expect(win.onCloseRequested).toHaveBeenCalled())
  return win.onCloseRequested.mock.calls[0][0]
}

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
  confirmMock.mockReset()
  win.onCloseRequested.mockReset()
  win.onCloseRequested.mockResolvedValue(vi.fn())
})

describe("QuitGuard", () => {
  it("always prevents the default close", async () => {
    const handler = await mountGuard(false)
    const { event, preventDefault } = closeEvent()

    await handler(event)

    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it("keeps the window open when the user cancels while compressing", async () => {
    confirmMock.mockResolvedValue(false)
    const handler = await mountGuard(true)

    await handler(closeEvent().event)

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("quits exactly once when the user confirms while compressing", async () => {
    confirmMock.mockResolvedValue(true)
    const handler = await mountGuard(true)

    await handler(closeEvent().event)

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith("quit")
  })

  it("quits immediately when idle", async () => {
    const handler = await mountGuard(false)

    await handler(closeEvent().event)

    expect(confirmMock).not.toHaveBeenCalled()
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith("quit")
  })
})
