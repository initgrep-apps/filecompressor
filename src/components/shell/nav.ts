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

import type { ComponentType } from "react"
import { RiContractUpDownLine, RiHistoryLine } from "@remixicon/react"
import type { ViewId } from "@/types"

export interface ShellNavProps {
  activeView: ViewId
  onNavigate: (view: ViewId) => void
  onOpenSettings: () => void
}

export type DialogId = "settings" | "about"

export const NAV_ITEMS = [
  { id: "compress", label: "Compress", icon: RiContractUpDownLine },
  { id: "history", label: "History", icon: RiHistoryLine },
] as const satisfies readonly {
  id: ViewId
  label: string
  icon: ComponentType
}[]

const labelOf = (id: ViewId): string => {
  const item = NAV_ITEMS.find((entry) => entry.id === id)
  if (!item) throw new Error(`missing nav item for view: ${id}`)
  return item.label
}

export const VIEW_LABEL = {
  compress: labelOf("compress"),
  history: labelOf("history"),
} as const satisfies Record<ViewId, string>
