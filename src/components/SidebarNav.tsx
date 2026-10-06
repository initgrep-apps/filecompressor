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

import {
  RiUploadCloud2Line,
  RiHistoryLine,
  RiSettings3Line,
} from "@remixicon/react"
import {
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { useCompressionContext } from "@/providers/CompressionProvider"

export type ViewId = "compress" | "history" | "settings"

export const navItems: { id: ViewId; label: string; icon: React.ReactNode }[] = [
  {
    id: "compress",
    label: "Compress",
    icon: <RiUploadCloud2Line size={16} />,
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
  setActiveView: (id: ViewId) => void
}

export function SidebarNav({ activeView, setActiveView }: SidebarNavProps) {
  const { files } = useCompressionContext()

  return (
    <SidebarMenu>
      {navItems.map((item) => (
        <SidebarMenuItem key={item.id}>
          <SidebarMenuButton
            isActive={activeView === item.id}
            tooltip={item.label}
            onClick={() => setActiveView(item.id)}
          >
            {item.icon}
            <span>{item.label}</span>
          </SidebarMenuButton>
          {item.id === "compress" && files.length > 0 && (
            <SidebarMenuBadge>{files.length}</SidebarMenuBadge>
          )}
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  )
}
