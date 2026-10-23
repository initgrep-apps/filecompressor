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

import { createContext, useContext, type ReactNode } from "react"
import type { Platform } from "@/lib/platform"

const PlatformContext = createContext<Platform | null>(null)

export function PlatformProvider({
  platform,
  children,
}: {
  platform: Platform
  children: ReactNode
}) {
  return (
    <PlatformContext.Provider value={platform}>
      {children}
    </PlatformContext.Provider>
  )
}

export function usePlatform(): Platform {
  const platform = useContext(PlatformContext)
  if (platform === null) {
    throw new Error("usePlatform must be used within a PlatformProvider")
  }
  return platform
}
