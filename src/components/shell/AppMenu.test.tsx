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

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { AppMenu } from "@/components/shell/AppMenu"

async function openMenu() {
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "App menu" }))
  await screen.findByRole("menuitem", { name: /About/ })
  return user
}

describe("AppMenu", () => {
  it("opens About", async () => {
    const onAbout = vi.fn()
    render(<AppMenu onAbout={onAbout} onQuit={vi.fn()} />)
    const user = await openMenu()

    await user.click(screen.getByRole("menuitem", { name: /About/ }))

    expect(onAbout).toHaveBeenCalledTimes(1)
  })

  it("quits through the supplied handler", async () => {
    const onQuit = vi.fn()
    render(<AppMenu onAbout={vi.fn()} onQuit={onQuit} />)
    const user = await openMenu()

    await user.click(screen.getByRole("menuitem", { name: /Quit/ }))

    expect(onQuit).toHaveBeenCalledTimes(1)
  })

  it("separates About from Quit with exactly one separator", async () => {
    render(<AppMenu onAbout={vi.fn()} onQuit={vi.fn()} />)

    await openMenu()

    expect(screen.getAllByRole("separator")).toHaveLength(1)
  })
})
