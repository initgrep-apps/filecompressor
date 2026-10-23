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
import { RiCloseLine, RiSubtractLine, RiWindowLine } from "@remixicon/react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"

const stopPropagation = (event: MouseEvent) => event.stopPropagation()

export function WindowControls() {
  const win = getCurrentWindow()

  return (
    <div className="flex items-center gap-1">
      <Separator orientation="vertical" className="h-4" />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Minimize"
        title="Minimize"
        onMouseDown={stopPropagation}
        onDoubleClick={stopPropagation}
        onClick={() => void win.minimize()}
      >
        <RiSubtractLine />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Maximize"
        title="Maximize"
        onMouseDown={stopPropagation}
        onDoubleClick={stopPropagation}
        onClick={() => void win.toggleMaximize()}
      >
        <RiWindowLine />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Close"
        title="Close"
        onMouseDown={stopPropagation}
        onDoubleClick={stopPropagation}
        onClick={() => void win.close()}
      >
        <RiCloseLine />
      </Button>
    </div>
  )
}
