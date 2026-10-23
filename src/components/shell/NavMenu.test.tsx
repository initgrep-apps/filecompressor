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
import { NavMenu } from "@/components/shell/NavMenu"

async function openMenu() {
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Open navigation" }))
  await screen.findByRole("menuitem", { name: /Compress/ })
  return user
}

function renderMenu(activeView: "compress" | "history") {
  return render(
    <NavMenu
      activeView={activeView}
      onNavigate={vi.fn()}
      onOpenSettings={vi.fn()}
    />,
  )
}

describe("NavMenu", () => {
  it("shows Compress, History, one separator, and Settings", async () => {
    renderMenu("compress")

    await openMenu()

    expect(screen.getByRole("menuitem", { name: /Compress/ })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /History/ })).toBeInTheDocument()
    expect(screen.getAllByRole("separator")).toHaveLength(1)
    expect(screen.getByRole("menuitem", { name: /Settings/ })).toBeInTheDocument()
  })

  it("navigates to History", async () => {
    const onNavigate = vi.fn()
    render(
      <NavMenu
        activeView="compress"
        onNavigate={onNavigate}
        onOpenSettings={vi.fn()}
      />,
    )
    const user = await openMenu()

    await user.click(screen.getByRole("menuitem", { name: /History/ }))

    expect(onNavigate).toHaveBeenCalledWith("history")
  })

  it("opens Settings", async () => {
    const onOpenSettings = vi.fn()
    render(
      <NavMenu
        activeView="compress"
        onNavigate={vi.fn()}
        onOpenSettings={onOpenSettings}
      />,
    )
    const user = await openMenu()

    await user.click(screen.getByRole("menuitem", { name: /Settings/ }))

    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it("marks the active view with a checkmark", async () => {
    renderMenu("history")

    await openMenu()

    const settings = screen.getByRole("menuitem", { name: /Settings/ })
    const history = screen.getByRole("menuitem", { name: /History/ })
    const compress = screen.getByRole("menuitem", { name: /Compress/ })

    expect(
      history.querySelector("[data-slot='dropdown-menu-shortcut'] svg"),
    ).not.toBeNull()
    expect(
      compress.querySelector("[data-slot='dropdown-menu-shortcut']"),
    ).toBeNull()
    expect(
      settings.querySelector("[data-slot='dropdown-menu-shortcut']"),
    ).toBeNull()
  })
})
