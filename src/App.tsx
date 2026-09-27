import { useState } from "react"
import {
  RiUploadCloud2Line,
  RiHistoryLine,
  RiSettings3Line,
  RiFileReduceLine,
} from "@remixicon/react"
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
import { CompressView } from "@/views/CompressView"
import { HistoryView } from "@/views/HistoryView"
import { SettingsView } from "@/views/SettingsView"

type ViewId = "compress" | "history" | "settings"

const navItems: { id: ViewId; label: string; icon: React.ReactNode }[] = [
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

function App() {
  const [activeView, setActiveView] = useState<ViewId>("compress")

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon" variant="floating">
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
                  <RiFileReduceLine size={18} />
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
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <div className="px-3 py-2 text-xs text-muted-foreground">
            v1.0.0 · GPLv3
          </div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 items-center gap-2 border-b border-border px-4">
          <SidebarTrigger />
        </header>
        <div className="flex flex-1 flex-col">
          {activeView === "compress" && <CompressView />}
          {activeView === "history" && <HistoryView />}
          {activeView === "settings" && <SettingsView />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

export default App