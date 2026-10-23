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

import { RiArrowDownSLine, RiSettings3Line } from "@remixicon/react"
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
import { NAV_ITEMS, type ShellNavProps } from "@/components/shell/nav"
import type { ViewId } from "@/types"

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
}: ShellNavProps) {
  const { files } = useCompressionContext()
  const { expanded, setExpanded } = useHistoryContext()
  const { isMobile, setOpenMobile } = useSidebar()

  const closeSheet = () => {
    if (isMobile) setOpenMobile(false)
  }

  const handleNavigate = (view: ViewId) => {
    if (view === "history" && activeView === "history") {
      setExpanded(!expanded)
      closeSheet()
      return
    }
    onNavigate(view)
    closeSheet()
  }

  const openSettings = () => {
    onOpenSettings()
    closeSheet()
  }

  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {NAV_ITEMS.map((item) => {
              const active = activeView === item.id
              const Icon = item.icon
              return (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    isActive={active}
                    aria-expanded={
                      item.id === "history" ? expanded : undefined
                    }
                    onClick={() => handleNavigate(item.id)}
                    data-testid={`nav-${item.id}`}
                    className={rowClass(active)}
                  >
                    <span className={glyphClass(active)}>
                      <Icon />
                    </span>
                    <span className={labelClass(active)}>{item.label}</span>
                    {item.id === "history" && (
                      <RiArrowDownSLine
                        aria-hidden
                        className={cn(
                          "ml-auto transition-transform",
                          expanded && "rotate-180",
                        )}
                      />
                    )}
                  </SidebarMenuButton>
                  {item.id === "compress" && files.length > 0 && (
                    <SidebarMenuBadge
                      data-testid="nav-count"
                      className="font-mono text-[10px] font-bold text-primary"
                    >
                      {files.length}
                    </SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              )
            })}
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
                <RiSettings3Line />
              </span>
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  )
}
