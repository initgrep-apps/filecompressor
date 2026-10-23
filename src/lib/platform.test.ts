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

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Platform as OsPlatform } from "@tauri-apps/plugin-os"

vi.mock("@tauri-apps/plugin-os", async () => {
  const { platformMock } = await import("./test-tauri")
  return { platform: platformMock }
})

import { detectPlatform, type Platform } from "./platform"
import { mockPlatform, platformMock } from "./test-tauri"

const cases: Array<[OsPlatform, Platform]> = [
  ["macos", "darwin"],
  ["windows", "win32"],
  ["linux", "linux"],
  ["freebsd", "unknown"],
]

describe("detectPlatform", () => {
  beforeEach(() => {
    platformMock.mockReset()
  })

  it.each(cases)("maps %s to %s", (input, expected) => {
    mockPlatform(input)
    expect(detectPlatform()).toBe(expected)
  })

  it("returns unknown when the plugin throws", () => {
    platformMock.mockImplementation(() => {
      throw new Error("__TAURI_OS_PLUGIN_INTERNALS__ is undefined")
    })
    expect(detectPlatform()).toBe("unknown")
  })

  it("logs a detection failure exactly once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      vi.resetModules()
      platformMock.mockImplementation(() => {
        throw new Error("__TAURI_OS_PLUGIN_INTERNALS__ is undefined")
      })
      const { detectPlatform: detectAfterReset } = await import("./platform")
      expect(detectAfterReset()).toBe("unknown")
      expect(detectAfterReset()).toBe("unknown")
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith("platform detection failed", expect.any(Error))
    } finally {
      warn.mockRestore()
    }
  })
})
