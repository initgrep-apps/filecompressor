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

import { describe, it, expect, vi } from "vitest"
import { isValidElement, type ReactElement, type ReactNode } from "react"
import App from "./App"
import { PlatformProvider } from "./providers/PlatformProvider"

const renderMock = vi.hoisted(() => vi.fn())

vi.mock("react-dom/client", () => {
  const createRoot = () => ({ render: renderMock })
  return { default: { createRoot }, createRoot }
})
vi.mock("./lib/platform", () => ({ detectPlatform: () => "win32" }))

function findElement(node: ReactNode, type: unknown): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type)
      if (found) return found
    }
    return null
  }
  if (!isValidElement(node)) return null
  if (node.type === type) return node as ReactElement
  return findElement((node.props as { children?: ReactNode }).children, type)
}

describe("main bootstrap", () => {
  it("renders App under PlatformProvider with the detected platform", async () => {
    document.body.innerHTML = '<div id="root"></div>'

    await import("./main")

    expect(renderMock).toHaveBeenCalledTimes(1)
    const tree = renderMock.mock.calls[0][0] as ReactElement

    const provider = findElement(tree, PlatformProvider)
    expect(provider).not.toBeNull()
    expect((provider?.props as { platform?: string }).platform).toBe("win32")

    const app = findElement(
      (provider?.props as { children?: ReactNode }).children,
      App,
    )
    expect(app).not.toBeNull()
  })
})
