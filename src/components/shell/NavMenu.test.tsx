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

function renderMenu(activeView: "compress" | "history" = "compress") {
  const onNavigate = vi.fn()
  const onOpenSettings = vi.fn()
  render(
    <NavMenu
      activeView={activeView}
      onNavigate={onNavigate}
      onOpenSettings={onOpenSettings}
    />,
  )
  return { onNavigate, onOpenSettings }
}

async function openMenu() {
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Open navigation" }))
  await screen.findByRole("menuitem", { name: /Compress/ })
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

describe("NavMenu", () => {
  it("renders Compress and History, a separator, then Settings", async () => {
    renderMenu()

    await openMenu()

    expect(menuOrder()).toEqual(["Compress", "History", "—", "Settings"])
  })

  it("navigates to Compress", async () => {
    const { onNavigate } = renderMenu("history")
    const user = await openMenu()

    await user.click(screen.getByRole("menuitem", { name: /Compress/ }))

    expect(onNavigate).toHaveBeenCalledWith("compress")
  })

  it("navigates to History", async () => {
    const { onNavigate } = renderMenu("compress")
    const user = await openMenu()

    await user.click(screen.getByRole("menuitem", { name: /History/ }))

    expect(onNavigate).toHaveBeenCalledWith("history")
  })

  it("opens Settings without navigating", async () => {
    const { onNavigate, onOpenSettings } = renderMenu()
    const user = await openMenu()

    await user.click(screen.getByRole("menuitem", { name: /Settings/ }))

    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it("marks the active view with aria-current and a hidden checkmark", async () => {
    renderMenu("history")

    await openMenu()

    const compress = screen.getByRole("menuitem", { name: /Compress/ })
    const history = screen.getByRole("menuitem", { name: /History/ })
    const settings = screen.getByRole("menuitem", { name: /Settings/ })

    expect(history).toHaveAttribute("aria-current", "page")
    expect(compress).not.toHaveAttribute("aria-current")
    expect(settings).not.toHaveAttribute("aria-current")
    expect(
      history.querySelector("[data-slot='dropdown-menu-shortcut'] svg"),
    ).not.toBeNull()
    expect(
      compress.querySelector("[data-slot='dropdown-menu-shortcut']"),
    ).toBeNull()
  })
})
