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

export function SettingsView() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <h1 className="text-base font-semibold">Settings</h1>
      <p className="text-sm text-muted-foreground">
        Configure compression targets and output folder. This view will be implemented in a later slice.
      </p>
    </div>
  )
}