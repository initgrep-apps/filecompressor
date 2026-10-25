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

import { cn } from "cn"
import { LoaderCircle } from "lucide-react"

type SpinnerProps = Omit<
  React.ComponentProps<"svg">,
  "children" | "dangerouslySetInnerHTML" | "aria-hidden" | "role"
> & {
  children?: never
  dangerouslySetInnerHTML?: never
  "aria-hidden"?: never
  role?: never
}

function Spinner({ className, ...props }: SpinnerProps) {
  return (
    <LoaderCircle
      className={cn("size-4 animate-spin", className)}
      {...props}
      role={undefined}
      data-slot="spinner"
      aria-hidden="true"
    />
  )
}

export { Spinner }
