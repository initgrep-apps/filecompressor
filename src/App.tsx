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

import { useState } from "react"
import { RiFileShield2Line } from "@remixicon/react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Separator } from "@/components/ui/separator"
import { CompressView } from "@/views/CompressView"
import { HistoryView } from "@/views/HistoryView"
import { SettingsView } from "@/views/SettingsView"
import { Toaster } from "@/components/ui/sonner"
import { CompressionProvider } from "@/providers/CompressionProvider"
import { SidebarNav, navItems, type ViewId } from "@/components/SidebarNav"

function App() {
  const [activeView, setActiveView] = useState<ViewId>("compress")

  return (
    <CompressionProvider>
      <SidebarProvider className="h-svh overflow-hidden">
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                tooltip="Optimizer"
                isActive={false}
                render={<div />}
              >
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
                  <RiFileShield2Line size={18} />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold text-sidebar-foreground">
                    Optimizer
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    File Size Optimizer
                  </span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarNav activeView={activeView} onViewChange={setActiveView} />
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <div className="flex items-center justify-start px-3 py-2">
            <div className="flex items-center gap-1.5 group-data-[collapsible=icon]:hidden">
              <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 font-mono text-[10px] font-bold text-muted-foreground">
                v1.0.0
              </span>
              <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-bold text-primary">
                GPLv3
              </span>
            </div>
            <div
              data-testid="footer-collapsed"
              className="hidden items-center gap-1 group-data-[collapsible=icon]:flex"
            >
              <span className="size-1.5 rounded-full bg-primary" />
              <span className="h-2.5 w-5 rounded-full border border-primary/30" />
            </div>
          </div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
          <SidebarTrigger />
          <Separator
            orientation="vertical"
            className="mr-2 data-[orientation=vertical]:h-4"
          />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink href="#">Optimizer</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>
                  {navItems.find((item) => item.id === activeView)?.label}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </header>
        <div data-testid="view-container" className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {activeView === "compress" && <CompressView />}
          {activeView === "history" && <HistoryView />}
          {activeView === "settings" && <SettingsView />}
        </div>
      </SidebarInset>
      <Toaster />
      </SidebarProvider>
    </CompressionProvider>
  )
}

export default App