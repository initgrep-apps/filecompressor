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
  useEffect,
  useState,
  type ComponentType,
  type MouseEvent,
} from "react"
import { RiFileShield2Line } from "@remixicon/react"
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  useSidebar,
} from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { AboutDialog } from "@/components/AboutDialog"
import { SettingsDialog } from "@/components/SettingsDialog"
import { HistoryFilterDialog } from "@/components/history/HistoryFilterDialog"
import { DragSurface } from "@/components/shell/DragSurface"
import type { DialogId } from "@/components/shell/nav"
import { SidebarActions } from "@/components/shell/SidebarActions"
import { SidebarNav } from "@/components/shell/SidebarNav"
import { QuitGuard } from "@/components/shell/QuitGuard"
import { TopBar } from "@/components/shell/TopBar"
import { CompressionProvider } from "@/providers/CompressionProvider"
import { HistoryProvider, useHistoryContext } from "@/providers/HistoryProvider"
import { usePlatform } from "@/providers/PlatformProvider"
import { CompressView } from "@/views/CompressView"
import { HistoryView } from "@/views/HistoryView"
import type { ViewId } from "@/types"

const VIEWS: Record<ViewId, ComponentType> = {
  compress: CompressView,
  history: HistoryView,
}

const stopPropagation = (event: MouseEvent) => event.stopPropagation()

function ShellSidebarHeader() {
  const platform = usePlatform()
  const { isMobile } = useSidebar()
  const showBrand = isMobile || platform !== "darwin"

  return (
    <SidebarHeader className="h-12 flex-row items-center gap-1 p-2">
      <DragSurface className="flex h-full flex-1 items-center gap-1">
        {showBrand && (
          <div
            className="flex items-center gap-1"
            onMouseDown={stopPropagation}
            onDoubleClick={stopPropagation}
          >
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <RiFileShield2Line size={16} />
            </span>
          </div>
        )}
      </DragSurface>
      <SidebarActions />
    </SidebarHeader>
  )
}

function Shell() {
  const [activeView, setActiveView] = useState<ViewId>("compress")
  const [dialog, setDialog] = useState<DialogId | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const { filters, setFilters } = useHistoryContext()
  const { isMobile, open, openMobile } = useSidebar()
  const visible = isMobile ? openMobile : open
  const View = VIEWS[activeView]

  useEffect(() => {
    if (!visible) setFilterOpen(false)
  }, [visible])

  const setDialogOpen = (id: DialogId) => (open: boolean) =>
    setDialog((current) => (open ? id : current === id ? null : current))

  return (
    <>
      <Sidebar collapsible="offcanvas">
        <ShellSidebarHeader />
        <SidebarContent className="overflow-hidden">
          <SidebarNav
            activeView={activeView}
            onNavigate={setActiveView}
            onOpenSettings={() => setDialog("settings")}
            onOpenFilter={() => setFilterOpen(true)}
          />
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <TopBar
          activeView={activeView}
          onNavigate={setActiveView}
          onOpenSettings={() => setDialog("settings")}
          onOpenAbout={() => setDialog("about")}
        />
        <div
          data-testid="view-container"
          data-view={activeView}
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <View />
        </div>
      </SidebarInset>
      <Toaster />
      <SettingsDialog
        open={dialog === "settings"}
        onOpenChange={setDialogOpen("settings")}
      />
      <AboutDialog
        open={dialog === "about"}
        onOpenChange={setDialogOpen("about")}
      />
      <HistoryFilterDialog
        open={filterOpen}
        onOpenChange={setFilterOpen}
        applied={filters}
        onApply={setFilters}
      />
    </>
  )
}

function ShellFrame() {
  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <Shell />
    </SidebarProvider>
  )
}

function App() {
  return (
    <CompressionProvider>
      <QuitGuard />
      <HistoryProvider>
        <ShellFrame />
      </HistoryProvider>
    </CompressionProvider>
  )
}

export default App
