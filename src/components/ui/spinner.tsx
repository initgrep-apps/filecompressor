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

import { cn } from "cn"
import { RiLoaderLine } from "@remixicon/react"

function Spinner({
  className,
  ...props
}: Omit<React.ComponentProps<"svg">, "children" | "dangerouslySetInnerHTML">) {
  return (
    <RiLoaderLine data-slot="spinner" className={cn("size-4 animate-spin", className)} {...props} aria-hidden="true" />
  )
}

export { Spinner }
