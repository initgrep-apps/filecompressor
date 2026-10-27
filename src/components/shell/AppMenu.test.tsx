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

function renderMenu() {
  const onAbout = vi.fn()
  const onQuit = vi.fn()
  render(<AppMenu onAbout={onAbout} onQuit={onQuit} />)
  return { onAbout, onQuit }
}

async function openMenu() {
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "App menu" }))
  await screen.findByRole("menuitem", { name: /About/ })
  return user
}

function menuOrder() {
  const menu = screen.getByRole("menu")
  return Array.from(
    menu.querySelectorAll('[role="menuitem"], [role="separator"]'),
  ).map((element) =>
    element.getAttribute("role") === "separator"
      ? "—"
      : element.textContent?.trim(),
  )
}

describe("AppMenu", () => {
  it("renders About, a separator, then Quit", async () => {
    renderMenu()

    await openMenu()

    expect(menuOrder()).toEqual(["About Yard", "—", "Quit"])
  })

  it("opens About without quitting", async () => {
    const { onAbout, onQuit } = renderMenu()
    const user = await openMenu()

    await user.click(screen.getByRole("menuitem", { name: /About/ }))

    expect(onAbout).toHaveBeenCalledTimes(1)
    expect(onQuit).not.toHaveBeenCalled()
  })

  it("quits without opening About", async () => {
    const { onAbout, onQuit } = renderMenu()
    const user = await openMenu()

    await user.click(screen.getByRole("menuitem", { name: /Quit/ }))

    expect(onQuit).toHaveBeenCalledTimes(1)
    expect(onAbout).not.toHaveBeenCalled()
  })

  it("renders the popup without a forced dark palette", async () => {
    renderMenu()

    await openMenu()

    expect(screen.getByRole("menu").className).not.toMatch(/(^|\s)dark(\s|$)/)
  })
})
