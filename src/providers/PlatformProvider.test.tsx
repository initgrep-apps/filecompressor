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

import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { PlatformProvider, usePlatform } from "./PlatformProvider"

function Probe() {
  return <span data-testid="platform">{usePlatform()}</span>
}

describe("PlatformProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each(["darwin", "win32", "linux", "unknown"] as const)(
    "provides %s to consumers",
    (platform) => {
      render(
        <PlatformProvider platform={platform}>
          <Probe />
        </PlatformProvider>,
      )
      expect(screen.getByTestId("platform")).toHaveTextContent(platform)
    },
  )

  it("throws outside the provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow(
      "usePlatform must be used within a PlatformProvider",
    )
  })
})
