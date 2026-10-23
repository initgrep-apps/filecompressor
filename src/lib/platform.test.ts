import { describe, it, expect, vi } from "vitest"
const platformMock = vi.hoisted(() => vi.fn())
vi.mock("@tauri-apps/plugin-os", () => ({ platform: platformMock }))
import { detectPlatform } from "./platform"

describe("detectPlatform", () => {
  it("maps macOS", () => {
    platformMock.mockReset()
    platformMock.mockReturnValue("macos")
    expect(detectPlatform()).toBe("darwin")
  })
  it("maps windows and linux", () => {
    platformMock.mockReset()
    platformMock.mockReturnValue("windows")
    expect(detectPlatform()).toBe("win32")
    platformMock.mockReturnValue("linux")
    expect(detectPlatform()).toBe("linux")
  })
  it("falls back to unknown when the injected internals are missing", () => {
    platformMock.mockReset()
    platformMock.mockImplementation(() => {
      throw new Error("__TAURI_OS_PLUGIN_INTERNALS__ is undefined")
    })
    expect(detectPlatform()).toBe("unknown")
  })
})
