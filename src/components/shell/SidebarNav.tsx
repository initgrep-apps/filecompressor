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
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  Item,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
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
    if (view === "history") {
      setExpanded(isMobile ? true : !expanded)
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
          <SidebarMenu className="gap-1.5">
            {NAV_ITEMS.map((item) => {
              const active = activeView === item.id
              const Icon = item.icon
              return (
                <SidebarMenuItem key={item.id}>
                  <Item
                    render={<button type="button" />}
                    size="sm"
                    data-active={active ? "" : undefined}
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
                    className={cn(
                      "text-muted-foreground hover:bg-sidebar-accent data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground",
                      item.id === "history" && "pr-9",
                    )}
                  >
                    <ItemMedia variant="icon">
                      <Icon />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>
                        {item.label}
                        {item.id === "history" && (
                          <RiArrowDownSLine
                            aria-hidden
                            className={cn(
                              "size-4 shrink-0 text-muted-foreground transition-transform",
                              !expanded && "-rotate-90",
                            )}
                          />
                        )}
                      </ItemTitle>
                    </ItemContent>
                  </Item>
                  {item.id === "history" && (
                    <SidebarMenuAction
                      aria-label="Filter history"
                      title="Filter"
                      className={cn(
                        "top-1/2 right-2 size-6! -translate-y-1/2 transition-opacity",
                        hasActiveFilters || isMobile
                          ? "opacity-100"
                          : "pointer-events-none opacity-0 group-hover/menu-item:pointer-events-auto group-hover/menu-item:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 group-focus-within/menu-item:pointer-events-auto group-focus-within/menu-item:opacity-100",
                      )}
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
                      className="top-1/2 right-2 -translate-y-1/2 font-mono text-[10px] font-bold text-primary"
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
            <Item
              render={<button type="button" />}
              onClick={openSettings}
              data-testid="nav-settings"
              className="text-muted-foreground hover:bg-sidebar-accent"
            >
              <ItemMedia variant="icon">
                <RiSettings3Line />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Settings</ItemTitle>
              </ItemContent>
            </Item>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  )
}
