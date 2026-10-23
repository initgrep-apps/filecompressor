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

import { useState } from "react"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { version } from "../../package.json"
import thirdPartyNotices from "../../THIRD_PARTY_LICENSES.md?raw"
import { AboutDialog } from "@/components/AboutDialog"

const LICENSE_ROWS = [
  ["Yard", "GPL-3.0"],
  ["FFmpeg / ffprobe", "GPL-2.0-or-later"],
  ["Ghostscript", "AGPL-3.0"],
  ["libvips", "LGPL-3.0"],
  ["qpdf", "Apache-2.0"],
]

afterEach(() => {
  vi.restoreAllMocks()
})

function ControlledDialog() {
  const [open, setOpen] = useState(true)

  return (
    <div>
      <button onClick={() => setOpen(true)}>Open about</button>
      <AboutDialog open={open} onOpenChange={setOpen} />
    </div>
  )
}

describe("AboutDialog", () => {
  it("shows the app identity and the package version", () => {
    render(<AboutDialog open onOpenChange={vi.fn()} />)

    expect(screen.getByRole("heading", { name: "Yard" })).toBeInTheDocument()
    expect(screen.getByText("Offline file compression tool")).toBeInTheDocument()
    expect(screen.getByText("No accounts and no telemetry.")).toBeInTheDocument()
    expect(screen.getByText(`Version ${version}`)).toBeInTheDocument()
    expect(screen.getByText("© 2026 Yard Contributors")).toBeInTheDocument()
  })

  it("lists the five license rows as name and license pairs", () => {
    render(<AboutDialog open onOpenChange={vi.fn()} />)

    const dialog = screen.getByRole("dialog")
    const rows = within(dialog).getAllByRole("listitem")

    expect(rows).toHaveLength(5)
    LICENSE_ROWS.forEach(([name, license], index) => {
      expect(within(rows[index]).getByText(name)).toBeInTheDocument()
      expect(within(rows[index]).getByText(license)).toBeInTheDocument()
    })
  })

  it("expands the bundled notices verbatim without a network request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    render(<AboutDialog open onOpenChange={vi.fn()} />)
    const user = userEvent.setup()

    expect(screen.getByRole("dialog").querySelector("pre")).toBeNull()

    await user.click(screen.getByRole("button", { name: /Third-party notices/ }))

    const notices = screen.getByRole("dialog").querySelector("pre")

    expect(notices?.textContent).toBe(thirdPartyNotices)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("requests a close from the close button", async () => {
    const onOpenChange = vi.fn()
    render(<AboutDialog open onOpenChange={onOpenChange} />)
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Close" }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("requests a close on Escape", async () => {
    const onOpenChange = vi.fn()
    render(<AboutDialog open onOpenChange={onOpenChange} />)
    const user = userEvent.setup()

    await user.keyboard("{Escape}")

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("renders no dialog while closed", () => {
    render(<AboutDialog open={false} onOpenChange={vi.fn()} />)

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("heading", { name: "Yard" }),
    ).not.toBeInTheDocument()
  })

  it("starts with the notices collapsed when reopened", async () => {
    render(<ControlledDialog />)
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: /Third-party notices/ }))
    expect(screen.getByRole("dialog").querySelector("pre")).not.toBeNull()

    await user.click(screen.getByRole("button", { name: "Close" }))
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    )

    await user.click(screen.getByRole("button", { name: "Open about" }))
    expect(
      (await screen.findByRole("dialog")).querySelector("pre"),
    ).toBeNull()
  })
})
