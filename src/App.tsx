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

import { useState } from "react"
import { RiFileShield2Line } from "@remixicon/react"
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { AboutDialog } from "@/components/AboutDialog"
import { SettingsDialog } from "@/components/SettingsDialog"
import { DragSurface } from "@/components/shell/DragSurface"
import { SidebarNav } from "@/components/shell/SidebarNav"
import { QuitGuard } from "@/components/shell/QuitGuard"
import { TopBar } from "@/components/shell/TopBar"
import { CompressionProvider } from "@/providers/CompressionProvider"
import { HistoryProvider } from "@/providers/HistoryProvider"
import { usePlatform } from "@/providers/PlatformProvider"
import { CompressView } from "@/views/CompressView"
import { HistoryView } from "@/views/HistoryView"
import type { ViewId } from "@/types"

function ShellSidebarHeader() {
  const platform = usePlatform()
  const { isMobile } = useSidebar()
  const showControls = isMobile || platform !== "darwin"

  return (
    <SidebarHeader className="h-12 justify-center p-2">
      <DragSurface className="flex h-full items-center gap-1">
        {showControls && (
          <>
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <RiFileShield2Line size={16} />
            </span>
            <SidebarTrigger title="Toggle sidebar" />
          </>
        )}
      </DragSurface>
    </SidebarHeader>
  )
}

function Shell() {
  const [activeView, setActiveView] = useState<ViewId>("compress")
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <Sidebar collapsible="offcanvas">
        <ShellSidebarHeader />
        <SidebarContent className="overflow-hidden">
          <SidebarNav
            activeView={activeView}
            onNavigate={setActiveView}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <TopBar
          activeView={activeView}
          onNavigate={setActiveView}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenAbout={() => setAboutOpen(true)}
        />
        <div
          data-testid="view-container"
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          {activeView === "compress" ? <CompressView /> : <HistoryView />}
        </div>
      </SidebarInset>
      <Toaster />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </SidebarProvider>
  )
}

function App() {
  return (
    <CompressionProvider>
      <QuitGuard />
      <HistoryProvider>
        <Shell />
      </HistoryProvider>
    </CompressionProvider>
  )
}

export default App
