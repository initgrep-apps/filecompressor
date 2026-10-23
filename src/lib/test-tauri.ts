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

import { vi } from "vitest"
import type { Platform as OsPlatform } from "@tauri-apps/plugin-os"
import type { Window } from "@tauri-apps/api/window"

export const platformMock = vi.fn<() => OsPlatform>()

export function mockPlatform(value: OsPlatform) {
  platformMock.mockReturnValue(value)
}

export function mockWindow() {
  return {
    startDragging: vi.fn<Window["startDragging"]>(),
    minimize: vi.fn<Window["minimize"]>(),
    toggleMaximize: vi.fn<Window["toggleMaximize"]>(),
    close: vi.fn<Window["close"]>(),
    setTheme: vi.fn<Window["setTheme"]>(),
    onCloseRequested: vi.fn<Window["onCloseRequested"]>(),
  }
}
