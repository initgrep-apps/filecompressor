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
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { X, Minus, AppWindow } from "lucide-react"

const stopPropagation = (event: MouseEvent) => event.stopPropagation()

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

export function WindowControls() {
  const win = getCurrentWindow()

  return (
    <div
      className="flex items-center gap-1"
      onMouseDown={stopPropagation}
      onDoubleClick={stopPropagation}
    >
      <Separator orientation="vertical" className="h-4" />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Minimize"
        title="Minimize"
        onClick={() => {
          void win.minimize().catch((error) => {
            console.error("window minimize failed:", error)
            toast.error("Could not minimize the window", {
              id: "window-minimize-failed",
            })
          })
        }}
      >
        <Minus />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Maximize"
        title="Maximize"
        onClick={() => {
          void win.toggleMaximize().catch((error) => {
            console.error("window maximize failed:", error)
            toast.error("Could not resize the window", {
              id: "window-resize-failed",
            })
          })
        }}
      >
        <AppWindow />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Close"
        title="Close"
        onClick={() => {
          void win.close().catch((error) => {
            console.error("window close failed:", error)
            toast.error(`Could not close the window: ${errorMessage(error)}`, {
              id: "window-close-failed",
            })
          })
        }}
      >
        <X />
      </Button>
    </div>
  )
}
