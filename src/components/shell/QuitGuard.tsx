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

import { useEffect, useRef } from "react"
import { invoke } from "@tauri-apps/api/core"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { confirm } from "@tauri-apps/plugin-dialog"
import { toast } from "sonner"
import { useCompressionContext } from "@/providers/CompressionProvider"

export function QuitGuard() {
  const { isCompressing } = useCompressionContext()
  const isCompressingRef = useRef(isCompressing)
  isCompressingRef.current = isCompressing

  useEffect(() => {
    let quitting = false

    // shortcut: ⌘Q bypasses onCloseRequested and exits directly, acceptable for a deliberate OS quit
    const registered = getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault()
      if (quitting) return

      if (isCompressingRef.current) {
        try {
          const confirmed = await confirm("Compression is still running. Quit anyway?", {
            title: "Quit Yard",
            kind: "warning",
          })
          if (!confirmed || quitting) return
        } catch (error) {
          console.error("quit confirmation failed:", error)
          toast.error("Could not confirm quit — the window stays open.")
          return
        }
      }

      quitting = true
      try {
        await invoke("quit")
      } catch (error) {
        quitting = false
        console.error("quit failed:", error)
        toast.error("Could not quit the app — the window stays open.")
      }
    })

    void registered.catch((error) => {
      console.error("quit guard registration failed:", error)
      toast.error("Close protection is off — save your work before closing.")
    })

    return () => {
      void registered
        .then((stop) => stop())
        .catch((error) => {
          console.error("quit guard cleanup failed:", error)
        })
    }
  }, [])

  return null
}
