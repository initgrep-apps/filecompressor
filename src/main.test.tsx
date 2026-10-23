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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { isValidElement, StrictMode, type ReactElement, type ReactNode } from "react"
import type { Platform } from "./lib/platform"

const { renderMock, createRootMock, detectPlatformMock } = vi.hoisted(() => {
  const renderMock = vi.fn<(node: ReactNode) => void>()
  const createRootMock =
    vi.fn<
      (container: Element | DocumentFragment) => { render: (node: ReactNode) => void }
    >(() => ({ render: renderMock }))
  const detectPlatformMock = vi.fn<() => Platform>(() => "win32")
  return { renderMock, createRootMock, detectPlatformMock }
})

vi.mock("react-dom/client", () => ({
  default: { createRoot: createRootMock },
  createRoot: createRootMock,
}))
vi.mock("./lib/platform", () => ({ detectPlatform: detectPlatformMock }))

type ShellElement = ReactElement<{ children?: ReactNode; platform?: Platform }>

function onlyChild(element: ShellElement): ShellElement {
  const children = element.props.children
  if (!isValidElement<{ children?: ReactNode; platform?: Platform }>(children)) {
    throw new Error("expected a single element child")
  }
  return children
}

async function importShell() {
  const { default: App } = await import("./App")
  const { ErrorBoundary } = await import("./components/ErrorBoundary")
  const { PlatformProvider } = await import("./providers/PlatformProvider")
  await import("./main")
  return { App, ErrorBoundary, PlatformProvider }
}

describe("main bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    document.documentElement.classList.remove("dark")
    document.body.innerHTML = '<div id="root"></div>'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("pre-paints dark before rendering the shell", async () => {
    const rootEl = document.getElementById("root")
    expect(rootEl).not.toBeNull()
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-color-scheme: dark)",
    }))
    renderMock.mockImplementationOnce(() => {
      expect(document.documentElement.classList.contains("dark")).toBe(true)
    })

    const { App, ErrorBoundary, PlatformProvider } = await importShell()

    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(detectPlatformMock).toHaveBeenCalledOnce()
    expect(createRootMock).toHaveBeenCalledWith(rootEl)
    expect(renderMock).toHaveBeenCalledTimes(1)

    const tree = renderMock.mock.calls[0][0]
    if (!isValidElement<{ children?: ReactNode; platform?: Platform }>(tree)) {
      throw new Error("expected an element tree")
    }
    expect(tree.type).toBe(StrictMode)
    const boundary = onlyChild(tree)
    expect(boundary.type).toBe(ErrorBoundary)
    const provider = onlyChild(boundary)
    expect(provider.type).toBe(PlatformProvider)
    expect(provider.props.platform).toBe("win32")
    expect(onlyChild(provider).type).toBe(App)
  })

  it("leaves the light theme alone", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }))
    expect(document.documentElement.classList.contains("dark")).toBe(false)

    await importShell()

    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(detectPlatformMock).toHaveBeenCalledOnce()
    expect(renderMock).toHaveBeenCalledTimes(1)
  })

  it("fails loudly when #root is missing", async () => {
    document.body.innerHTML = ""

    await expect(import("./main")).rejects.toThrow(/#root element missing/)
  })
})
