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
  RiFilter3Line,
  RiSettings3Line,
} from "@remixicon/react"
import {
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { activeFilterCount } from "@/lib/historyFormat"
import { useCompressionContext } from "@/providers/CompressionProvider"
import { useHistoryContext } from "@/providers/HistoryProvider"
import {
  HistoryList,
  HISTORY_LIST_ID,
} from "@/components/history/HistoryList"
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

interface SidebarNavProps extends ShellNavProps {
  onOpenFilter: () => void
}

export function SidebarNav({
  activeView,
  onNavigate,
  onOpenSettings,
  onOpenFilter,
}: SidebarNavProps) {
  const { files } = useCompressionContext()
  const { expanded, setExpanded, filters } = useHistoryContext()
  const { isMobile, setOpenMobile } = useSidebar()

  const hasActiveFilters = activeFilterCount(filters) > 0

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
                    aria-controls={
                      item.id === "history" && expanded
                        ? HISTORY_LIST_ID
                        : undefined
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
                      <span
                        aria-hidden
                        className="pointer-events-none ml-auto flex"
                      >
                        <RiArrowDownSLine
                          className={cn(
                            "transition-transform",
                            expanded && "rotate-180",
                          )}
                        />
                      </span>
                    )}
                  </SidebarMenuButton>
                  {item.id === "history" && (
                    <SidebarMenuAction
                      aria-label="Filter history"
                      title="Filter"
                      className="size-6!"
                      onClick={onOpenFilter}
                    >
                      <RiFilter3Line />
                      {hasActiveFilters && (
                        <span
                          data-testid="history-filter-dot"
                          aria-hidden
                          className="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
                        />
                      )}
                    </SidebarMenuAction>
                  )}
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
      {expanded && (
        <HistoryList onOpenHistory={() => onNavigate("history")} />
      )}
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
