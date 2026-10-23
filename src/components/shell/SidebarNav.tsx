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

import {
  RiArrowDownSLine,
  RiContractUpDownLine,
  RiHistoryLine,
  RiSettings3Line,
} from "@remixicon/react"
import {
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { useCompressionContext } from "@/providers/CompressionProvider"
import { useHistoryContext } from "@/providers/HistoryProvider"
import type { ViewId } from "@/types"

interface SidebarNavProps {
  activeView: ViewId
  onNavigate: (view: ViewId) => void
  onOpenSettings: () => void
}

const rowClass = (active: boolean) =>
  cn(
    "border",
    active
      ? "border-primary/30 [&[data-active]]:bg-primary/10"
      : "border-transparent",
  )

const glyphClass = (active: boolean) =>
  cn(
    "flex size-7 items-center justify-center rounded-lg",
    active ? "bg-primary/15 text-primary" : "bg-muted",
  )

const labelClass = (active: boolean) =>
  active ? undefined : "text-muted-foreground"

export function SidebarNav({
  activeView,
  onNavigate,
  onOpenSettings,
}: SidebarNavProps) {
  const { files } = useCompressionContext()
  const { expanded, setExpanded } = useHistoryContext()
  const { isMobile, setOpenMobile } = useSidebar()

  const closeSheet = () => {
    if (isMobile) setOpenMobile(false)
  }

  const navigate = (view: ViewId) => {
    onNavigate(view)
    closeSheet()
  }

  const openHistory = () => {
    navigate("history")
    setExpanded(!expanded)
  }

  const openSettings = () => {
    onOpenSettings()
    closeSheet()
  }

  const compressActive = activeView === "compress"
  const historyActive = activeView === "history"

  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={compressActive}
                onClick={() => navigate("compress")}
                data-testid="nav-compress"
                className={rowClass(compressActive)}
              >
                <span className={glyphClass(compressActive)}>
                  <RiContractUpDownLine size={16} />
                </span>
                <span className={labelClass(compressActive)}>Compress</span>
              </SidebarMenuButton>
              {files.length > 0 && (
                <SidebarMenuBadge
                  data-testid="nav-count"
                  className="font-mono text-[10px] font-bold text-primary"
                >
                  {files.length}
                </SidebarMenuBadge>
              )}
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={historyActive}
                aria-expanded={expanded}
                onClick={openHistory}
                data-testid="nav-history"
                className={rowClass(historyActive)}
              >
                <span className={glyphClass(historyActive)}>
                  <RiHistoryLine size={16} />
                </span>
                <span className={labelClass(historyActive)}>History</span>
                <RiArrowDownSLine
                  aria-hidden
                  className={cn(
                    "ml-auto transition-transform",
                    expanded && "rotate-180",
                  )}
                />
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <SidebarFooter className="mt-auto">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              onClick={openSettings}
              data-testid="nav-settings"
            >
              <span className={glyphClass(false)}>
                <RiSettings3Line size={16} />
              </span>
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  )
}
