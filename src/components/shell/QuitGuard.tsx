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
import type { UnlistenFn } from "@tauri-apps/api/event"
import { confirm } from "@tauri-apps/plugin-dialog"
import { useCompressionContext } from "@/providers/CompressionProvider"

export function QuitGuard() {
  const { isCompressing } = useCompressionContext()
  const isCompressingRef = useRef(isCompressing)
  isCompressingRef.current = isCompressing

  useEffect(() => {
    let unlisten: UnlistenFn | undefined
    let mounted = true

    // shortcut: ⌘Q bypasses onCloseRequested and exits directly, acceptable for a deliberate OS quit
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault()
        if (
          isCompressingRef.current &&
          !(await confirm("Compression is still running. Quit anyway?", {
            title: "Quit Yard",
            kind: "warning",
          }))
        ) {
          return
        }
        await invoke("quit")
      })
      .then((stop) => {
        if (mounted) unlisten = stop
        else stop()
      })

    return () => {
      mounted = false
      unlisten?.()
    }
  }, [])

  return null
}
