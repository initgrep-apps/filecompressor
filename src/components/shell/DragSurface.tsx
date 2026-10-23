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

import type { ComponentProps } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"

type DragSurfaceProps = Omit<ComponentProps<"div">, "onMouseDown" | "onDoubleClick">

export function DragSurface(props: DragSurfaceProps) {
  return (
    <div
      {...props}
      onMouseDown={(event) => {
        if (event.buttons === 1 && event.detail === 1) {
          void getCurrentWindow()
            .startDragging()
            .catch((error) => console.error("window drag failed:", error))
        }
      }}
      onDoubleClick={() => {
        void getCurrentWindow()
          .toggleMaximize()
          .catch((error) => console.error("window maximize failed:", error))
      }}
    />
  )
}
