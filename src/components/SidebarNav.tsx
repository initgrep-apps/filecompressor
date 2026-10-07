// File Size Optimizer — offline batch file compression
// Copyright (C) 2026 File Size Optimizer Contributors
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

import type { ReactNode } from "react"
import {
  RiContractUpDownLine,
  RiHistoryLine,
  RiSettings3Line,
} from "@remixicon/react"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { useCompressionContext } from "@/providers/CompressionProvider"

export type ViewId = "compress" | "history" | "settings"

export const navItems: { id: ViewId; label: string; icon: ReactNode }[] = [
  {
    id: "compress",
    label: "Compress",
    icon: <RiContractUpDownLine size={16} />,
  },
  {
    id: "history",
    label: "History",
    icon: <RiHistoryLine size={16} />,
  },
  {
    id: "settings",
    label: "Settings",
    icon: <RiSettings3Line size={16} />,
  },
]

interface SidebarNavProps {
  activeView: ViewId
  onViewChange: (id: ViewId) => void
}

export function SidebarNav({ activeView, onViewChange }: SidebarNavProps) {
  const { files } = useCompressionContext()

  return (
    <SidebarMenu>
      {navItems.map((item) => {
        const isActive = activeView === item.id
        return (
          <SidebarMenuItem key={item.id}>
            <SidebarMenuButton
              isActive={isActive}
              tooltip={item.label}
              onClick={() => onViewChange(item.id)}
              data-testid={`nav-${item.id}`}
              className={
                isActive
                  ? "border border-primary/30 [&[data-active]]:bg-primary/10"
                  : "border border-transparent"
              }
            >
              <span
                className={cn(
                  "flex size-7 items-center justify-center rounded-lg",
                  isActive ? "bg-primary/15 text-primary" : "bg-muted"
                )}
              >
                {item.icon}
              </span>
              <span className={isActive ? undefined : "text-muted-foreground"}>
                {item.label}
              </span>
              {item.id === "compress" && files.length > 0 && (
                <span
                  data-testid="nav-count"
                  className="ml-auto inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-bold text-primary group-data-[collapsible=icon]:hidden"
                >
                  {files.length}
                </span>
              )}
            </SidebarMenuButton>
          </SidebarMenuItem>
        )
      })}
    </SidebarMenu>
  )
}
