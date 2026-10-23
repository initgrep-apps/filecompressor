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

import { platform as platformPlugin } from "@tauri-apps/plugin-os"

export type Platform = "darwin" | "win32" | "linux" | "unknown"

let warned = false

export function detectPlatform(): Platform {
  try {
    switch (platformPlugin()) {
      case "macos":
        return "darwin"
      case "windows":
        return "win32"
      case "linux":
        return "linux"
      default:
        return "unknown"
    }
  } catch (error) {
    if (!warned) {
      warned = true
      console.warn("platform detection failed", error)
    }
    return "unknown"
  }
}
