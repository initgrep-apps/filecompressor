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
import {
  isValidElement,
  type ElementType,
  type ReactElement,
  type ReactNode,
} from "react"
import App from "./App"
import { ErrorBoundary } from "./components/ErrorBoundary"
import type { Platform } from "./lib/platform"
import { PlatformProvider } from "./providers/PlatformProvider"

const { renderMock, createRootMock, detectPlatformMock } = vi.hoisted(() => ({
  renderMock: vi.fn<(node: ReactNode) => void>(),
  createRootMock:
    vi.fn<(container: Element | DocumentFragment) => { render: (node: ReactNode) => void }>(),
  detectPlatformMock: vi.fn<() => Platform>(() => "linux"),
}))

vi.mock("react-dom/client", () => ({
  default: { createRoot: createRootMock },
  createRoot: createRootMock,
}))
vi.mock("./lib/platform", () => ({ detectPlatform: detectPlatformMock }))

createRootMock.mockReturnValue({ render: renderMock })

function findElement<P extends { children?: ReactNode }>(
  node: ReactNode,
  type: ElementType<P>,
): ReactElement<P> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type)
      if (found) return found
    }
    return null
  }
  if (!isValidElement<P>(node)) return null
  if (node.type === type) return node
  return findElement(node.props.children, type)
}

describe("main bootstrap", () => {
  it("pre-paints dark, then renders App under ErrorBoundary and PlatformProvider", async () => {
    document.body.innerHTML = '<div id="root"></div>'
    const rootEl = document.getElementById("root")
    expect(rootEl).not.toBeNull()
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-color-scheme: dark)",
    }))

    await import("./main")

    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(detectPlatformMock).toHaveBeenCalledTimes(1)
    expect(createRootMock).toHaveBeenCalledWith(rootEl)
    expect(renderMock).toHaveBeenCalledTimes(1)

    const tree = renderMock.mock.calls[0][0]
    expect(findElement(tree, ErrorBoundary)).not.toBeNull()

    const provider = findElement(tree, PlatformProvider)
    expect(provider?.props.platform).toBe("linux")

    expect(findElement(provider?.props.children, App)).not.toBeNull()
  })
})
