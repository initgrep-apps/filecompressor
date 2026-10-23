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

import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { AboutDialog } from "@/components/AboutDialog"

function renderDialog() {
  return render(<AboutDialog open onOpenChange={vi.fn()} />)
}

describe("AboutDialog", () => {
  it("shows the app identity and version", () => {
    renderDialog()

    expect(screen.getByRole("heading", { name: "Yard" })).toBeInTheDocument()
    expect(screen.getByText("Offline file compression tool")).toBeInTheDocument()
    expect(screen.getByText("No accounts and no telemetry.")).toBeInTheDocument()
    expect(screen.getByText("Version 0.1.0")).toBeInTheDocument()
    expect(screen.getByText("© 2026 Yard Contributors")).toBeInTheDocument()
  })

  it("lists the five license rows", () => {
    renderDialog()

    const rows = within(screen.getByTestId("license-rows")).getAllByRole("listitem")

    expect(rows).toHaveLength(5)
    expect(within(rows[0]).getByText("Yard")).toBeInTheDocument()
    expect(screen.getByText("GPL-3.0")).toBeInTheDocument()
    expect(screen.getByText("FFmpeg / ffprobe")).toBeInTheDocument()
    expect(screen.getByText("GPL-2.0-or-later")).toBeInTheDocument()
    expect(screen.getByText("Ghostscript")).toBeInTheDocument()
    expect(screen.getByText("AGPL-3.0")).toBeInTheDocument()
    expect(screen.getByText("libvips")).toBeInTheDocument()
    expect(screen.getByText("LGPL-3.0")).toBeInTheDocument()
    expect(screen.getByText("qpdf")).toBeInTheDocument()
    expect(screen.getByText("Apache-2.0")).toBeInTheDocument()
  })

  it("expands the bundled third-party notices without a network request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    renderDialog()
    const user = userEvent.setup()

    expect(screen.queryByTestId("third-party-notices")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /Third-party notices/ }))

    expect(screen.getByTestId("third-party-notices").textContent).toContain(
      "# Third-Party Licenses",
    )
    expect(fetchSpy).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: /Third-party notices/ }))

    expect(screen.queryByTestId("third-party-notices")).not.toBeInTheDocument()
    fetchSpy.mockRestore()
  })
})
