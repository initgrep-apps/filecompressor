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

import type { MouseEvent } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { toast } from "sonner"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { useSidebar } from "@/components/ui/sidebar"
import { AppMenu } from "@/components/shell/AppMenu"
import { DragSurface } from "@/components/shell/DragSurface"
import { SidebarActions } from "@/components/shell/SidebarActions"
import { NavMenu } from "@/components/shell/NavMenu"
import { ThemeToggle } from "@/components/shell/ThemeToggle"
import { WindowControls } from "@/components/shell/WindowControls"
import { useHistoryContext } from "@/providers/HistoryProvider"
import { usePlatform } from "@/providers/PlatformProvider"
import { VIEW_LABEL, type ShellNavProps } from "@/components/shell/nav"
import { batchLabel } from "@/lib/historyFormat"
import { cn } from "@/lib/utils"

interface TopBarProps extends ShellNavProps {
  onOpenAbout: () => void
}

const stopPropagation = (event: MouseEvent) => event.stopPropagation()

export function TopBar({
  activeView,
  onNavigate,
  onOpenSettings,
  onOpenAbout,
}: TopBarProps) {
  const platform = usePlatform()
  const { isMobile, open, openMobile } = useSidebar()
  const { response, selectedSessionId } = useHistoryContext()

  const visible = isMobile ? openMobile : open
  const isDarwin = platform === "darwin"
  const session =
    activeView === "history"
      ? (response?.sessions.find(
          (item) => item.sessionId === selectedSessionId,
        ) ?? null)
      : null
  const section = VIEW_LABEL[activeView]

  return (
    <DragSurface
      data-testid="top-bar"
      className={cn(
        "flex h-12 shrink-0 items-center gap-1.5 px-3",
        isDarwin && !visible && "pl-22",
      )}
    >
      <div
        className="flex items-center gap-1.5"
        onMouseDown={stopPropagation}
        onDoubleClick={stopPropagation}
      >
        {!visible && <SidebarActions />}
        {!visible && (
          <NavMenu
            activeView={activeView}
            onNavigate={onNavigate}
            onOpenSettings={onOpenSettings}
          />
        )}
      </div>
      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="min-w-0 flex-nowrap">
          <BreadcrumbItem>
            {session ? (
              <span className="text-muted-foreground">{section}</span>
            ) : (
              <BreadcrumbPage>{section}</BreadcrumbPage>
            )}
          </BreadcrumbItem>
          {session && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbPage className="truncate">
                  {batchLabel(session.startedAt, new Date())}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>
      <div
        className="ml-auto flex items-center gap-1"
        onMouseDown={stopPropagation}
        onDoubleClick={stopPropagation}
      >
        <ThemeToggle />
        <AppMenu
          onAbout={onOpenAbout}
          onQuit={() => {
            void getCurrentWindow()
              .close()
              .catch((error) => {
                console.error("window close failed:", error)
                toast.error("Could not quit the app — the window stays open.", {
                  id: "window-close-failed",
                })
              })
          }}
        />
        {!isDarwin && <WindowControls />}
      </div>
    </DragSurface>
  )
}
