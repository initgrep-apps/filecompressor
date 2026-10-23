import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { PlatformProvider, usePlatform } from "./PlatformProvider"

function Probe() {
  return <span data-testid="platform">{usePlatform()}</span>
}

describe("PlatformProvider", () => {
  it("provides the supplied platform", () => {
    render(
      <PlatformProvider platform="darwin">
        <Probe />
      </PlatformProvider>,
    )
    expect(screen.getByTestId("platform")).toHaveTextContent("darwin")
  })

  it("throws outside the provider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow(
      "usePlatform must be used within a PlatformProvider",
    )
    consoleError.mockRestore()
  })
})
